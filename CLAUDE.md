# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start Vite dev server
- `npm run build` — production build
- `npm run preview` — preview the production build locally

Tests: a handful of `*.test.js` files exist (`nameMatch.test.js`, `accrualsSync.test.js`, `capacityData.test.js`, `overviewData.test.js`, `DateRangePicker.test.js`) but there is no `npm test` script wired up yet — check the test runner they assume before running them. Playwright is a devDependency with no `.spec` files checked in. If you add either, wire up the corresponding `npm` script.

This test suite is small and pointed: it exists almost entirely to pin previously-shipped **silent bugs** as permanent regressions (wrong active-client counts, sign-cancellation in accrual health, UTC date off-by-one, several stale-scalar bugs — see below), not for general coverage. Treat the files/behaviors they cover as fragile and re-check them after touching adjacent logic.

## Project identity

- **App name**: Purple Giraffe / "pginvoice" — a client invoicing, capacity, and performance reporting tool.
- **GitHub repo**: `github.com/PurpleCocoGiraffe/pginvoice` (org-owned; transferred from a personal account).
- **Supabase project**: ref `fzvlnzlecchsubkpsmew`, region `ap-northeast-1`, under the same `PurpleCocoGiraffe` org. This is the *only* Supabase project this app talks to — do not create a second one or point the client elsewhere. (A second, unrelated `System review` project exists under a different, personal Supabase org — ignore it.)

## Architecture

This is a single-page React app (Vite, no router) with **one shell and nine independently-stateful modules** (not four — the original module list undercounted this). `src/Shell.jsx` mounts all nine simultaneously and switches between them via CSS `display` (never conditional rendering / unmount), specifically so each module's in-memory state (an uploaded CSV, open filters, etc.) survives tab switching. Shell.jsx is also the real auth/session/RBAC/nav gate: it runs `LoginGate` against Supabase Auth, forces a password change for newly-created accounts (`must_change_password`), and filters nav items by role. **Nav filtering is cosmetic only — real enforcement is Postgres RLS.** Mobile gets a different nav shape entirely (bottom tab bar + "More" sheet) instead of the sidebar.

Roles: `super_admin`, `admin` (admin-tier, sees every module), `consultant`/`coordinator` (client-scoped — only see Overview, Clients, Client Accruals, Reporting; access to specific clients is auto-derived from their ClickUp identity).

Shell.jsx also fetches `pginvoice_cost_centres` once at startup and feeds it into `nameMatch.js`'s module-level singleton via `setDynamicCostCentres` — since every module mounts at once and that matching logic is synchronous, pages don't each fetch it themselves.

The nine modules:

- `src/Overview.jsx` (+ `OverviewKpiCard.jsx`, `OverviewList.jsx`) — cross-module rollup landing page (nav default). Loads from every other module's Supabase source in parallel via `Promise.allSettled` (never `Promise.all` — one flaky source must not blank the whole page); logic lives in `overviewData.js`. Always shows an explicit "no data yet" state rather than fabricating a 0.
- `src/App.jsx` — "Client Invoicing" module (the original/largest module). Reconciles ClickUp hours against the accrued-hours sheet per client per month; **read-only** consumer of the Clients module's roster/type data, never writes it.
- `src/Clients.jsx` (+ its own inline `ClientProfileDrawer`) — the client roster/profile CRUD module: `pginvoice_clients`, `pginvoice_client_events`, `pginvoice_client_history`, `pginvoice_client_notes`, `pginvoice_cost_centres`. This is where a client's type/consultant/status lifecycle is actually *edited*.
- `src/ClientDrawer.jsx` / `src/ClientRow.jsx` — presentational pieces of **App.jsx's own** client list/drawer. Easy to conflate with Clients.jsx's `ClientProfileDrawer` above — they are two unrelated drawers serving two different modules.
- `src/ClientAccruals.jsx` — the package-accrual ledger UI (`pginvoice_accruals`), auto-computed from ClickUp hours via `recomputeAccruals()` in `accrualsSync.js`; only editable field is comments.
- `src/CapacityDashboard.jsx` — capacity planning.
- `src/PerformanceScorecard.jsx` — performance scorecard.
- `src/TimesheetSummary.jsx` — timesheet summary.
- `src/TeamDashboard.jsx` ("Consultants" in nav) — the shared consultant roster editor (`SEED_PEOPLE`/cap_people). Wraps itself in its own `ErrorBoundary` class component so one bad roster record can't blank the whole app.
- `src/Users.jsx` — user/role management UI, Super Admin + Admin only, backed by the `manage-users` Edge Function (browser never writes `auth.users` directly).
- `src/Settings.jsx` ("Integrations" in nav, Super Admin only) — rotates the ClickUp API key from the browser via the `clickup-key` Edge Function, and exposes a manual sync trigger.

