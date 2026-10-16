// Client Invoicing's per-client month pipeline (folder roll-ups, matching, reconciliation),
// moved verbatim out of App.jsx so it is a pure function of its inputs: App.jsx builds the
// indexes below with useMemo and calls buildClientsForMonth, and invoicingScope.test.js
// runs the exact same code for an admin and a scoped user. No React or Supabase calls
// (clientsSync/accrualsSync are imported for their pure helpers only).
//
// Scoped users (permissions.js "assigned") run this over the SAME inputs as an admin --
// pginvoice_client_directory() supplies every client, event, cost centre and ledger row --
// and only then filter which cards to show (scopeClientList in clientListFilter.js).
// Hiding inputs instead would re-route fuzzy/prefix folder matches and move totals.
import { findMatch, multiFolderMatchesFor, multiFolderAccrualMatchesFor, dominantClientType, basisToClientType } from "./nameMatch.js";
import { ACCRUALS_LIVE_SYNC_LABEL, endPeriodsFor } from "./accrualsSync.js";
import { typeForMonth, statusForMonth, typeTimelineFor, isBeforeStart } from "./clientsSync.js";
import {
  folderKey, buildFolderCanonicalizer, newFolderEntry, aggregateMonthRows, billableMinutesByFolder,
  reconcileClientMonth, shouldSeedPackageMonth, lifetimeBudgetFor, isLifetimeBudgetType,
  sumMinutesInRange, seedBlockedBy, monthInEndPeriods, priorFolderKeysFor, subProjectType, resolveClientType,
  endedCarryIn, fixedFeeSummary,
} from "./reconcile.js";
import { adelaideMonthKey } from "./dateMath.js";

// ---------------------------- Capacity Planning ----------------------------
// capClients: the cap_clients roster (pginvoice_app_state). Per-group dominant type and
// offboarded state, the group names (fuzzy-match candidates) and the exact folder -> row map.
export function buildCapIndexes(capClients) {
  const byGroup = new Map();
  capClients.forEach((c) => { if (!byGroup.has(c.group)) byGroup.set(c.group, []); byGroup.get(c.group).push(c); });
  const capTypeByGroup = new Map();
  byGroup.forEach((rows, group) => capTypeByGroup.set(group, dominantClientType(rows)));
  // A group is offboarded once every sub-project/row under it is inactive — as long as
  // even one row is still active, the group as a whole is still live. offboardedFrom is
  // the latest of its rows' dates, since that's when the last bit of work actually stopped.
  const capOffboardedByGroup = new Map();
  byGroup.forEach((rows, group) => {
    if (!rows.every((r) => r.status === "inactive")) return;
    const dates = rows.map((r) => r.offboardedFrom).filter(Boolean).sort();
    capOffboardedByGroup.set(group, { offboardedFrom: dates.length ? dates[dates.length - 1] : null, note: rows.find((r) => r.offboardNote)?.offboardNote || "" });
  });
  const capGroupNames = [...capTypeByGroup.keys()];
  // Exact folder-name -> Capacity Planning row, for clients with more than one real
  // ClickUp folder under the same group (e.g. Warrina Homes: a Package folder plus a
  // separate one-off Quoted sub-project folder). resolveClientType's ledger guess only asks "did
  // some accrued-sheet row match this folder's name," so when a sub-project's name is
  // close enough to fuzzy-match the SAME accrued row as the main package, it silently
  // inherited that package's full $ balance/pacing treatment -- two folders both showing
  // the exact same "package 24h, over-used 7.67h" figures as if each were its own
  // independent copy of the same commitment, which is exactly backwards. Capacity
  // Planning's own per-row basis is more precise than the accrued sheet can be here (the
  // accrued sheet only tracks Package-type clients at all), so it wins when they disagree.
  const capRowByClientName = new Map(capClients.map((c) => [folderKey(c.client), c]));
  return { capTypeByGroup, capOffboardedByGroup, capGroupNames, capRowByClientName };
}

// ---------------------------- Clients module ----------------------------
// pgClients: fetchClients()'s shape (or the directory's, see clientDirectory.js).
export function buildPgIndexes(pgClients) {
  const pgClientNames = pgClients.map((p) => p.client);
  // Exact ClickUp-folder -> profile lookup first (the authoritative mapping set via the
  // Clients module's own folder field), falling back to fuzzy name matching only for
  // profiles that haven't had their folder set yet.
  const pgProfileByFolder = new Map();
  // Keyed by folderKey (trimmed, lower-cased) -- ClickUp folder names drift in case and
  // whitespace, and an exact-string key silently missed the registration.
  pgClients.forEach((p) => {
    if (!p.clickupFolder) return;
    const existing = pgProfileByFolder.get(folderKey(p.clickupFolder));
    // More than one Clients-module record can point at the same ClickUp folder
    // (e.g. a since-offboarded sub-engagement that used to share a client's
    // main folder) -- prefer whichever one is still active, so lookups here
    // (type, logo, consultant, …) reflect the client actually using that
    // folder today rather than whichever row happened to sort last.
    if (!existing || (existing.status !== "active" && p.status === "active")) {
      pgProfileByFolder.set(folderKey(p.clickupFolder), p);
    }
  });
  const pgClientByName = new Map(pgClients.map((p) => [p.client, p]));
  return { pgClientNames, pgProfileByFolder, pgClientByName };
}

