// Client roster: current type/consultant/status plus an append-only event log for
// scheduled transitions (type change, consultant change, offboarding). Events carry
// an effective date; applyDueEvents() rolls forward any that have arrived, and
// agreedHoursForMonth()/typeForMonth() replay the type-change history so accrual
// math stays correct across a client's package changing mid-year.
import { supabase } from "./supabaseClient.js";
import { PG_DATA_EVENT } from "./idbStore.js";
import { PG_CLIENTS_KEY, PG_COST_CENTRES_KEY } from "./storageKeys.js";
import { CLIENT_TYPE_LABELS } from "./nameMatch.js";

// Every module (Clients, Capacity Planning) that reads pginvoice_clients stays mounted for
// the whole session rather than remounting on tab switch, so a change made in one won't be
// picked up by the other without an explicit signal -- broadcast the same event the rest of
// the app already uses for cross-module refresh whenever this table changes.
function notifyClientsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PG_DATA_EVENT, { detail: { key: PG_CLIENTS_KEY } }));
}
function notifyCostCentresChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PG_DATA_EVENT, { detail: { key: PG_COST_CENTRES_KEY } }));
}

// Every mutation below writes one row to pginvoice_client_history so the drawer's
// History section can show a single chronological "who changed what, when" feed
// across transitions, consultant updates, folder edits, cost-centre changes, and
// notes -- rather than each kind of change living in its own untracked place (as
// folder edits and cost-centre add/remove did before this table existed).
async function logClientHistory(client, action, summary, detail) {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.from("pginvoice_client_history").insert({
    client, action, actor_email: userData?.user?.email || null, actor_user_id: userData?.user?.id || null,
    detail: { summary, ...(detail || {}) },
  });
  // Best-effort -- a history-logging failure shouldn't roll back or block the
  // actual change it's describing (which has already committed by the time this
  // runs in every caller below).
  if (error) console.error("Couldn't log client history:", error);
}