### Data flow: ClickUp → Supabase → frontend

Time-tracking data can arrive two ways, and downstream modules are written to not care which:

1. **Manual CSV upload** (legacy path, still supported) — parsed client-side with `papaparse`/`xlsx` (`parsers.js`).
2. **Live sync** — `supabase-functions/clickup-sync/index.ts` is a Deno Edge Function, run on a `pg_cron` schedule (not called by the browser directly, except for the manual "Sync now" button), that pulls entries from the ClickUp API and upserts them into `public.pginvoice_clickup_entries`. It processes one calendar month at a time (fetch → upsert → stale-row cleanup → discard) rather than accumulating everything in memory first — an earlier all-at-once version hit the Edge Function's compute limit on real historical data. `CLICKUP_API_TOKEN` is an Edge Function secret, never sent to the client.

`src/clickupSync.js` (browser-side) reads `pginvoice_clickup_entries` back out via `supabase-js` and reshapes it into **exactly the same row shape** `App.jsx` already produces from a CSV (`folder`, `task`, `minutes`, `billable`, `user`, `isInternal`, `monthKey`, `monthLabel`, `dateKey`) — so `CapacityDashboard`, `PerformanceScorecard`, and `TimesheetSummary` need zero changes regardless of data source. If you touch this row shape, update it in both `clickupSync.js` (frontend read) and `clickup-sync/index.ts` (Edge Function write) together.

The "internal vs billable folder" classification (`isInternalFolder` in `src/nameMatch.js`) is duplicated between the frontend and `clickup-sync/index.ts` (Edge Function/Deno) because the two can't share an import across runtimes — keep them in sync manually if the rule changes. It's a substring match against `["onboarding","induction","offboarding","handover","wip"]`; "Purple Giraffe" itself is explicitly **not** internal — it's the literal ClickUp login an external contractor (DMA) logs time under, and counts as billable like anyone else.

`src/dateMath.js`'s `adelaideLocalMidnightUtcMs` is a deliberately-duplicated twin (again, can't share code across the Deno/browser runtime split) of month-boundary math used by `clickup-sync`. It self-corrects via a re-measuring loop to handle Adelaide's DST transition (UTC+9:30/+10:30) correctly — an earlier off-by-one-day bug in this exact math broke sync once already, and it now has its own test file.

### The client/folder matching engine (`src/nameMatch.js`)

Central and heavily load-bearing across Client Invoicing, Capacity Planning, and Client Accruals — most of the codebase's documented bug history traces back to this file.

