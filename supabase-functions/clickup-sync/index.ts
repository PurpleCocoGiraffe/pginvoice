// Purple Giraffe — ClickUp -> Supabase sync
//
// Pulls time-tracking entries straight from the ClickUp API (instead of a
// manually-exported CSV) and upserts them into public.pginvoice_clickup_entries,
// in the same shape the frontend already expects from a CSV upload (folder,
// task, minutes, billable, user, isInternal, monthKey/monthLabel, dateKey) so
// no downstream module needs to know the data didn't come from a file.
//
// Processes exactly ONE calendar month per invocation (fetch -> transform ->
// upsert -> stale-row cleanup). Earlier versions tried to do many months in a
// single invocation — even after batching per month within the loop, the
// cumulative CPU time across all months in one request still blew the Edge
// Function's compute budget (WORKER_RESOURCE_LIMIT), since ~2,500 entries per
// month is already ~3.5s of real work on its own.
//
// Invoked on a schedule via pg_cron: every 20 minutes with an empty body
// (monthOffset 0, the current month — where entries change day-to-day), and
// every 4 hours with {"monthOffset": 1} (last month). The stale-row cleanup
// below only deletes rows whose entry_start falls in the month just fetched,
// so a month that's never re-synced never gets edits/deletions made in
// ClickUp reconciled again -- without the monthOffset-1 job, an entry logged
// (then edited/removed in ClickUp) right at a month boundary would linger in
// Supabase forever once the calendar rolled over, even after "Sync now".
// "Sync now" (App.jsx) mirrors this: it calls both offset 0 and offset 1.
// To backfill further back, invoke manually with {"monthOffset": 2}, etc.
//
// CLICKUP_API_TOKEN must be set as an Edge Function secret (Project Settings
// -> Edge Functions -> Secrets); it is never sent to the client.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CLICKUP_BASE = "https://api.clickup.com/api/v2";
const TIMEZONE = "Australia/Adelaide"; // matches the CSV export's "Start Text" localisation

// The cron trigger never sends an Origin header so this was never noticed, but
// the "Sync now" button (App.jsx) calls this straight from the browser via
// supabase.functions.invoke, which preflights with an OPTIONS request. Without
// these headers the preflight gets no Access-Control-Allow-Origin back and the
// browser drops the real request before it's even sent — surfaces client-side
// as "Failed to send a request to the Edge Function", no further detail.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const JSON_HEADERS = { "Content-Type": "application/json", ...CORS_HEADERS };

// Same rule the frontend's nameMatch.js uses — kept in sync manually since this
// runs in a separate Deno runtime and can't share an import with the Vite app.
// "Purple Giraffe" (DMA's ClickUp account) is NOT internal — its hours count like
// any other consultant's across all reports.
const INTERNAL_KEYWORDS = ["onboarding", "induction", "offboarding", "handover", "wip"];
function isInternalFolder(folder: string): boolean {
  const f = (folder || "").toLowerCase();
  if (!f) return false;
  return INTERNAL_KEYWORDS.some((k) => f.includes(k));
}

