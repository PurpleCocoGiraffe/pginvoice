// Pure date/timezone math mirrored from supabase-functions/clickup-sync/index.ts.
// The edge function runs on Deno and isn't part of this npm build, so its logic
// can't be imported directly -- this is a deliberate copy, kept here so the
// month-boundary math that broke ClickUp sync once already (off-by-one-day
// due to UTC-vs-Adelaide midnight) has a test harness. If you change the
// algorithm in the edge function, update this copy and its tests too.

export const TIMEZONE = "Australia/Adelaide";

// Returns the UTC epoch ms corresponding to local midnight in `TIMEZONE` on
// the given date. Adelaide observes DST (UTC+9:30 / UTC+10:30), so this can't
// be a fixed offset -- it converges by re-measuring the actual local time at
// its own guess, which self-corrects for the DST transition in one extra pass.
export function adelaideLocalMidnightUtcMs(year, month1to12, day) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const desiredAsUtcMs = Date.UTC(year, month1to12 - 1, day, 0, 0, 0);
  let guessMs = desiredAsUtcMs;
  for (let i = 0; i < 2; i++) {
    const parts = fmt.formatToParts(new Date(guessMs));
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const localAsUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    guessMs += desiredAsUtcMs - localAsUtcMs;
  }
  return guessMs;
}

// ---- Adelaide calendar-month helpers (browser only; used by Wages review) ----
// The ClickUp sync's month boundary is Adelaide local time, so "this month" / "last
// month" must be measured there too, not in the browser's own timezone.

// The current calendar month in TIMEZONE, as "YYYY-MM".
export function adelaideMonthKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: TIMEZONE, year: "numeric", month: "2-digit" }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}`;
}

// Today's day of the month (1-31) in TIMEZONE.
export function adelaideDayOfMonth(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-AU", { timeZone: TIMEZONE, day: "numeric" }).format(now));
}

// Months back from the current TIMEZONE month (0 = this month, 1 = last month, negative = future).
export function monthOffsetFor(monthKey, now = new Date()) {
  const [cy, cm] = adelaideMonthKey(now).split("-").map(Number);
  const [y, m] = String(monthKey).split("-").map(Number);
  return (cy * 12 + cm) - (y * 12 + m);
}

// The payroll month being reviewed (Wages review and the Wages self view): Kelly reconciles
// last month in the first half of the month; after the 15th the current month is the more
// likely one being looked at.
export function wagesReviewMonthKey(now = new Date()) {
  const cur = adelaideMonthKey(now);
  if (adelaideDayOfMonth(now) > 15) return cur;
  const [y, m] = cur.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