- `findMatch(name, candidates)`: exact match (confidence 1) → substring match (0.85) → token-Jaccard similarity (threshold 0.5). A name that normalizes to an **empty string** (e.g. ClickUp's literal "(No folder)" placeholder) must return `null` immediately — otherwise the substring branch treats `""` as a substring of everything and misattributes hours to an arbitrary candidate.
- `tokens()` strips a small stopword set (`and, the, co, pty, ltd, inc, group, of`) *unless* doing so would leave zero tokens, specifically so "Wills and Co" doesn't fuzzy-match "Toto and Co" on shared stopwords alone.
- `MULTI_FOLDER_CLIENTS`: hardcoded, prefix-based rules for clients whose real work spans several sibling ClickUp folders instead of one umbrella folder (Aus3C's training programs, Clarke Energy's sub-brands, Magain's ~20 per-agent folders, etc.). Each rule can carry `excludeFromAccrual` for sibling folders that are real client work (should roll up into total-hours views) but are billed separately from the retainer and must **not** count toward package-accrual math (e.g. Majestic Plumbing's "Quoted Web Project", Apex Energy's two quoted projects, Warrina Homes' Employee Guide project). BAMSS Childcare Security Services is the inverse case: a separately-registered client whose hours nonetheless count toward Brisbane Alarm Monitoring's *same* shared package.
  - `multiFolderMatchesFor` (includes excluded sub-projects — "how much did we actually work") vs. `multiFolderAccrualMatchesFor` (drops them — package/accrual math specifically).
- **Dynamic cost centres** (`pginvoice_cost_centres`, fed in via `setDynamicCostCentres` from Shell.jsx/Clients.jsx): a client with explicit dynamic rows is managed *entirely* through the Clients module UI — any hardcoded `MULTI_FOLDER_CLIENTS` rule for that same client is ignored outright rather than the two silently merging.
- **Task-prefix cost centres** (`pginvoice_cost_centres` rows with `kind: 'task_prefix'`, `source_folder`/`task_prefix` columns): some clients (Aus3C first) moved from tracking each cost centre as its own separate ClickUp folder to logging everything into ONE shared folder, with the cost centre identified by a prefix on the *task name* instead ("IRAP - ...", "Cyber Meets - ...", with an unrecognized/"Corporate -" prefix falling through to the parent). `splitTaskPrefixFolders(rows)` rewrites a matching row's `folder` to a synthetic identity that reuses the exact string the old separate-folder convention already used (e.g. "Aus3C IRAP") — so a month straddling old-and-new tracking, or a client using both conventions at once, unifies under one identity automatically, and every downstream consumer (roll-ups, accrual math, Capacity Planning matching) needs zero changes since it's all still keyed on `row.folder`. Applied once at both row-shape intake points (`clickupSync.js`'s live fetch and `parsers.js`'s CSV parser) — never in the edge function or the raw `pginvoice_clickup_entries` table, which stays a faithful mirror of ClickUp. Configured per client in the Clients module drawer's "Task-prefix cost centres" section.
- `CLIENT_TYPE_LABELS` / `TYPE_LABELS_SHORT` / `CLIENT_TYPE_TONES`: the canonical 7-type vocabulary (`package`, `hourly`, `quoted`, `map`, `project`, `strategy`, `ad_hoc`) plus a legacy `queensland` type. `CHART_TYPE_TONES` is a deliberately separate jewel-tone palette from `CLIENT_TYPE_TONES` because the badge palette reuses hues (package/strategy both use `--accent`), fine for a single badge but unreadable across 8 simultaneous chart lines.
- `basisToClientType` / `dominantClientType`: map Capacity Planning's 7-way "basis" vocabulary onto the client-type vocabulary; a multi-row "Combined" group is bucketed by whichever **fixed**-basis sub-row has the most agreed hours (actual hours can't be split back across sub-rows once matched to one folder).

### Client lifecycle and accrual math