// Built once and reused — constructing an Intl.DateTimeFormat per call was
// expensive enough, multiplied across thousands of entries, to eat into the
// Edge Function's CPU-time budget.
const DATE_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
function localDateParts(epochMs: number) {
  const parts = DATE_FMT.formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")) };
}
function monthKeyOf(year: number, month: number) { return `${year}-${String(month).padStart(2, "0")}`; }
function monthLabelOf(year: number, month: number) {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// The ClickUp API's start_date/end_date fetch window must bound a calendar
// month in *Adelaide* local time, not naive UTC -- Adelaide is UTC+9:30/+10:30
// depending on DST, so a naive `Date.UTC(year, month, 1)` boundary sits up to
// ~9.5 hours into the wrong side of the month from ClickUp's (and the user's)
// perspective. A real gap this caused: an entry logged at 2026-06-30 23:45:58
// UTC -- 2026-07-01 09:15:58 AM ACST, unambiguously "July 1st" in ClickUp's
// own UI/export -- fell 14 minutes before a naive UTC "July 1 00:00" boundary
// and was silently excluded from the July fetch entirely, undercounting a
// consultant's hours for that month. Iterating twice (rather than assuming a
// fixed offset) means this self-corrects across the October/April DST
// transition instead of drifting by an hour near those boundaries.
function adelaideLocalMidnightUtcMs(year: number, month1to12: number, day: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const desiredAsUtcMs = Date.UTC(year, month1to12 - 1, day, 0, 0, 0);
  let guessMs = desiredAsUtcMs;
  for (let i = 0; i < 2; i++) {
    const parts = fmt.formatToParts(new Date(guessMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    const localAsUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    guessMs += desiredAsUtcMs - localAsUtcMs;
  }
  return guessMs;
}

async function clickupFetch(path: string, token: string) {
  const res = await fetch(`${CLICKUP_BASE}${path}`, { headers: { Authorization: token } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ClickUp API ${res.status} on ${path}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

async function fetchAllTeamMemberIds(token: string, teamId: string): Promise<string[]> {
  const data = await clickupFetch(`/team`, token);
  const team = (data.teams || []).find((t: any) => String(t.id) === String(teamId)) || data.teams?.[0];
  if (!team) throw new Error("No ClickUp team/workspace found for this token.");
  return (team.members || []).map((m: any) => String(m.user?.id)).filter(Boolean);
}

// ClickUp's time-entries API only returns entries for users listed in `assignee` — omit it
// and you get just the token owner's own entries. Scoping that filter to *today's* /team
// member list (as this used to) means the moment someone is removed from the workspace
// (resignation, offboarding), their ID silently drops out of every future sync, including
// backfills of months where they were still active and had genuinely logged time — their
// history quietly stops being fetchable, not just filtered downstream. Persisting every ID
// ever seen and using the union going forward means a departure only ever adds to this set,
// never removes from it, so past months stay syncable indefinitely.
const KNOWN_USER_IDS_KEY = "clickup_known_user_ids";
async function unionKnownUserIds(supabase: any, currentIds: string[]): Promise<string[]> {
  const { data } = await supabase.from("pginvoice_app_state").select("value").eq("key", KNOWN_USER_IDS_KEY).maybeSingle();
  const known: string[] = Array.isArray(data?.value) ? data.value : [];
  const union = [...new Set([...known, ...currentIds])];
  if (union.length !== known.length) {
    await supabase.from("pginvoice_app_state").upsert({ key: KNOWN_USER_IDS_KEY, value: union, updated_at: new Date().toISOString() }, { onConflict: "key" });
  }
  return union;
}

// The workspace this app's data actually lives in. A personal API token can belong to
// more than one ClickUp team at once (e.g. an auto-created personal workspace alongside
// the shared one) -- picking data.teams[0] unconditionally means whichever workspace
// ClickUp happens to list first silently decides where every sync reads from. This broke
// production for real: a token that was a member of both "Kelly Wagner's Purple Giraffe
// Workspace" (empty) and "Purple Giraffe Workspace" (the real one) had ClickUp list the
// empty personal one first, so every sync using that token quietly queried nothing --
// no error, just "0 entries synced," for a token that in every other sense had full
// access. Prefer the real workspace by name whenever a token is a member of more than
// one, rather than trusting list order; explicitTeamId (CLICKUP_TEAM_ID secret) still
// wins outright if it's ever set, and a token that's only a member of one team is
// unaffected either way.
const PREFERRED_WORKSPACE_NAME = "purple giraffe workspace";
async function resolveTeamId(token: string, explicitTeamId: string | undefined) {
  if (explicitTeamId) return explicitTeamId;
  const data = await clickupFetch(`/team`, token);
  const teams = data.teams || [];
  const preferred = teams.find((t: any) => String(t.name || "").trim().toLowerCase() === PREFERRED_WORKSPACE_NAME);
  const team = preferred || teams[0];
  if (!team) throw new Error("No ClickUp team/workspace found for this token.");
  return String(team.id);
}

// Confirmed live (2026-07-31) against a raw sample from the real workspace: normal
// entries carry `task_location.folder_name` when `include_location_names=true` — that
// path is correct. But ClickUp also allows tracking time with no task selected at all
// (a bare "start timer" / manually-added entry not linked to anything) — those come
// back with `task` as the literal string "0" and no `task_location` object whatsoever,
// not just a missing folder name. There is no folder to resolve for those (and it may
// also happen for a task in a space/folder this token isn't granted visibility into) --
// labeled "Private" rather than a raw "(No folder)", since either way it just means the
// location isn't something this sync can see or resolve.
function resolveFolderName(entry: any): string {
  return (
    entry.task_location?.folder_name ??
    entry.task?.folder?.name ??
    entry.folder?.name ??
    "Private"
  );
}
// A task-less entry (see resolveFolderName's comment) has no `task.name` either, but it
// does carry the user's own free-text `description` ("Email (Hayley) & Export", etc) --
// showing that instead of a generic "Untitled" is the difference between being able to
// tell these apart and having hundreds of hours of genuinely different work collapse
// into one indistinguishable bucket.
function resolveTaskName(entry: any): string {
  return entry.task?.name || (typeof entry.description === "string" && entry.description.trim()) || "Untitled (no task selected)";
}
function resolveUserName(entry: any): string {
  return entry.user?.username || entry.user?.email || "";
}
// Real task id (e.g. "86d3gjhzy") when this entry is linked to an actual task -- lets the
// frontend deep-link straight to the task in ClickUp (https://app.clickup.com/t/{id}, same
// shape as the API's own `task_url`). null for a task-less entry (task === "0", see above);
// there's nothing in ClickUp to link to for those.
function resolveTaskId(entry: any): string | null {
  return (entry.task && typeof entry.task === "object" && entry.task.id) ? String(entry.task.id) : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // A key saved from Settings (pginvoice_secrets, written by the clickup-key
  // function) takes priority over the CLICKUP_API_TOKEN Edge Function secret --
  // that's the whole point of letting it be set from the UI: it's how someone
  // rotates a key without a Supabase dashboard visit, so it should win once set.
  const { data: storedSecret } = await supabase.from("pginvoice_secrets").select("value").eq("key", "clickup_api_token").maybeSingle();
  const token = storedSecret?.value || Deno.env.get("CLICKUP_API_TOKEN");
  if (!token) {
    await supabase.from("pginvoice_sync_meta").update({
      last_synced_at: new Date().toISOString(), last_sync_status: "error",
      last_sync_message: "No ClickUp API key set. Add one in Settings.",
    }).eq("id", 1);
    return new Response(JSON.stringify({ ok: false, error: "No ClickUp API key set. Add one in Settings." }), { status: 400, headers: JSON_HEADERS });
  }

  let monthOffset = 0;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.monthOffset === "number" && Number.isFinite(body.monthOffset) && body.monthOffset >= 0) {
      monthOffset = Math.floor(body.monthOffset);
    }
  } catch (_) { /* malformed/absent body -> default to current month */ }

  try {
    const explicitTeamId = Deno.env.get("CLICKUP_TEAM_ID") || undefined;
    const teamId = await resolveTeamId(token, explicitTeamId);
    const currentMemberIds = await fetchAllTeamMemberIds(token, teamId);
    const memberIds = await unionKnownUserIds(supabase, currentMemberIds);
    const assignee = memberIds.join(",");

    // "Now" and the target month must also be figured in Adelaide local time --
    // using the UTC calendar date near a month boundary could pick the wrong
    // target month entirely (e.g. late in the evening Adelaide time is already
    // past midnight UTC into the next day).
    const nowParts = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, year: "numeric", month: "numeric" }).formatToParts(new Date());
    const nowYear = Number(nowParts.find((p) => p.type === "year")!.value);
    const nowMonth = Number(nowParts.find((p) => p.type === "month")!.value); // 1-12
    const targetMonthIndex0 = nowMonth - 1 - monthOffset; // 0-based, can go negative/over 11
    const targetYear = nowYear + Math.floor(targetMonthIndex0 / 12);
    const targetMonth1to12 = ((targetMonthIndex0 % 12) + 12) % 12 + 1;
    const nextMonthIndex0 = targetMonthIndex0 + 1;
    const nextYear = nowYear + Math.floor(nextMonthIndex0 / 12);
    const nextMonth1to12 = ((nextMonthIndex0 % 12) + 12) % 12 + 1;

    const start = new Date(adelaideLocalMidnightUtcMs(targetYear, targetMonth1to12, 1));
    const end = new Date(adelaideLocalMidnightUtcMs(nextYear, nextMonth1to12, 1));

    const qs = new URLSearchParams({
      start_date: String(start.getTime()),
      end_date: String(end.getTime()),
      include_task_tags: "false",
      include_location_names: "true",
      assignee,
    });
    const data = await clickupFetch(`/team/${teamId}/time_entries?${qs.toString()}`, token);
    const entries = data.data || [];
    const rawSample = entries[0] ?? null;

    const monthRows: any[] = [];
    for (const entry of entries) {
      const minutes = Number(entry.duration || 0) / 60000;
      if (!minutes) continue;
      const folder = resolveFolderName(entry);
      const startMs = Number(entry.start || 0);
      const { year, month, day } = localDateParts(startMs);
      monthRows.push({
        entry_id: String(entry.id),
        folder,
        task: resolveTaskName(entry),
        task_id: resolveTaskId(entry),
        minutes,
        billable: !!entry.billable,
        has_billable_col: true,
        user_name: resolveUserName(entry),
        is_internal: isInternalFolder(folder),
        month_key: monthKeyOf(year, month),
        month_label: monthLabelOf(year, month),
        date_key: `${monthKeyOf(year, month)}-${String(day).padStart(2, "0")}`,
        entry_start: new Date(startMs).toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    if (monthRows.length) {
      const { error: upsertError } = await supabase
        .from("pginvoice_clickup_entries")
        .upsert(monthRows, { onConflict: "entry_id" });
      if (upsertError) throw upsertError;
    }

    // Stale-row cleanup, scoped to just this month so neither the id list nor
    // the delete query ever has to cover more than one month's data at a time.
    const { data: existing, error: existingError } = await supabase
      .from("pginvoice_clickup_entries")
      .select("entry_id")
      .gte("entry_start", start.toISOString())
      .lt("entry_start", end.toISOString());
    if (existingError) throw existingError;
    const fetchedIds = new Set(monthRows.map((r) => r.entry_id));
    const staleIds = (existing || []).map((r) => r.entry_id).filter((id) => !fetchedIds.has(id));
    if (staleIds.length) {
      const { error: deleteError } = await supabase.from("pginvoice_clickup_entries").delete().in("entry_id", staleIds);
      if (deleteError) throw deleteError;
    }

    // Keeps every consultant/coordinator's ClickUp-derived client access current
    // with what they've actually logged time against, all-time (not just this
    // month) -- a newly-worked folder gets auto-granted, one they've stopped
    // logging to gets auto-revoked. Runs on every sync (every 20 min for the
    // current month) so this stays close to live without a separate job.
    // source='manual'/'capacity_lead' rows are untouched: only source='clickup'
    // rows are ever added or removed here.
    try {
      const { data: profiles } = await supabase
        .from("pginvoice_profiles")
        .select("user_id, clickup_user_name")
        .in("role", ["consultant", "coordinator"])
        .not("clickup_user_name", "is", null);
      for (const p of profiles || []) {
        // Paginated -- PostgREST caps a single request at 1000 rows, and several
        // people here log well over that many entries all-time (Alexander: 6851,
        // Vinavie: 4687, ...), so an unpaginated select silently missed every
        // folder past the first page.
        const folderSet = new Set<string>();
        let pageFrom = 0;
        while (true) {
          const { data: page } = await supabase
            .from("pginvoice_clickup_entries")
            .select("folder")
            .ilike("user_name", p.clickup_user_name)
            .range(pageFrom, pageFrom + 999);
          if (!page || !page.length) break;
          for (const e of page) if (e.folder) folderSet.add(e.folder);
          if (page.length < 1000) break;
          pageFrom += 1000;
        }
        const folders = [...folderSet];
        let clients: string[] = [];
        if (folders.length) {
          const [{ data: directClients }, { data: costCentres }] = await Promise.all([
            supabase.from("pginvoice_clients").select("client, clickup_folder").in("clickup_folder", folders),
            supabase.from("pginvoice_cost_centres").select("client, folder").in("folder", folders),
          ]);
          const set = new Set<string>();
          for (const c of directClients || []) if (c.client) set.add(c.client);
          for (const c of costCentres || []) if (c.client) set.add(c.client);
          clients = [...set];
        }
        const { data: existingRows } = await supabase
          .from("pginvoice_user_clients")
          .select("client")
          .eq("user_id", p.user_id)
          .eq("source", "clickup");
        const existingSet = new Set((existingRows || []).map((r: any) => r.client));
        const desiredSet = new Set(clients);
        const toDelete = [...existingSet].filter((c) => !desiredSet.has(c));
        const toInsert = clients.filter((c) => !existingSet.has(c));
        if (toDelete.length) {
          await supabase.from("pginvoice_user_clients").delete().eq("user_id", p.user_id).eq("source", "clickup").in("client", toDelete);
        }
        if (toInsert.length) {
          await supabase.from("pginvoice_user_clients").insert(toInsert.map((client) => ({ user_id: p.user_id, client, source: "clickup" })));
        }
      }
    } catch (reconcileErr) {
      // Entries already upserted successfully above -- a reconciliation hiccup
      // shouldn't fail the whole sync, just gets logged for visibility.
      console.error("clickup-derived client assignment reconciliation failed:", reconcileErr);
    }

    // Not start.toISOString() -- that's a UTC instant which, for a target month's
    // Adelaide-local midnight, can land on the previous UTC calendar date/month
    // entirely (e.g. Jan 1 00:00 ACDT is Dec 31 13:30 UTC), which would mislabel
    // the very month this function just correctly fetched.
    const monthLabel = monthKeyOf(targetYear, targetMonth1to12);
    await supabase.from("pginvoice_sync_meta").update({
      last_synced_at: new Date().toISOString(), last_sync_status: "ok",
      last_sync_message: `Synced ${monthRows.length} entries for ${monthLabel} (monthOffset=${monthOffset}).`,
      rows_synced: monthRows.length,
    }).eq("id", 1);

    return new Response(JSON.stringify({ ok: true, rows_synced: monthRows.length, team_id: teamId, month: monthLabel, raw_sample: rawSample }), { headers: JSON_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from("pginvoice_sync_meta").update({
      last_synced_at: new Date().toISOString(), last_sync_status: "error", last_sync_message: message,
    }).eq("id", 1);
    return new Response(JSON.stringify({ ok: false, error: message }), { status: 500, headers: JSON_HEADERS });
  }
});
