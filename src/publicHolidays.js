// Single source of truth for SA/WA/QLD public holidays, shared by Capacity Planning
// (via capacityData.js's re-export) and Wages review (src/wagesCalc.js).
//
// Conventions:
// - Weekday dates only. A holiday falling on a weekend with no substitute day doesn't
//   change working-day capacity or wage hours, so it's omitted (e.g. ANZAC Day 2026 is
//   a Saturday and SA/QLD give no substitute; QLD Easter Saturday/Sunday are always
//   weekends). Substitute days are listed under their "(in lieu)" name.
// - Coverage: 2025-06-01 to 2027-12-31. 2025/2026 were taken from each state's official
//   calendar; the 2027 dates MUST be re-verified against the SA, WA and QLD government
//   gazettes before they're relied on for payroll (states can move or add days late).
// - SA and QLD part-day holidays (Christmas Eve / New Year's Eve evenings, 7pm-midnight)
//   are deliberately excluded: they're worth 0 hours for a standard working day.
// - Optional `region` marks a holiday that only applies to part of the state (QLD's Ekka
//   is Brisbane-only; other QLD areas have their own show day). Consumers that don't
//   care about region simply ignore the field.
export const PUBLIC_HOLIDAYS = {
  SA: [
    { date: "2025-06-09", name: "King's Birthday" },
    { date: "2025-10-06", name: "Labour Day" },
    { date: "2025-12-25", name: "Christmas Day" },
    { date: "2025-12-26", name: "Proclamation Day" },
    { date: "2026-01-01", name: "New Year's Day" },
    { date: "2026-01-26", name: "Australia Day" },
    { date: "2026-03-09", name: "Adelaide Cup Day" },
    { date: "2026-04-03", name: "Good Friday" },
    { date: "2026-04-06", name: "Easter Monday" },
    { date: "2026-06-08", name: "King's Birthday" },
    { date: "2026-10-05", name: "Labour Day" },
    { date: "2026-12-25", name: "Christmas Day" },
    { date: "2026-12-28", name: "Proclamation Day (in lieu)" },
    { date: "2027-01-01", name: "New Year's Day" },
    { date: "2027-01-26", name: "Australia Day" },
    { date: "2027-03-08", name: "Adelaide Cup Day" },
    { date: "2027-03-26", name: "Good Friday" },
    { date: "2027-03-29", name: "Easter Monday" },
    { date: "2027-06-14", name: "King's Birthday" },
    { date: "2027-10-04", name: "Labour Day" },
    { date: "2027-12-27", name: "Christmas Day (in lieu)" },
    { date: "2027-12-28", name: "Proclamation Day (in lieu)" },
  ],
  WA: [
    { date: "2025-06-02", name: "Western Australia Day" },
    { date: "2025-09-29", name: "King's Birthday" },
    { date: "2025-12-25", name: "Christmas Day" },
    { date: "2025-12-26", name: "Boxing Day" },
    { date: "2026-01-01", name: "New Year's Day" },
    { date: "2026-01-26", name: "Australia Day" },
    { date: "2026-03-02", name: "Labour Day" },
    { date: "2026-04-03", name: "Good Friday" },
    { date: "2026-04-06", name: "Easter Monday" },
    { date: "2026-04-27", name: "ANZAC Day (in lieu)" },
    { date: "2026-06-01", name: "Western Australia Day" },
    { date: "2026-09-28", name: "King's Birthday" },
    { date: "2026-12-25", name: "Christmas Day" },
    { date: "2026-12-28", name: "Boxing Day (in lieu)" },
    { date: "2027-01-01", name: "New Year's Day" },
    { date: "2027-01-26", name: "Australia Day" },
    { date: "2027-03-01", name: "Labour Day" },
    { date: "2027-03-26", name: "Good Friday" },
    { date: "2027-03-29", name: "Easter Monday" },
    { date: "2027-04-26", name: "ANZAC Day (in lieu)" },
    { date: "2027-06-07", name: "Western Australia Day" },
    { date: "2027-09-27", name: "King's Birthday" },
    { date: "2027-12-27", name: "Christmas Day (in lieu)" },
    { date: "2027-12-28", name: "Boxing Day (in lieu)" },
  ],
  QLD: [
    { date: "2025-08-13", name: "Royal Queensland Show (Ekka, Brisbane)", region: "Brisbane" },
    { date: "2025-10-06", name: "King's Birthday" },
    { date: "2025-12-25", name: "Christmas Day" },
    { date: "2025-12-26", name: "Boxing Day" },
    { date: "2026-01-01", name: "New Year's Day" },
    { date: "2026-01-26", name: "Australia Day" },
    { date: "2026-04-03", name: "Good Friday" },
    { date: "2026-04-06", name: "Easter Monday" },
    { date: "2026-05-04", name: "Labour Day" },
    { date: "2026-08-12", name: "Royal Queensland Show (Ekka, Brisbane)", region: "Brisbane" },
    { date: "2026-10-05", name: "King's Birthday" },
    { date: "2026-12-25", name: "Christmas Day" },
    { date: "2026-12-28", name: "Boxing Day (in lieu)" },
    { date: "2027-01-01", name: "New Year's Day" },
    { date: "2027-01-26", name: "Australia Day" },
    { date: "2027-03-26", name: "Good Friday" },
    { date: "2027-03-29", name: "Easter Monday" },
    { date: "2027-05-03", name: "Labour Day" },
    { date: "2027-08-11", name: "Royal Queensland Show (Ekka, Brisbane)", region: "Brisbane" },
    { date: "2027-10-04", name: "King's Birthday" },
    { date: "2027-12-27", name: "Christmas Day (in lieu)" },
    { date: "2027-12-28", name: "Boxing Day (in lieu)" },
  ],
};

// The state's holidays falling in a "YYYY-MM" month, as copies (callers can't mutate the
// shared table). An unknown/missing state returns [] -- deliberately NOT the SA fallback
// capacityData's publicHolidayDays uses, because for wages a silent wrong-state answer
// would quietly misstate someone's public holiday hours.
export function holidaysFor(state, monthKey) {
  const list = PUBLIC_HOLIDAYS[String(state ?? "").trim().toUpperCase()];
  if (!list) return [];
  return list.filter((h) => h.date.startsWith(`${monthKey}-`)).map((h) => ({ ...h }));
}