- `src/clientsSync.js` manages `pginvoice_clients` plus a full scheduled-event system. Each client has an immutable `base_type`/`base_agreed_hours` snapshot and a mutable current `type`/`agreed_hours`, changed only via dated events in `pginvoice_client_events` (`type`, `consultant`, `offboarding`, `reactivation`, `hold`, `resume`). `applyDueClientEvents()` applies anything due, then **recomputes each affected client's current state from its full applied-event history**, picking each field's chronologically-latest event independently — this fixes a real production bug where a backdated correction event, added later but dated earlier than an already-applied one, used to lose on insertion order and silently revert a newer transition. `typeTimelineFor`/`typeForMonth`/`statusForMonth` replay this history to answer "what was this client's type/status as of month X," since a package's hours can change mid-year. Every mutation also writes to `pginvoice_client_history` (best-effort) for a unified audit trail. `updateQuotedAmount` is a direct field edit (not an event) — deliberately distinct from Package/Strategy transitions, which must stay replayable.
- `src/accrualsSync.js` bridges `pginvoice_accruals` into the same row shape the manual-upload parser produces. **`rowsToClients()`'s client-level `agreedHpm` field is a stale, last-write-wins scalar and must never be used for month-specific display** — only each row's own `months[mk].agreedHpm` is authoritative. Using the stale scalar caused three real regressions (ARAS stuck showing an old package figure after going off-package; Amorim Cork stuck at 0 after an hours increase; Warrina Homes stuck at an old value after an hours decrease) and is now explicitly regression-tested. `recomputeAccruals()` chains `newBalance = worked - agreed + prior`, replaying every non-override month from each client's earliest month on file forward — because a retroactive ClickUp edit to an already-closed month changes every later month's balance too. A human-set `is_override` cell is a frozen baseline, never recalculated; "on hold" pauses the accrual clock without zeroing the balance; a genuine off-package gap resets `prior` to 0. Strategy is treated identically to Package everywhere accrual math applies (`isPackageLikeType` in `format.js`); Quoted never accrues monthly — it's a single lifetime budget instead (`quotedAmount` minus lifetime worked hours).
- `src/usersSync.js` is a thin wrapper over the `manage-users` Edge Function (all real user CRUD needs the service-role key). `fetchClickupUserNames()` is paginated at 1000 rows (PostgREST's per-request cap) — unpaginated, it silently hid names past the first page in a 49k+ row table.

### Capacity data (`src/capacityData.js`, `src/capacityStore.js`)

- `capacityStore.js` wraps a single Supabase table `pginvoice_app_state` (jsonb value per key) — this replaced what used to be localStorage, so roster/client edits are visible across browsers/devices. `loadState` must **never** swallow a real query error and fall back to the seed default — doing so once let a transient network/RLS failure look identical to "first run, nothing saved yet," and the caller's save-effect then wrote the seed straight back over real data, destroying it. Only a genuine "no row" (`data === null`, no error) falls back quietly.
- `capacityData.js` is the shared library (used by App.jsx, CapacityDashboard, PerformanceScorecard, TeamDashboard, TimesheetSummary). `MONTHS` is generated dynamically (Dec 2025 through "now + 3 months"), never hardcoded to an end date. Real named public holidays are hardcoded per state (SA/WA/QLD) for 2025–2026. `agreedAt(client, monthKey)` replays a client's ascending `{from, agreed}` history array and defensively skips malformed entries — a bad manual SQL edit putting `null`/non-object into this array once crashed the whole dashboard with no error boundary; the tradeoff chosen is "render this one client's hours slightly wrong rather than blank the entire page for everyone." `SEED_CLIENTS`/`SEED_PEOPLE`/`SEED_SUPPORT` are real production data, not fixtures.

### Supabase access pattern

`src/supabaseClient.js` uses the anon/publishable key only, which grants nothing on its own — every `pginvoice_*` table's RLS requires the `authenticated` role, not `anon`; real access comes from the signed-in session's JWT that `supabase-js` attaches automatically. All writes beyond what RLS allows a normal authenticated user go through an Edge Function using its own service-role key, which never reaches the client:

- `clickup-sync` — the scheduled ClickUp pull (see above).
- `manage-users` — the only thing that can create/edit/delete `auth.users` rows. Re-derives the caller's own role server-side from `pginvoice_profiles` rather than trusting the request body. `resolveClickupClients` auto-derives which clients a new Consultant/Coordinator gets access to by looking up every ClickUp folder that person has ever logged time against (paginated past the 1000-row cap — some people have 6800+ entries) and exact-matching against `pginvoice_clients.clickup_folder` / `pginvoice_cost_centres.folder` (no fuzzy `nameMatch.js` logic ported into Deno; an admin can tick a client manually for edge cases). `syncClickupClientsForUser` only replaces `source='clickup'` rows — `source='manual'` and `source='capacity_lead'` rows are separately owned and never touched by the wrong path. Guards against removing the last Super Admin, self-role-editing, and self-deletion; every mutation is written to `pginvoice_audit_log`; a failed `create` rolls back the newly-created auth user rather than leaving a stranded account.
- `clickup-key` — lets a Super Admin rotate the ClickUp API token from Settings.jsx instead of visiting the Supabase dashboard. Validates the token live against ClickUp's `/team` endpoint before persisting; stores it in `pginvoice_secrets` (RLS-enabled, zero policies — reachable only via service role) and never returns the raw token to the client, only a masked preview. Needs real CORS headers (unlike `clickup-sync`, which only runs from cron/manual server-side invoke).

### Client-side storage

- `src/idbStore.js` — IndexedDB key-value store, used only for the two large datasets (parsed ClickUp export can be several MB / 18k+ rows) that would risk hitting localStorage's ~5-10MB quota. Writing a value dispatches a `pg-idb-updated` window event so other mounted modules can react live to data another module just saved, instead of only picking it up on their own next mount.
- Everything else (filters, name-match overrides, theme) uses `localStorage` directly.
- `src/storageKeys.js` centralizes every localStorage/IndexedDB/cross-module-event key as a named constant specifically so a writer and reader can't silently mismatch on a raw string literal.

### Utility layers

- `src/parsers.js` — CSV/XLSX parsing (`parseAccruedWorkbook`, `parseClickupCsv`). Duplicate month columns in a real spreadsheet are deduped keeping the **rightmost** (latest-entered) one. `parseStartTextMonth` deliberately parses ClickUp's pre-localized "Start Text" string rather than the raw UTC epoch, because converting the epoch can misfile a near-midnight session into the wrong month across the UTC/ACST boundary. "Time Tracked" (ms) is authoritative over "Time Tracked Text" (display string), which is only a fallback for older export presets.
- `src/format.js` — shared formatting helpers. `isPackageLikeType` (package/strategy only) is intentionally named differently from Clients.jsx's own `hasAgreedHoursField` (package/strategy/quoted) so a future edit can't accidentally import one where the other belongs and silently change Quoted's behavior.
- `src/printTemplate.js` — builds the branded PDF export; pulls in `letterheadFooter.js` and `nordiqueFont.js` (raw base64 asset blobs — a letterhead image and the licensed "Nordique Pro" font, embedded because the font has no public CDN/Google Fonts distribution; comments explicitly warn never to substitute another font like Quicksand).

### Small/shared components, one-liners

- `avatar.jsx` — `resizePhotoFile` (cover-crops an uploaded photo to a 160×160 JPEG data URL), `PersonAvatar`, `ClientAvatar` (colored-initials fallback hashed from name, graceful favicon `onError` fallback).
- `LeaveEditor.jsx` — Days/Hrs dual-input popover for leave entry (portal-rendered, self-repositioning); still stored as a single hours number underneath.
- `DateRangePicker.jsx` — wraps `react-day-picker`; exists specifically to avoid a UTC-parsing off-by-one-day bug (local-time `Date` constructor/getters only, never `toISOString`); uses `required` so re-clicking the same day to confirm a 1-day range isn't treated as a deselect.
- `LineChart.jsx` — full SVG line chart with click-to-isolate legend, hover tooltips, gradient fill reserved for a "primary" series and only shown with ≤3 visible lines.
- `Sparkline.jsx` — tiny inline SVG trend squiggle for KPI cards, no axes/legend/hover.
- `ExportItem.jsx` — shared icon+label dropdown-menu row used by every menu in the app.
- `ForcePasswordChange.jsx` — forces a real password before entry for any account created with an admin-typed temp password.
- `PlaceholderPage.jsx` — shared "honest not-built-yet" empty state for nav items with no real functionality.
- `SearchBox.jsx` — shared free-text filter+dropdown, used by Performance Scorecard and Timesheet Summary.
- `useDismissable.js` — shared outside-click + Escape dismissal hook for popovers/menus, plus a lighter `useEscape` for full-screen drawers.
- `main.jsx` — trivial entry point; mounts `<Shell/>` with the two global stylesheets plus `overview.css`.