export async function fetchClientHistory(client) {
  const { data, error } = await supabase.from("pginvoice_client_history").select("*").eq("client", client).order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// The user-editable cost-centre/sub-project links (pginvoice_cost_centres) -- Shell.jsx
// fetches this once at the top level (every page is mounted simultaneously, just hidden via
// CSS, see Shell.jsx's `display: active === ... ? "block" : "none"` pattern) and feeds it into
// nameMatch.js's setDynamicCostCentres, so multiFolderMatchesFor/multiFolderAccrualMatchesFor
// pick it up everywhere without each caller needing its own fetch.
export async function fetchCostCentres() {
  const { data, error } = await supabase.from("pginvoice_cost_centres").select("*").order("client", { ascending: true });
  if (error) throw error;
  return data || [];
}

// `kind`: "cost_centre" (counts toward the parent's package accrual) or "sub_project"
// (billed separately, excluded from the accrual but still shown rolled up under the parent).
export async function addCostCentreFolder(client, folder, kind) {
  const { error } = await supabase.from("pginvoice_cost_centres").insert({ client, folder, kind });
  if (error) throw error;
  notifyCostCentresChanged();
  const label = kind === "sub_project" ? "sub-project" : "cost centre";
  logClientHistory(client, "cost_centre_add", `Added ${label}: ${folder}`, { folder, kind });
}

// A "task-prefix" cost centre: `sourceFolder` is the real, shared ClickUp folder these
// tasks live in; `syntheticFolder` is the identity this cost centre gets everywhere else
// in the app (see splitTaskPrefixFolders in nameMatch.js) -- conventionally the same name
// the old separate-folder era used for it (e.g. "Aus3C IRAP"), so nothing downstream needs
// to know this client changed how it tracks time in ClickUp.
export async function addTaskPrefixCostCentre(client, sourceFolder, taskPrefix, syntheticFolder) {
  const { error } = await supabase.from("pginvoice_cost_centres").insert({
    client, folder: syntheticFolder, kind: "task_prefix", source_folder: sourceFolder, task_prefix: taskPrefix,
  });
  if (error) throw error;
  notifyCostCentresChanged();
  logClientHistory(client, "cost_centre_add", `Added task-prefix cost centre: "${taskPrefix}" in ${sourceFolder} → ${syntheticFolder}`, { sourceFolder, taskPrefix, syntheticFolder });
}

export async function removeCostCentreFolder(client, folder, kind) {
  const { error } = await supabase.from("pginvoice_cost_centres").delete().eq("client", client).eq("folder", folder);
  if (error) throw error;
  notifyCostCentresChanged();
  const label = kind === "sub_project" ? "sub-project" : "cost centre";
  logClientHistory(client, "cost_centre_remove", `Removed ${label}: ${folder}`, { folder, kind });
}

export async function fetchClients() {
  const { data, error } = await supabase.from("pginvoice_clients").select("*").order("client", { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToClient);
}

function rowToClient(r) {
  return {
    client: r.client,
    type: r.type,
    agreedHours: r.agreed_hours === null ? null : Number(r.agreed_hours),
    // Immutable snapshot of type/hours as first recorded — applyDueClientEvents only ever
    // updates `type`/`agreedHours` above, never these, so historical months from before any
    // transition can still be reconstructed correctly (see typeTimelineFor).
    baseType: r.base_type,
    baseAgreedHours: r.base_agreed_hours === null ? null : Number(r.base_agreed_hours),
    // One-off fixed fee in AUD for a quoted (or MAP) engagement priced in dollars rather
    // than hours (e.g. AWIWA, $10,000) -- display-only, never part of any hours/accrual math.
    fixedFee: r.fixed_fee == null ? null : Number(r.fixed_fee),
    consultant: r.consultant || null,
    startDate: r.start_date || null,
    endDate: r.end_date || null,
    status: r.status,
    clickupFolder: r.clickup_folder || null,
    website: r.website || null,
    // Either a manually uploaded image (resized to a small JPEG data URL, same
    // pattern as consultant photos in avatar.jsx) or an auto-fetched favicon URL
    // from the client's website — either way, just a URL the row/drawer can drop
    // straight into an <img>.
    logoUrl: r.logo_url || null,
  };
}

// The ClickUp folder name this client's real hours are logged under -- not part of the
// scheduled-event lifecycle (type/consultant/offboarding), just editable metadata, so it's
// a direct update rather than an event.
export async function updateClickupFolder(client, folder, { previousFolder } = {}) {
  const { error } = await supabase.from("pginvoice_clients").update({ clickup_folder: folder || null }).eq("client", client);
  if (error) throw error;
  notifyClientsChanged();
  const summary = folder ? `Set ClickUp folder to "${folder}"` : "Cleared ClickUp folder";
  logClientHistory(client, "folder_change", summary, { from: previousFolder || null, to: folder || null });
}

// A quoted client's amount is normally set once and only occasionally revised -- unlike
// a Package's monthly hours, which genuinely change over time and are worth a dated,
// historical "Transitioning" event, a quoted figure is just editable metadata (same
// reasoning as updateClickupFolder above), so it's a direct update instead of forcing a
// same-type-to-same-type transition event just to change one number. Only ever called for
// a client whose type is already "quoted" -- Package/Strategy's agreed hours still go
// through the event/transition flow so their history stays replayable month to month.
export async function updateQuotedAmount(client, hours, { previousHours } = {}) {
  const { error } = await supabase.from("pginvoice_clients").update({ agreed_hours: hours }).eq("client", client);
  if (error) throw error;
  notifyClientsChanged();
  logClientHistory(client, "quoted_amount_change", `Set quoted amount to ${hours} hrs`, { from: previousHours ?? null, to: hours });
}

// Same direct-edit pattern as updateQuotedAmount, for a quote priced as a fixed dollar fee
// (pginvoice_clients.fixed_fee, AUD). null clears it.
export async function updateFixedFee(client, fee, { previousFee } = {}) {
  const { error } = await supabase.from("pginvoice_clients").update({ fixed_fee: fee }).eq("client", client);
  if (error) throw error;
  notifyClientsChanged();
  logClientHistory(client, "fixed_fee_change", fee == null ? "Cleared fixed fee" : `Set fixed fee to $${fee}`, { from: previousFee ?? null, to: fee });
}

// Saves the client's website URL and, when `autoLogo` is true, derives a logo
// from it via a public favicon service rather than scraping the site ourselves
// (no server-side fetch/CORS/edge-function needed for a small icon). Passing an
// explicit `logoUrl` (e.g. from a manual upload) skips the auto-fetch entirely.
//
// This is the single source of truth for what the logo becomes when the website is
// saved -- callers should NOT separately recompute `faviconUrlFor(website)` and patch
// their own local state with it, since that duplicated derivation is what let clearing
// the website (website === "") leave a stale `logo_url` in the DB while the UI showed
// no logo. Pass `currentLogoUrl` (the client's logo before this save) so a manually
// uploaded logo -- a `data:` URL, see resizePhotoFile in avatar.jsx -- isn't silently
// clobbered by an auto-fetched favicon just because the website field was re-saved for
// an unrelated reason; a favicon URL always starts with the Google favicon endpoint (see
// faviconUrlFor below), so that's how we tell "auto" and "manual" logos apart without a
// schema change. Returns the patch that was actually applied to the DB (`{ website }` or
// `{ website, logoUrl }`) so the caller can apply the exact same values to local UI state
// instead of re-deriving them.
export async function updateClientWebsite(client, website, { autoLogo = true, logoUrl, currentLogoUrl } = {}) {
  const trimmedWebsite = website || null;
  const patch = { website: trimmedWebsite };
  if (logoUrl !== undefined) {
    patch.logo_url = logoUrl || null;
  } else if (autoLogo) {
    const isManualUpload = !!currentLogoUrl && currentLogoUrl.startsWith("data:");
    if (!isManualUpload) {
      // Explicitly clears logo_url (to null) when the website is cleared, rather than
      // leaving a stale favicon in the DB that reappears on the next reload.
      patch.logo_url = trimmedWebsite ? faviconUrlFor(trimmedWebsite) : null;
    }
  }
  const { error } = await supabase.from("pginvoice_clients").update(patch).eq("client", client);
  if (error) throw error;
  notifyClientsChanged();
  const applied = { website: patch.website };
  if ("logo_url" in patch) applied.logoUrl = patch.logo_url;
  return applied;
}

export async function updateClientLogo(client, logoUrl) {
  const { error } = await supabase.from("pginvoice_clients").update({ logo_url: logoUrl || null }).eq("client", client);
  if (error) throw error;
  notifyClientsChanged();
}

// Google's public favicon service -- no API key, no CORS issues, and it already
// resolves redirects/subdomains for us. Good enough for a small logo chip; a
// client that wants their exact brand mark can still upload one manually.
export function faviconUrlFor(website) {
  if (!website) return null;
  let host = website.trim();
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`;
  try {
    const { hostname } = new URL(host);
    return `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(hostname)}`;
  } catch {
    return null;
  }
}

// New client, created from either Capacity Planning or the Clients module -- both write
// to this same table, so a client added in one place shows up in the other immediately.
// Which types store an agreed-hours figure at all (NOT which accrue -- that's format.js's
// isPackageLikeType, package/strategy only). Strategy is an ongoing engagement with agreed
// recurring hours -- the same fixed-hours accrual shape as Package. Quoted reuses the same
// column as a single lifetime budget instead of a monthly one (see the quotedAmount/
// quotedRemaining computation in App.jsx's buildClientsForMonth). MAP stores its monthly MAP
// hours for reference only. Digital is a fixed-price package with no hours at all.
export const storesAgreedHours = (type) => type === "package" || type === "strategy" || type === "quoted" || type === "map";

export function newClientRow(client, { type, agreedHours, consultant, startDate, clickupFolder }) {
  const hours = storesAgreedHours(type) ? (agreedHours ?? null) : null;
  return {
    client, type, agreed_hours: hours,
    base_type: type, base_agreed_hours: hours,
    consultant: consultant || null, start_date: startDate || null, status: "active",
    clickup_folder: clickupFolder || null,
  };
}

// Validates the Clients module's "Add client" form against the current roster. Returns
// `{ error }` or `{ name, fields }` ready for createClient. Hours are required for the
// recurring-hours types (package/strategy/map) and optional for quoted (the quote can be
// set later via updateQuotedAmount); ignored for every other type.
export function validateNewClient(form, existingClients) {
  const name = String(form.name || "").trim();
  if (!name) return { error: "Enter a client name." };
  const lower = name.toLowerCase();
  const dup = (existingClients || []).find((c) => String(c.client || "").trim().toLowerCase() === lower);
  if (dup) return { error: `A client named "${dup.client}" already exists.` };
  const type = form.type;
  let agreedHours = null;
  if (storesAgreedHours(type)) {
    const raw = String(form.hours ?? "").trim();
    if (raw === "") {
      if (type !== "quoted") return { error: "Enter the agreed hours for this client (or choose a different type)." };
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return { error: "Enter a valid number of hours." };
      agreedHours = n;
    }
  }
  return {
    name,
    fields: {
      type, agreedHours,
      consultant: String(form.consultant || "").trim() || null,
      clickupFolder: String(form.clickupFolder || "").trim() || null,
      startDate: form.startDate || null,
    },
  };
}

export async function createClient(client, fields) {
  const row = newClientRow(client, fields);
  const { error } = await supabase.from("pginvoice_clients").insert(row);
  if (error) throw error;
  notifyClientsChanged();
  const bits = [CLIENT_TYPE_LABELS[row.type] || row.type, row.agreed_hours != null ? `${row.agreed_hours} hrs` : null, row.clickup_folder ? `folder "${row.clickup_folder}"` : null].filter(Boolean);
  logClientHistory(client, "created", `Created client (${bits.join(", ")})`, {
    type: row.type, agreedHours: row.agreed_hours, consultant: row.consultant, startDate: row.start_date, clickupFolder: row.clickup_folder,
  });
}

// Paginated (PostgREST caps a request at 1000 rows) with a unique tie-breaker (id) so rows
// sharing an effective_date can't be skipped/duplicated across page boundaries.
export async function fetchClientEvents(client) {
  const PAGE = 1000;
  let all = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from("pginvoice_client_events").select("*")
      .order("effective_date", { ascending: true })
      .order("id", { ascending: true });
    if (client) q = q.eq("client", client);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
  }
  return all;
}

const EVENT_KIND_LABEL = {
  type: "Transition", consultant: "Consultant update", offboarding: "Offboarding",
  reactivation: "Reactivation", hold: "Put on hold", resume: "Resume",
};
export async function createClientEvent(client, kind, effectiveDate, fields, note) {
  const row = { client, kind, effective_date: effectiveDate, note: note || null, applied: false, ...fields };
  const { error } = await supabase.from("pginvoice_client_events").insert(row);
  if (error) throw error;
  notifyClientsChanged();
  const label = EVENT_KIND_LABEL[kind] || kind;
  const detailBits = kind === "type" ? `→ ${fields.new_type}${fields.new_agreed_hours != null ? ` (${fields.new_agreed_hours} hrs)` : ""}`
    : kind === "consultant" ? `→ ${fields.new_consultant || "unassigned"}`
    : "";
  logClientHistory(client, `event_${kind}`, `Scheduled ${label}${detailBits ? ` ${detailBits}` : ""}, effective ${effectiveDate}`, { kind, effectiveDate, ...fields, note: note || null });
}

// Only for events that haven't been applied yet (still-scheduled/future transitions) --
// an already-applied event's mutation to the client's current row already happened, and
// typeTimelineFor's replay of past months reads applied=true events specifically, so
// deleting one after the fact would silently rewrite already-closed months' history. The
// Clients module enforces this by only ever offering delete on pending rows; enforced here
// too so any other future caller can't accidentally do it either.
export async function deleteClientEvent(id, { applied, client, kind } = {}) {
  if (applied) throw new Error("Can't delete an already-applied event -- it already changed the client's history.");
  // The .eq("applied", false) guard can still no-op (0 rows) if the event was applied by a
  // sync that ran after this stale client-side `applied` flag was read but before this delete
  // reached the DB -- select() + count so the caller can tell "actually deleted" apart from
  // "silently did nothing," instead of showing a false "deleted" success either way.
  const { data, error } = await supabase.from("pginvoice_client_events").delete().eq("id", id).eq("applied", false).select("id");
  if (error) throw error;
  if (!data || !data.length) throw new Error("That event was already applied by the time this reached the server -- refresh and try again.");
  notifyClientsChanged();
  if (client) logClientHistory(client, `event_${kind}_removed`, `Removed scheduled ${EVENT_KIND_LABEL[kind] || kind}`, { kind });
}

// Picks the chronologically-latest event (by effective_date, tying on id) from a list --
// used by recomputeClientCurrentState below so "what's true today" is always derived by
// walking the FULL applied-event history in effective_date order, never by whichever event
// happens to have been applied most recently. Applying events one at a time and blindly
// overwriting the client row with just-applied event's fields (the old behaviour) meant a
// backdated correction event -- added later, but dated earlier than an event that was
// already applied -- would win on write order and silently clobber a chronologically newer,
// already-applied event's fields. This is the exact bug behind the SGME/Comunet/Amorim Cork
// drift: a correction event with an earlier effective_date kept reverting the client row
// back to its old (wrong) state on the next sync, undoing a later, more-recent transition.
function latestByEffectiveDate(events) {
  return events.reduce((best, e) => {
    if (!best) return e;
    if (e.effective_date > best.effective_date) return e;
    if (e.effective_date === best.effective_date && e.id > best.id) return e;
    return best;
  }, null);
}

// ---- Lifecycle rule shared with accrualsSync's endPeriodsFor ----
// The ordering both recomputeClientCurrentState (a client's current status) and
// endPeriodsFor (which months an offboarded client stops accruing) replay events in. By
// effective_date, then -- on the SAME date -- a type event sorts before any status event,
// so an offboarding dated the same day as a type change wins (a type change doesn't
// re-engage on the day you offboard), then by id. Before this the two disagreed: a
// same-date type event with a higher id brought the client back "active" here while
// endPeriodsFor produced an empty period, so the client never ended at all.
export const LIFECYCLE_STATUS_KINDS = ["offboarding", "reactivation", "hold", "resume"];
export function compareLifecycleEvents(a, b) {
  return a.effective_date.localeCompare(b.effective_date)
    || (a.kind === "type" ? 0 : 1) - (b.kind === "type" ? 0 : 1)
    || a.id - b.id;
}
export function lifecycleTimeline(events, client) {
  return events
    .filter((e) => (client == null || e.client === client) && (LIFECYCLE_STATUS_KINDS.includes(e.kind) || e.kind === "type"))
    .sort(compareLifecycleEvents);
}
// Whether a type event re-engages a client currently ended (offboarded, or archived
// directly) since `endDate`: strictly after it -- same day, the end wins. An ended client
// with no end date on file can only be re-engaged by a type event being applied now.
export function typeEventReengages(typeEvent, endDate, isNewlyApplied) {
  if (!typeEvent) return false;
  if (endDate) return typeEvent.effective_date > endDate;
  return !!isNewlyApplied;
}
const isEndedStatus = (status) => status === "offboarded" || status === "archived";

// Folds the event-driven status history (status kinds + re-engaging type events) from
// "active". Never yields "archived" -- that status is only ever set directly.
// `ended` mirrors endPeriodsFor's open period: a hold after an offboarding leaves the client
// ended (shown on hold), and a later type/resume/reactivation re-engages it either way.
function replayStatus(timeline) {
  let status = "active";
  let endDate = null;
  let ended = false;
  for (const e of timeline) {
    if (e.kind === "offboarding") { status = "offboarded"; endDate = e.effective_date; ended = true; }
    else if (e.kind === "reactivation" || e.kind === "resume") { status = "active"; endDate = null; ended = false; }
    else if (e.kind === "hold") { status = "on_hold"; endDate = null; }
    else if (e.kind === "type" && ended) { status = "active"; endDate = null; ended = false; }
  }
  return { status, endDate };
}

// Derives the client's current type/agreed_hours/consultant/status/end_date from its
// current row plus its FULL event history (already-applied plus the ones being applied
// now) -- each field is decided independently by that field's own chronologically-latest
// event, so insertion order (which event got added to the DB last) can never override
// effective-date order (which event actually happened most recently). This is what
// applyDueClientEvents below writes, instead of a raw per-event patch.
//
// `baseRow` is the client's current row (client, base_type, base_agreed_hours, type,
// agreed_hours, consultant, status, end_date). A field with no event of its kind keeps the
// row's current value -- starting from defaults (status "active", base hours) meant applying
// ANY event (say a consultant change) silently wiped a status set without an event (e.g.
// "archived") or a quoted amount edited directly via updateQuotedAmount.
// `dueIds` (optional Set): ids of the events being applied in this run; omitted = treat
// every event as due (full replay). Status:
//   - a status-kind event is due -> the full replay (replayStatus) decides;
//   - else a type event is due and the client is ended (offboarded, or archived directly)
//     -> re-engaged (active) if typeEventReengages;
//   - else the stored status is repaired to the replay whenever they disagree -- so a patch
//     lost after its events were marked applied, or stale state written by older code, heals
//     on the next run. Not when there are no status events at all (a status set directly
//     with nothing to replay), and never for "archived", which the replay can't produce.
// A quoted client's amount is kept unless the type event that set it is itself due now.
export function recomputeClientCurrentState(baseRow, events, dueIds = null) {
  const own = events.filter((e) => e.client === baseRow.client);
  const isDue = (e) => !dueIds || dueIds.has(e.id);
  const patch = {
    type: baseRow.type ?? baseRow.base_type,
    agreed_hours: baseRow.agreed_hours !== undefined ? baseRow.agreed_hours : baseRow.base_agreed_hours,
    consultant: baseRow.consultant ?? null,
    status: baseRow.status ?? "active",
    end_date: baseRow.end_date ?? null,
  };

  const lt = latestByEffectiveDate(own.filter((e) => e.kind === "type"));
  if (lt) {
    // updateQuotedAmount edits a quoted client's amount directly (no event), so an older,
    // already-applied type->quoted event must not reset it on every later recompute.
    const keepQuotedAmount = lt.new_type === "quoted" && baseRow.type === "quoted" && !isDue(lt);
    patch.type = lt.new_type;
    if (!keepQuotedAmount) patch.agreed_hours = lt.new_agreed_hours;
  }

  const lc = latestByEffectiveDate(own.filter((e) => e.kind === "consultant"));
  if (lc) patch.consultant = lc.new_consultant;

  const hasStatusEvents = own.some((e) => LIFECYCLE_STATUS_KINDS.includes(e.kind));
  const statusDue = own.some((e) => LIFECYCLE_STATUS_KINDS.includes(e.kind) && isDue(e));
  const typeDue = own.some((e) => e.kind === "type" && isDue(e));
  const replay = replayStatus(lifecycleTimeline(own));
  if (statusDue) {
    patch.status = replay.status;
    patch.end_date = replay.endDate;
  } else if (typeDue && isEndedStatus(patch.status) && typeEventReengages(lt, patch.end_date, isDue(lt))) {
    patch.status = "active";
    patch.end_date = null;
  } else if (hasStatusEvents && patch.status !== "archived" && patch.status !== replay.status) {
    patch.status = replay.status;
    patch.end_date = replay.endDate;
  }
  return patch;
}

// Applies any event whose effective date has arrived (<= today) and isn't applied
// yet, mutating the client's current profile row. Safe to call on every module
// load -- already-applied events are a no-op via the `applied` guard.
//
// Order matters: client rows are patched FIRST, events marked applied only after every
// patch succeeded. The reverse order (mark, then patch) meant a failed patch left events
// marked applied but never reflected on the row, and with status re-derivation gated on
// due events nothing would ever repair it. If marking fails after the patches, the next
// run re-applies the same events -- recomputeClientCurrentState is a pure function of the
// row + full event list, so that's the same patch again (idempotent).
export async function applyDueClientEvents() {
  const todayKey = new Date().toISOString().slice(0, 10);
  const { data: due, error } = await supabase
    .from("pginvoice_client_events")
    .select("*")
    .eq("applied", false)
    .lte("effective_date", todayKey)
    .order("effective_date", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  if (!due || !due.length) return 0;

  const clientNames = [...new Set(due.map((e) => e.client))];
  // Re-derive each affected client's current state from its COMPLETE history (already-
  // applied events plus the ones due now) -- a previously-applied event with a later
  // effective_date than one applied just now must still win, and only a full replay in
  // effective_date order guarantees that.
  const { data: baseRows, error: baseErr } = await supabase.from("pginvoice_clients").select("client, base_type, base_agreed_hours, type, agreed_hours, consultant, status, end_date").in("client", clientNames);
  if (baseErr) throw baseErr;
  const { data: alreadyApplied, error: appliedErr } = await supabase.from("pginvoice_client_events").select("*").eq("applied", true).in("client", clientNames);
  if (appliedErr) throw appliedErr;
  const dueIds = new Set(due.map((e) => e.id));
  const history = [...(alreadyApplied || []).filter((e) => !dueIds.has(e.id)), ...due];

  for (const baseRow of baseRows || []) {
    const patch = recomputeClientCurrentState(baseRow, history, dueIds);
    const { error: updErr } = await supabase.from("pginvoice_clients").update(patch).eq("client", baseRow.client);
    if (updErr) throw updErr;
  }
  const { error: markErr } = await supabase.from("pginvoice_client_events").update({ applied: true }).in("id", due.map((e) => e.id));
  if (markErr) throw markErr;
  notifyClientsChanged();
  return due.length;
}

// Replays a client's applied "type" events to answer "what were they on, and what
// were their agreed hours, as of this month" — needed because a client's package
// can change mid-year and accrual math for a given month must use what was in
// effect then, not whatever is current today.
export function typeTimelineFor(client, events) {
  const segments = [{ from: null, type: client.baseType, agreedHours: client.baseAgreedHours, note: null }];
  const typeEvents = events
    .filter((e) => e.client === client.client && e.kind === "type" && e.applied)
    // id tie-break, same as latestByEffectiveDate -- two type events on the same date must
    // resolve to the same winner here as in the client's current row.
    .sort((a, b) => a.effective_date.localeCompare(b.effective_date) || a.id - b.id);
  for (const e of typeEvents) segments.push({ from: e.effective_date, type: e.new_type, agreedHours: e.new_agreed_hours === null ? null : Number(e.new_agreed_hours), note: e.note || null });
  return segments;
}

// Multiple dated notes per client -- each independently editable/deletable, not
// a single overwritten scratchpad. Every add/edit/delete also lands in the
// client's History feed via logClientHistory.
export async function fetchClientNotes(client) {
  const { data, error } = await supabase.from("pginvoice_client_notes").select("*").eq("client", client).order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function addClientNote(client, text) {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.from("pginvoice_client_notes").insert({
    client, text, author_email: userData?.user?.email || null, author_user_id: userData?.user?.id || null,
  });
  if (error) throw error;
  notifyClientsChanged();
  logClientHistory(client, "note_add", `Added a note`, { text });
}

export async function updateClientNote(id, client, text) {
  const { error } = await supabase.from("pginvoice_client_notes").update({ text, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
  notifyClientsChanged();
  logClientHistory(client, "note_edit", `Edited a note`, { text });
}

export async function deleteClientNote(id, client) {
  const { error } = await supabase.from("pginvoice_client_notes").delete().eq("id", id);
  if (error) throw error;
  notifyClientsChanged();
  logClientHistory(client, "note_delete", `Deleted a note`, {});
}

// Same idea as typeTimelineFor/typeForMonth but for status (active/on_hold/offboarded) --
// replays applied offboarding/reactivation/hold/resume events by effective_date so
// recomputeAccruals can tell "was this client on hold during month X" apart from "is this
// client on hold right now." Without this, a hold placed today would freeze the CURRENT
// month's accrual but a recompute of past months would still see today's flat `status`
// column and wrongly freeze/unfreeze months it shouldn't.
export function statusForMonth(client, events, monthKey) {
  const monthStart = `${monthKey}-01`;
  const statusEvents = events
    .filter((e) => e.client === client.client && e.applied && ["offboarding", "reactivation", "hold", "resume"].includes(e.kind))
    .sort((a, b) => a.effective_date.localeCompare(b.effective_date) || a.id - b.id);
  let status = "active";
  for (const e of statusEvents) {
    if (e.effective_date > monthStart) break;
    if (e.kind === "offboarding") status = "offboarded";
    else if (e.kind === "reactivation") status = "active";
    else if (e.kind === "hold") status = "on_hold";
    else if (e.kind === "resume") status = "active";
  }
  return status;
}

export function typeForMonth(client, events, monthKey) {
  const segments = typeTimelineFor(client, events);
  const monthStart = `${monthKey}-01`;
  let current = segments[0];
  for (const seg of segments) {
    if (seg.from === null || seg.from <= monthStart) current = seg;
  }
  return current;
}
