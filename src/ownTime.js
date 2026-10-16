// A user's own ClickUp time, for the "own" scopes (Timesheets, Overview's own hours). Pure.
//
// `userNames` are the exact user_name spellings pginvoice_my_access() returns
// (clickupUserNames: the profile's ClickUp name plus the linked wage person's ClickUp names,
// as stored). Rows are matched to them case-insensitively and trimmed -- never fuzzily: a
// teammate whose name merely resembles yours must not land in your timesheet, which is what
// the roster's fuzzy findPersonMatch would risk here.
const norm = (s) => String(s ?? "").trim().toLowerCase();

export function ownNameSet(userNames) {
  return new Set((userNames || []).map(norm).filter(Boolean));
}

// Whether one ClickUp user_name is in an ownNameSet.
export function isOwnName(mine, userName) {
  return mine.has(norm(userName));
}

// Only the rows logged by one of `userNames`; others' time on shared folders is dropped.
export function filterOwnRows(rows, userNames) {
  const mine = ownNameSet(userNames);
  if (!mine.size) return [];
  return (rows || []).filter((r) => isOwnName(mine, r.user));
}