export const accruedNamesOf = (accrued) => (accrued ? accrued.clients.map((c) => c.name) : []);

// ---------------------------- ClickUp rows ----------------------------
// One display name per folder regardless of case/whitespace drift ("GPEX" vs "gpex", a
// trailing space) -- raw-string keys turned each variant into its own duplicate client
// row. A registered clickup_folder spelling wins; built over every row so all months
// resolve a folder to the same name.
export function buildFolderCanon(clickup, pgClients) {
  return buildFolderCanonicalizer(clickup?.rows || [], pgClients.map((p) => p.clickupFolder).filter(Boolean));
}

// Every raw folder name in the data (all months, every spelling) -- what the prior-month
// accrual-folder resolution matches against (see priorFolderKeysFor).
export const allRawFoldersOf = (clickup) => (clickup ? [...new Set(clickup.rows.map((r) => r.folder))] : []);
// BILLABLE, non-internal minutes per folder (keyed by folderKey) for a given month — used
// to independently re-derive what that month's ending balance would be from current ClickUp
// data, to cross-check against what the accrued sheet already has recorded for it. Always
// billable regardless of the "Billable only" toggle: that toggle is display-only, and the
// accrual math must not move with it. Returns null when the export doesn't cover that
// month at all (nothing to check).
export const monthWorkedFn = (clickup) => (monthKey) => (clickup ? billableMinutesByFolder(clickup.rows, monthKey, clickup.hasBillable) : null);

// Billable minutes per folder (folderKey) per month, across every synced month -- a Quoted
// client's remaining balance is the quoted amount minus everything billed against THAT
// quote (summed from the quote's start month through the viewed month, see
// quotedBudgetFor), since a quoted project runs until its budget is spent rather than
// resetting monthly like a package. Billable-only for the same reason as above.
export function buildWorkedByFolderMonth(clickup) {
  if (!clickup) return new Map();
  const byFolder = new Map();
  for (const r of clickup.rows) {
    if (clickup.hasBillable && !r.billable) continue;
    if (r.isInternal) continue;
    const k = folderKey(r.folder);
    if (!byFolder.has(k)) byFolder.set(k, new Map());
    const m = byFolder.get(k);
    const mk = r.monthKey || "";
    m.set(mk, (m.get(mk) || 0) + r.minutes);
  }
  return byFolder;
}

// Every input buildClientsForMonth reads, built exactly as App.jsx builds them (App.jsx
// memoizes each piece separately). For tests and any other non-React caller.
export function buildInvoicingContext({ clickup, accrued, nameMap = {}, billableOnly, pgClients = [], pgClientEvents = [], capClients = [] }) {
  return {
    clickup, accrued, nameMap, billableOnly, pgClientEvents,
    accruedNames: accruedNamesOf(accrued),
    folderCanon: buildFolderCanon(clickup, pgClients),
    allRawFolders: allRawFoldersOf(clickup),
    computeMonthWorked: monthWorkedFn(clickup),
    workedByFolderMonth: buildWorkedByFolderMonth(clickup),
    ...buildCapIndexes(capClients),
    ...buildPgIndexes(pgClients),
  };
}

