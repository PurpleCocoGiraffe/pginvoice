# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start Vite dev server
- `npm run build` — production build
- `npm run preview` — preview the production build locally

No test suite or lint config is set up in this repo. Playwright is a devDependency but there are no `.spec`/test files checked in yet — if you add tests, wire up the `npm` script for them too.

## Project identity

- **App name**: Purple Giraffe / "pginvoice" — a client invoicing, capacity, and performance reporting tool.
- **GitHub repo**: `github.com/PurpleCocoGiraffe/pginvoice` (org-owned; transferred from a personal account).
- **Supabase project**: ref `fzvlnzlecchsubkpsmew`, region `ap-northeast-1`, under the same `PurpleCocoGiraffe` org. This is the *only* Supabase project this app talks to — do not create a second one or point the client elsewhere. (A second, unrelated `System review` project exists under a different, personal Supabase org — ignore it.)

## Architecture

This is a single-page React app (Vite, no router) with **one shell and four independently-stateful modules**:

- `src/Shell.jsx` — sidebar nav + theme toggle. All four modules are mounted simultaneously and switched via CSS `display` (not conditional rendering / unmount), specifically so each module's in-memory state (an uploaded CSV, filters, etc.) survives tab switching.
- `src/App.jsx` — "Client Invoicing" module (the original/largest module).
- `src/CapacityDashboard.jsx` — capacity planning.
- `src/PerformanceScorecard.jsx` — performance scorecard.
- `src/TimesheetSummary.jsx` — timesheet summary.

### Data flow: ClickUp → Supabase → frontend

Time-tracking data can arrive two ways, and downstream modules are written to not care which:

1. **Manual CSV upload** (legacy path, still supported) — parsed client-side with `papaparse`/`xlsx`.
2. **Live sync** — `supabase-functions/clickup-sync/index.ts` is a Deno Edge Function, run on a `pg_cron` schedule (not called by the browser directly, except for the manual "Sync now" button), that pulls entries from the ClickUp API and upserts them into `public.pginvoice_clickup_entries`. It processes one calendar month at a time (fetch → upsert → stale-row cleanup → discard) rather than accumulating everything in memory first — an earlier all-at-once version hit the Edge Function's compute limit on real historical data. `CLICKUP_API_TOKEN` is an Edge Function secret, never sent to the client.

`src/clickupSync.js` (browser-side) reads `pginvoice_clickup_entries` back out via `supabase-js` and reshapes it into **exactly the same row shape** `App.jsx` already produces from a CSV (`folder`, `task`, `minutes`, `billable`, `user`, `isInternal`, `monthKey`, `monthLabel`, `dateKey`) — so `CapacityDashboard`, `PerformanceScorecard`, and `TimesheetSummary` need zero changes regardless of data source. If you touch this row shape, update it in both `clickupSync.js` (frontend read) and `clickup-sync/index.ts` (Edge Function write) together.

The "internal vs billable folder" classification (`INTERNAL_KEYWORDS`) is duplicated between `src/nameMatch.js` (frontend) and `clickup-sync/index.ts` (Edge Function/Deno) because the two can't share an import across runtimes — keep them in sync manually if the rule changes.

### Supabase access pattern

`src/supabaseClient.js` uses the anon/publishable key only. Row-level security restricts it to read-only on `pginvoice_*` tables; all writes go through the `clickup-sync` Edge Function using its own service-role key, which never reaches the client.

### Client-side storage

- `src/idbStore.js` — IndexedDB key-value store, used only for the two large datasets (parsed ClickUp export can be several MB / 18k+ rows) that would risk hitting localStorage's ~5-10MB quota. Writing a value dispatches a `pg-idb-updated` window event so other mounted modules can react live to data another module just saved, instead of only picking it up on their own next mount.
- Everything else (filters, name-match overrides, theme) uses `localStorage` directly.