// Full per-client reconciliation, parametrized by (monthKey, priorKey) instead of
// reading dataMonthKey/priorMonthKey directly — so the KPI trend row below can call
// this exact same logic for the previous month too, instead of a separate, drift-prone
// copy of the classification/matching pipeline. WITHOUT consultant filter (base data).
// `currentMonthKey` (Adelaide) only decides whether a past month with no ledger row is seeded.
export function buildClientsForMonth(ctx, monthKey, priorKey, { currentMonthKey = adelaideMonthKey() } = {}) {
  const {
    clickup, accrued, accruedNames, nameMap, billableOnly, folderCanon, allRawFolders, computeMonthWorked, workedByFolderMonth,
    capGroupNames, capTypeByGroup, capOffboardedByGroup, capRowByClientName, pgProfileByFolder, pgClientNames, pgClientByName, pgClientEvents,
  } = ctx;
  if (!clickup) return [];
  const monthWorked = computeMonthWorked(priorKey);
  const { canon } = folderCanon;
  // One entry per canonical folder name (case/whitespace variants merged) -- see
  // aggregateMonthRows for the billable vs. displayed-hours split.
  const map = aggregateMonthRows(clickup.rows, { monthKey, billableOnly, hasBillable: clickup.hasBillable, canon });

  // Some clients (Aus3C, Majestic Plumbing, Clarke Energy, Magain, etc.) run real work
  // across several sibling ClickUp folders ("cost centres") instead of one umbrella
  // folder -- Client Accruals and Capacity Planning already merge these via
  // multiFolderAccrualMatchesFor, but until now Client Invoicing showed each sibling
  // folder as its own unrelated top-level row, each independently matching (and each
  // separately claiming) the SAME accrued-sheet package -- e.g. Aus3C's four active
  // folders would all show "package 20h" as if each had its own independent 20h
  // commitment, instead of the four together sharing one.
  // A folder deliberately EXCLUDED from a client's package/accrual math (e.g. Majestic
  // Plumbing's "Quoted Web Project", BAMSS Childcare, Apex Comms Website, Warrina Homes'
  // Employee Guide project -- real client work, billed separately from the retainer) is
  // left completely alone here -- it stays its own normal map entry, which the existing
  // capacity-group sibling nesting below (siblingsByPrimaryName) already renders directly
  // under its cost-centre parent as a "Sub project" row. Only the accrual-eligible
  // folders get folded into one merged row.
  //
  // The candidate list is every REGISTERED client (pgClientNames), not just ones with
  // accrual history (accruedNames) -- accruedNames only covers clients recomputeAccruals
  // has ever written a package/strategy row for, which misses purely-hourly cost-centre
  // clients entirely (Vegetation Solutions, Brisbane Alarm Monitoring, Magain Real
  // Estate's rarer single-folder months, ...). Those clients still need their folders
  // merged for display even though there's no accrual math to run on them.
  const folderNames = [...map.keys()];
  // Every raw spelling seen for each folder, so the exact-name dynamic cost-centre rows
  // still match whichever variant they were registered with; results map back to the
  // canonical name (the `map` key).
  const folderVariantNames = folderNames.flatMap((f) => folderCanon.variantsOf(f));
  const toCanonList = (list) => (list ? [...new Set(list.map(canon))] : list);
  const costCentreCandidates = new Set([...pgClientNames, ...accruedNames]);
  for (const accName of costCentreCandidates) {
    const accrualFolders = toCanonList(multiFolderAccrualMatchesFor(accName, folderVariantNames));
    const matchedInMap = accrualFolders ? accrualFolders.filter((f) => map.has(f)) : [];
    // A hardcoded MULTI_FOLDER_CLIENTS rule's match set always includes the client's own
    // primary folder alongside real siblings; a DYNAMIC client's (pginvoice_cost_centres)
    // does not unless someone remembers to add the primary folder as its own row too --
    // easy to miss, and when missed with at least one real (non-sub-project) sibling
    // present, the primary folder drops out of the roll-up entirely and a sibling gets
    // wrongly promoted to "primary" instead, splitting the client into two conflicting
    // rows (reproduced with Majestic Plumbing + CLT: its own folder's 26.88h vanished
    // from the roll-up, with "MP - Commercial Leak Tech"'s 3.50h standing in as if it
    // were the whole client). Folding the registered clickupFolder in here, whether or
    // not it's an explicit dynamic row, makes this impossible regardless of what the
    // cost-centre table actually contains.
    const ownFolderRaw = pgClientByName.get(accName)?.clickupFolder;
    const ownFolder = ownFolderRaw ? canon(ownFolderRaw) : null;
    if (ownFolder && map.has(ownFolder) && matchedInMap.length > 0 && !matchedInMap.includes(ownFolder)) {
      matchedInMap.push(ownFolder);
    }
    // A registered client whose own folder has ALREADY been claimed and deleted from `map`
    // by an earlier candidate in this same loop (two different client names both matching
    // the same real folder -- e.g. a hardcoded MULTI_FOLDER_CLIENTS rule and a dynamic
    // pginvoice_cost_centres row both covering the same client, exactly what happened with
    // Brisbane Alarm Monitoring/BAMSS Childcare) silently loses that folder to whichever
    // candidate happened to process first, with no signal anywhere that it occurred. Loop
    // order is deterministic (alphabetical, from pgClientNames/accruedNames), so this is a
    // logged-but-not-crashing warning rather than a fix -- fixing it properly means picking
    // a real precedence rule between two DIFFERENT client names claiming the same folder,
    // which is a data-modelling decision, not something safe to guess at silently here.
    if (ownFolder && !map.has(ownFolder) && folderNames.includes(ownFolder)) {
      console.warn(`[buildClientsForMonth] "${accName}"'s own folder "${ownFolder}" was already claimed by another client's cost-centre match this month -- check for a hardcoded MULTI_FOLDER_CLIENTS rule and a dynamic pginvoice_cost_centres row both covering the same folder.`);
    }
    // Folders this same rule matches but deliberately excludes from the accrual (billed
    // separately -- Majestic Plumbing's web project, BAMSS Childcare, Apex Comms Website,
    // Warrina Homes' Employee Guide project) are tagged with their true parent's identity
    // right here, rather than left to the capacity-planning capGroup mechanism to (maybe)
    // catch by name similarity -- that mechanism has its own, unrelated grouping data and
    // has no reason to know these two specific client names are related. Tagged folders
    // are left in `map` untouched (not merged, not deleted) so they still become their
    // own ordinary client row below, just carrying a pointer to their real parent.
    const allFolders = toCanonList(multiFolderMatchesFor(accName, folderVariantNames)) || [];
    for (const f of allFolders) {
      if (matchedInMap.includes(f) || !map.has(f)) continue;
      map.get(f).costCentreParentAccName = accName;
    }
    if (matchedInMap.length < 1) {
      // No accrual-eligible sibling this month -- true for any client whose dynamic
      // cost-centre rows are ALL sub-projects (billed separately, excluded from the
      // accrual by definition -- see multiFolderAccrualMatchesFor), since a dynamic
      // client's own registered clickupFolder is never itself part of its
      // multiFolderMatchesFor/AccrualMatchesFor result (unlike a hardcoded
      // MULTI_FOLDER_CLIENTS prefix rule, whose match set naturally includes the
      // primary folder alongside real siblings). Below, the rest of this branch
      // renames the primary folder's row to `accName` and stamps costCentreAccruedName
      // so a sibling lookup keyed by the client's real name (allSiblingsFor(c.name),
      // and the accrued-sheet match below) still finds this row and its just-tagged
      // sub-project(s) -- without this, the tag above is written but orphaned: the
      // parent row keeps showing under its raw ClickUp folder name, which nothing
      // else in the app is looking up, so the tagged sub-project never renders nested
      // under it (e.g. ARAS's own folder never gets renamed off of "Aged Rights
      // Advocacy Services", so its Website Optimisation Project sub-project silently
      // has nowhere to attach).
      // Only the folder's owner per pgProfileByFolder (the active record, when more than
      // one points at the same folder) may claim it -- otherwise the last name in this
      // loop wins, which is how offboarded "Comunet (HTSA  project)" took over the live
      // Comunet row, hiding its logo and blanking its package.
      const folderOwner = ownFolderRaw ? pgProfileByFolder.get(folderKey(ownFolderRaw))?.client : null;
      if (ownFolder && map.has(ownFolder) && !map.get(ownFolder).costCentreParentAccName && folderOwner === accName) {
        const entry = map.get(ownFolder);
        entry.name = accName;
        entry.costCentreAccruedName = accName;
      }
      continue;
    }
    // The client's own registered ClickUp folder (set in the Clients module) is the
    // right "identity" folder for this roll-up when it actually logged hours this month
    // -- picking whichever sibling folder happens to have logged the most hours instead
    // used to promote essentially arbitrary folders (e.g. "Aus3C IRAP", or Magain's
    // busiest agent folder that month) to stand in for the whole client, with the real
    // parent ("Australian Cyber Collaboration Centre") demoted to just another line
    // item -- backwards from what the roll-up is meant to show. Vegetation Solutions and
    // Magain have no umbrella folder of their own at all (hasDirectFolder stays false),
    // so every line item below is labelled with its own real folder name instead.
    const hasDirectFolder = !!(ownFolder && matchedInMap.includes(ownFolder));
    let primary = hasDirectFolder ? ownFolder : matchedInMap[0];
    if (!hasDirectFolder) {
      for (const f of matchedInMap) if (map.get(f).totalMin > map.get(primary).totalMin) primary = f;
    }
    const primaryEntry = map.get(primary);
    // The primary folder's own hours, captured before any sibling gets merged in --
    // labelled with the client's real name only when it's genuinely the registered
    // umbrella folder; otherwise it's just another sibling folder and gets its own name.
    // `tasksByUser` is a snapshot of THIS folder's own tasks (pre-merge) -- kept so the
    // drawer's task list can show a rolled-up client's tasks grouped by which real
    // ClickUp folder they came from, instead of one flat merged list with no way to
    // tell a BAMSS Childcare task from a Brisbane Alarm Monitoring one.
    // Cloned (not a reference) -- primaryEntry.tasksByUser itself gets mutated below as
    // siblings merge into it, and a sibling's own map would otherwise get merged into a
    // shared object too if any two folders happened to share a reference.
    const cloneTasksByUser = (m) => new Map([...m].map(([u, t]) => [u, new Map(t)]));
    // `hours` follows the Billable-only toggle (display); `billableHours` never does --
    // it's what a per-cost-centre invoice is billed from (see invoiceSplit.js).
    const lineItems = [{ name: hasDirectFolder ? accName : primary, hours: primaryEntry.totalMin / 60, billableHours: primaryEntry.billableMin / 60, tasksByUser: cloneTasksByUser(primaryEntry.tasksByUser) }];
    for (const f of matchedInMap) {
      if (f === primary) continue;
      const entry = map.get(f);
      lineItems.push({ name: f, hours: entry.totalMin / 60, billableHours: entry.billableMin / 60, tasksByUser: cloneTasksByUser(entry.tasksByUser) });
      primaryEntry.totalMin += entry.totalMin;
      primaryEntry.billableMin += entry.billableMin;
      for (const [task, min] of entry.tasksAll) primaryEntry.tasksAll.set(task, (primaryEntry.tasksAll.get(task) || 0) + min);
      for (const [u, min] of entry.userMinutes) primaryEntry.userMinutes.set(u, (primaryEntry.userMinutes.get(u) || 0) + min);
      for (const [u, tm] of entry.tasksByUser) {
        if (!primaryEntry.tasksByUser.has(u)) primaryEntry.tasksByUser.set(u, new Map());
        const t = primaryEntry.tasksByUser.get(u);
        for (const [task, min] of tm) t.set(task, (t.get(task) || 0) + min);
      }
      for (const [task, tu] of entry.taskUsers) {
        if (!primaryEntry.taskUsers.has(task)) primaryEntry.taskUsers.set(task, new Map());
        const t = primaryEntry.taskUsers.get(task);
        for (const [u, min] of tu) t.set(u, (t.get(u) || 0) + min);
      }
      for (const [task, ids] of entry.taskIds) {
        if (!primaryEntry.taskIds.has(task)) primaryEntry.taskIds.set(task, new Set());
        for (const id of ids) primaryEntry.taskIds.get(task).add(id);
      }
      map.delete(f);
    }
    lineItems.sort((a, b) => b.hours - a.hours);
    // Only worth a "Rolled Up" breakdown when there's an actual sibling folder to show
    // alongside the parent's own -- a client whose only accrual-eligible "match" is its
    // own registered umbrella folder (e.g. Brisbane Alarm Monitoring or Warrina Homes,
    // once their one real sibling is excluded as a billed-separately sub-project) would
    // otherwise show a roll-up panel containing nothing but itself.
    const isTrivialRollup = hasDirectFolder && lineItems.length === 1;
    if (!isTrivialRollup) {
      primaryEntry.costCentre = {
        lineItems, totalWorked: primaryEntry.totalMin / 60,
        accrualFolderNames: matchedInMap,
      };
    }
    // The merged entry's true identity is the accrued client itself, not whichever raw
    // ClickUp folder ended up "primary" -- e.g. Magain Real Estate's busiest folder is
    // literally named "Magain Sales", nothing like the client's own name, so leaving
    // c.name as that folder name would make the accrued-sheet match below fail or
    // misfire. We already know the identity here, so stamp it directly instead of
    // making the per-client loop re-derive it via fuzzy matching.
    primaryEntry.name = accName;
    primaryEntry.costCentreAccruedName = accName;
  }

  // Only a manually uploaded workbook (no per-month agreed hours at all) may fall back to
  // the client-level `package` scalar -- on live data it's a stale last-write-wins value.
  const allowScalarPackage = !!accrued && accrued.fileName !== ACCRUALS_LIVE_SYNC_LABEL;
  const nameMapByKey = new Map(Object.entries(nameMap).map(([k, v]) => [folderKey(k), v]));
  const resolveProfile = (c) => (c.seeded ? pgClientByName.get(c.name) || null : null) || pgProfileByFolder.get(folderKey(c.name)) || pgClientByName.get(c.name) || (() => {
    const m = findMatch(c.name, pgClientNames);
    return m ? pgClientByName.get(m.name) : null;
  })();

  const buildClientObj = (c) => {
    // `worked` follows the "Billable only" toggle (display only); `billableWorked` never
    // does and is what every balance/remaining/mismatch/export figure is computed from.
    const worked = c.totalMin / 60;
    const billableWorked = c.billableMin / 60;
    let accruedClient = null;
    let matchInfo = null;
    const manualMatch = nameMap[c.name] ?? nameMapByKey.get(folderKey(c.name));
    if (accrued) {
      if (c.costCentreAccruedName) {
        accruedClient = accrued.clients.find((a) => a.name === c.costCentreAccruedName) || null;
        if (accruedClient) matchInfo = { name: accruedClient.name, confidence: 1, method: "cost-centre" };
      } else if (manualMatch) {
        accruedClient = accrued.clients.find((a) => a.name === manualMatch) || null;
        if (accruedClient) matchInfo = { name: accruedClient.name, confidence: 1, method: "manual" };
      } else if (pgProfileByFolder.get(folderKey(c.name))) {
        // The Clients module's own registered clickup_folder -> profile mapping is
        // authoritative (same reasoning as recomputeAccruals in accrualsSync.js) --
        // prefer it over re-deriving a match from c.name's raw ClickUp folder string.
        // Without this, a client whose real folder doesn't fuzzy-match its own accrued-
        // table name (e.g. "Coonwarra" vs. folder "Coonawarra Grape and Wine Inc", or
        // "PRG Strategic Advisors" vs. folder "PRG Financial Services Outsourced
        // Marketing") shows up correctly typed as Package but with no package figure at
        // all -- worked hours real, pkg permanently null, "No package on file".
        const profileName = pgProfileByFolder.get(folderKey(c.name)).client;
        accruedClient = accrued.clients.find((a) => a.name === profileName) || null;
        if (accruedClient) matchInfo = { name: accruedClient.name, confidence: 1, method: "client-folder" };
      } else if (!c.costCentreParentAccName) {
        // A row already tagged as another client's sub-project (see costCentreParentAccName
        // above) must NEVER fall through to fuzzy name matching -- its folder name often
        // shares words with its own parent's name by construction (e.g. "ARAS Website
        // Optimisation Project" vs. accrued client "ARAS"), so findMatch would confidently
        // "match" it to the parent (or some unrelated client) and silently overwrite its
        // displayName with the parent's -- exactly the bug that made ARAS's sub-project
        // display as plain "ARAS" instead of its own name. A sub-project keeps showing
        // under its own real folder name unless it has its own EXPLICIT registration
        // (pgProfileByFolder above), which is a name collision fuzzy matching can't cause.
        const m = findMatch(c.name, accruedNames);
        if (m) { accruedClient = accrued.clients.find((a) => a.name === m.name) || null; matchInfo = m; }
      }
    }
    // The Clients module knows what this client was actually billing as (and whether it
    // was on hold) for a given month -- typeForMonth/statusForMonth replay its scheduled
    // events. Needed for both the viewed month and the prior one: the package math below
    // must not run for a month off package, and an on-hold month consumes no package.
    // A sub-project only ever uses its OWN registration -- fuzzy matching its folder name
    // ("Majestic Plumbing Quoted Web Project (WA)") lands on the parent's profile and
    // inherited the parent's package type.
    const isSubProject = !!c.costCentreParentAccName;
    const ownProfile = pgProfileByFolder.get(folderKey(c.name)) || pgClientByName.get(c.name) || null;
    const pgProfile = isSubProject ? ownProfile : resolveProfile(c);
    // Before the client's start date there's no package at all -- typeForMonth would
    // otherwise report the profile's base type for every earlier month, so a client
    // onboarded in September showed in July with a phantom package and an estimated
    // "carry" from June. Time logged before the start month bills as hourly, and the
    // start month itself carries nothing in (its prior month is pre-start).
    const preStart = (k) => pgProfile && isBeforeStart(pgProfile, k) ? { type: "hourly", agreedHours: null } : null;
    const seg = pgProfile && monthKey ? (preStart(monthKey) || typeForMonth(pgProfile, pgClientEvents, monthKey)) : null;
    const priorSeg = pgProfile && priorKey ? (preStart(priorKey) || typeForMonth(pgProfile, pgClientEvents, priorKey)) : null;
    // This exact folder's own Capacity Planning row (not a fuzzy group match), see below.
    const capRow = capRowByClientName.get(folderKey(c.name));
    const capType = capRow ? basisToClientType(capRow.basis) : null;
    // A sub-project is never package-like (see subProjectType), in the viewed month and the
    // prior one alike, so no package/carry math ever runs on it.
    const monthType = isSubProject ? subProjectType(c.name, { profileType: seg?.type, capType }) : (seg?.type ?? null);
    const priorType = isSubProject ? subProjectType(c.name, { profileType: priorSeg?.type, capType }) : (priorSeg?.type ?? null);
    // monthWorked is keyed by folderKey, one entry per real folder -- a cost-centre
    // client's identity (c.name) is the accrued client name, not a real folder, so sum
    // across every folder this client's roll-up actually draws from instead.
    // A seeded or renamed row's c.name is the client/ledger name, not a folder, so resolve
    // the client's real accrual folders (see priorFolderKeysFor).
    const ledgerName = c.costCentreAccruedName ?? accruedClient?.name ?? null;
    const priorKeys = accruedClient ? priorFolderKeysFor({
      name: c.name,
      costCentreFolders: c.costCentre?.accrualFolderNames,
      clientName: ledgerName,
      ownFolder: (ledgerName && pgClientByName.get(ledgerName)?.clickupFolder) || null,
      isSubProject: !!c.costCentreParentAccName,
      allFolders: allRawFolders,
      accrualMatchesFor: multiFolderAccrualMatchesFor,
    }) : [folderKey(c.name)];
    const priorMonthWorkedMin = priorKeys.reduce((a, k) => a + (monthWorked?.get(k) || 0), 0);
    // An offboarded/archived stretch accrues nothing (recomputeAccruals' end periods), so
    // a prior month inside one carries nothing -- never an estimate from the old package.
    const endPeriods = pgProfile && accruedClient && !isSubProject ? endPeriodsFor(pgProfile, pgClientEvents) : [];
    const priorEnded = !!(priorKey && endPeriods.length) && monthInEndPeriods(
      endPeriods, priorKey,
      { hasEvidence: accruedClient.balances?.[priorKey] != null || priorMonthWorkedMin > 0 },
    );
    // The viewed month itself inside an end period: the balance carried into it, read back
    // from the ledger's carry-outs, decides whether it's a wrap-up drawdown of owed hours
    // (see endedCarryIn / reconcileClientMonth). Evidence mirrors the ledger's own: worked
    // hours or a reset keep an undated end from covering the month.
    const monthEnded = !!(monthKey && endPeriods.length) && monthInEndPeriods(
      endPeriods, monthKey,
      { hasEvidence: billableWorked > 0 || accruedClient.resets?.[monthKey] != null },
    );
    const wrapUpPrior = monthEnded
      ? endedCarryIn(accruedClient, priorKey, (k) => monthInEndPeriods(endPeriods, k, { hasEvidence: accruedClient.balances?.[k] != null }))
      : null;
    const recon = reconcileClientMonth({
      worked: billableWorked, accruedClient, monthKey, priorKey,
      priorWorkedH: monthWorked ? priorMonthWorkedMin / 60 : null,
      monthType,
      priorType,
      monthStatus: pgProfile && monthKey ? statusForMonth(pgProfile, pgClientEvents, monthKey) : null,
      priorStatus: pgProfile && priorKey ? statusForMonth(pgProfile, pgClientEvents, priorKey) : null,
      monthSegmentAgreed: seg?.agreedHours ?? null,
      allowScalarPackage,
      priorEnded,
      wrapUpPrior,
    });
    const clientObj = {
      ...c, worked, billableWorked, accruedClient, matchInfo,
      ...recon,
      matched: !!accruedClient,
      // Has its own Clients-module registration (exact folder/name, never a fuzzy match) --
      // used to pick a capGroup's primary row (computePrimaryNameByGroup).
      registered: !!ownProfile,
      // The Clients-module client this row's profile resolved to (scoped views match it
      // against the user's assigned clients, see scopeClientList).
      profileClient: pgProfile?.client ?? null,
      displayName: accruedClient?.name ?? c.name,
      costCentre: c.costCentre || null,
    };
    // The month's type from the Clients module always wins over the accrued-workbook guess
    // ("matched an accrued row with a package figure, so it must be a package"), since a
    // temporary transition (e.g. GPEx briefly moving to hourly for a couple of months
    // before reverting to its package) has no way to be reflected in that static,
    // upload-only guess otherwise; the guess only applies to a client not yet registered.
    //
    // Capacity Planning's row for this exact folder may then demote a package-like guess --
    // a sub-project folder that only fuzzy-matched the MAIN package's accrued-sheet row by
    // name coincidence. When Capacity Planning already knows this specific folder is
    // really Quoted/Hourly/etc, that overrides the false "package" guess, instead of two
    // folders both showing an identical "package 24h, over-used 7.67h" as if each
    // independently owned the same commitment. It never promotes, so a fixed-price type
    // (digital, map) can't be turned back into a package.
    const resolved = resolveClientType({ name: c.name, matched: clientObj.matched, pkg: clientObj.pkg, monthType, capType });
    clientObj.type = resolved.type;
    if (resolved.demoted) clientObj.packageOverriddenBy = capRow.basis;
    if (seg?.type) {
      // Only worth flagging as a transition when it actually changed something from
      // the client's normal baseline — otherwise every already-registered client would
      // show a "scheduled" badge for no reason.
      clientObj.typeTransitioned = seg.type !== pgProfile.baseType;
      clientObj.typeTransitionNote = seg.note;
    }
    // Quoted / MAP: a single fixed hour budget for the whole engagement, not a monthly one
    // (a MAP is quoted at a fixed total too, e.g. 80 h) -- "remaining" is the budget minus
    // every billable hour logged against it from the engagement's own start month (the
    // start of its quoted/map segment in the type timeline) through the month being
    // viewed. Counting every synced month instead charged a new quote with hours from
    // earlier, unrelated engagements (and later months' hours when viewing an older month).
    // The quotedAmount/quotedRemaining field names are shared by both types.
    if (isLifetimeBudgetType(clientObj.type)) {
      // c.name may already have been renamed to the accrued/registered client's display
      // name by the cost-centre merge loop above (e.g. "ARAS", "PRG Strategic Advisors"),
      // so the registered clickupFolder is the right key; c.name is only a safe fallback
      // for a client with no registration at all.
      const quotedFolders = c.costCentre ? c.costCentre.accrualFolderNames : [pgProfile?.clickupFolder || c.name];
      const budgetFor = (opts) => (pgProfile && monthKey
        ? lifetimeBudgetFor(typeTimelineFor(pgProfile, pgClientEvents), monthKey, {
          type: clientObj.type, currentAgreedHours: pgProfile.agreedHours,
          // A MAP that is the client's base type starts at its profile start date (Quoted
          // keeps its existing open-ended behaviour for a base-type quote).
          startDate: clientObj.type === "map" ? pgProfile.startDate : null,
          ...opts,
        })
        : null);
      let budget = budgetFor();
      // A fixed-fee quote with no hour budget (AWIWA: $10,000 one-off project) counts its
      // hours from its own type event, not from an earlier hour-based quote before it.
      const feeOnly = pgProfile?.fixedFee != null && (budget ? budget.amount : pgProfile.agreedHours) == null;
      if (feeOnly && budget) budget = budgetFor({ segmentOnly: true });
      const fromMonth = budget?.fromMonth ?? null;
      const lifetimeWorkedMin = quotedFolders.reduce((a, f) => a + sumMinutesInRange(workedByFolderMonth.get(folderKey(f)), fromMonth, monthKey || null), 0);
      clientObj.lifetimeWorked = lifetimeWorkedMin / 60;
      clientObj.quotedAmount = budget ? budget.amount : (pgProfile?.agreedHours ?? null);
      clientObj.quotedRemaining = clientObj.quotedAmount != null ? clientObj.quotedAmount - clientObj.lifetimeWorked : null;
      // Display-only dollar fee + effective rate (fee / lifetime billable hours).
      clientObj.fixedFee = fixedFeeSummary(pgProfile?.fixedFee, clientObj.lifetimeWorked);
    }
    if (capRow) clientObj.capGroup = capRow.group;
    // Every ClickUp folder behind this row, for the list search (filterClientList): a row
    // renamed to its client's name ("ARAS") is otherwise unfindable by its real folder
    // ("Aged Rights Advocacy Services"), and a roll-up by its cost-centre folders.
    clientObj.searchFolders = [...new Set([
      c.folder, pgProfile?.clickupFolder,
      ...(c.costCentre?.accrualFolderNames || []), ...(c.costCentre?.lineItems || []).map((i) => i.name),
    ].filter(Boolean))];
    // Client Invoicing has no independent way to know a client is on a Marketing
    // Action Plan (MAP) — that's tracked only in Capacity Planning's "basis" field.
    // Cross-reference it here by name, purely additively: c.type (which the
    // package/hourly/Queensland UI below is built around, including the real
    // accrued-balance tracking) is left exactly as resolveClientType() already
    // determines it, so a MAP client that's also tracked with a package-style
    // accrual keeps that UI. isMap just layers a separate "MAP" filter option and
    // an inline tag on top, visible regardless of which type bucket a client
    // otherwise falls into. Reads live capacity data, so a client moving off MAP
    // is reflected here automatically next time this recomputes.
    const capMatch = findMatch(c.name, capGroupNames);
    clientObj.isMap = capMatch ? capTypeByGroup.get(capMatch.name) === "map" : false;
    const offboarded = capMatch ? capOffboardedByGroup.get(capMatch.name) : null;
    clientObj.isOffboarded = !!offboarded && (!monthKey || !offboarded.offboardedFrom || monthKey >= offboarded.offboardedFrom);
    clientObj.offboardNote = offboarded?.note || "";
    if (!clientObj.capGroup && capMatch) clientObj.capGroup = capMatch.name;
    // Logo set in the Clients module (uploaded, or auto-fetched from the client's
    // website favicon) — purely cosmetic, falls back to initials when absent.
    clientObj.logoUrl = pgProfile?.logoUrl || null;
    return clientObj;
  };

  const out = [...map.values()].map(buildClientObj);
  // A package-like month consumes (or banks) the package whether or not anyone logged
  // billable time -- but `map` only has folders with ClickUp rows, so a package client
  // with 0 hours (or only non-billable hours with Billable only on) used to vanish from
  // the list, the KPIs, the Pending-hours export and the last-month accrued export.
  // Seed a zero-hour row for every such accrued client not already represented.
  // Seeded rows are tagged `seeded` and never count as "taken" for manual matching.
  if (accrued && monthKey) {
    const matchedLedgerNames = new Set(out.filter((x) => x.accruedClient).map((x) => x.accruedClient.name));
    const takenNames = new Set(out.map((x) => folderKey(x.name)));
    const monthFolderKeys = new Set(folderNames.map(folderKey)); // pre-merge: every folder with rows this month
    for (const a of accrued.clients) {
      if (takenNames.has(folderKey(a.name))) continue;
      const profile = pgClientByName.get(a.name);
      if (profile && isBeforeStart(profile, monthKey)) continue; // not a client yet that month
      const ownFolder = profile?.clickupFolder || null;
      if (seedBlockedBy({
        ledgerName: a.name, matchedLedgerNames, ownFolder, monthFolderKeys,
        clientFolders: multiFolderMatchesFor(a.name, folderVariantNames, ownFolder || undefined),
      })) continue;
      const seg = profile ? typeForMonth(profile, pgClientEvents, monthKey) : null;
      if (!shouldSeedPackageMonth(a, monthKey, seg?.type ?? null, seg?.agreedHours ?? null, {
        monthStatus: profile ? statusForMonth(profile, pgClientEvents, monthKey) : null,
        currentMonthKey,
      })) continue;
      if (profile && monthInEndPeriods(endPeriodsFor(profile, pgClientEvents), monthKey)) continue;
      const seededObj = buildClientObj({ ...newFolderEntry(a.name), costCentreAccruedName: a.name, seeded: true });
      // Offboarded in Capacity Planning for this month (e.g. Adelaide Direct Stationers,
      // offboarded Aug 2025, still carrying agreed hours in the ledger): nobody worked, so
      // a phantom 0h row would only show a package it no longer has.
      if (seededObj.isOffboarded) continue;
      out.push(seededObj);
    }
  }
  return out;
}
