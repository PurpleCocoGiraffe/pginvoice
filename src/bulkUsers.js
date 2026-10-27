// Settings → Users & permissions → Bulk add: turns a pasted list into the accounts to create.
// Pure (no Supabase) so it's tested directly (bulkUsers.test.js).

const EMAIL_RE = /[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/;
const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();

// One person per line, email anywhere on it, the rest is their ClickUp name:
// "holly@x.com, Holly Latham", "Holly Latham <holly@x.com>", "holly@x.com<TAB>Holly Latham".
export function parseBulkLine(line) {
  const m = String(line).match(EMAIL_RE);
  const email = m ? m[0].toLowerCase() : "";
  const rest = m ? line.replace(m[0], " ") : line;
  const name = rest.replace(/[<>,;\t"']/g, " ").replace(/\s+/g, " ").trim();
  return { email, name };
}

// The roster person for a ClickUp name: the same full name, else the one person whose first
// name matches (and whose surname initial matches, when the roster name has one) -- the
// Consultant-field rule. Ambiguous or already linked: none (picked later in their drawer).
export function rosterMatchFor(clickupName, roster, linkedPersonIds = []) {
  const full = norm(clickupName);
  if (!full) return null;
  const free = roster.filter((p) => p && p.id && !linkedPersonIds.includes(p.id));
  const exact = free.filter((p) => norm(p.name) === full);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const [first, surname = ""] = full.split(" ");
  const loose = free.filter((p) => {
    const [pf, ps = ""] = norm(p.name).split(" ");
    return pf === first && (!ps || ps[0] === surname[0]);
  });
  return loose.length === 1 ? loose[0] : null;
}

// [{ line, email, clickupUserName, person, problems }] -- a row with problems is skipped.
export function parseBulkUsers(text, { existingEmails = [], clickupNames = [], roster = [], linkedPersonIds = [], clickupRequired = true, linkRoster = true } = {}) {
  const existing = new Set(existingEmails.map(norm));
  const byName = new Map(clickupNames.map((n) => [norm(n), n]));
  const seen = new Map();
  const claimed = [...linkedPersonIds];
  const rows = [];
  String(text || "").split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const { email, name } = parseBulkLine(raw);
    const problems = [];
    if (!email) problems.push("No email address on this line");
    else if (existing.has(email)) problems.push("Already has an account");
    else if (seen.has(email)) problems.push(`Listed twice (also line ${seen.get(email)})`);
    if (email && !seen.has(email)) seen.set(email, i + 1);
    const clickupUserName = name ? byName.get(norm(name)) || "" : "";
    if (name && !clickupUserName) problems.push(`"${name}" isn't a ClickUp user`);
    else if (!name && clickupRequired) problems.push("Add their ClickUp name after the email");
    const person = linkRoster && clickupUserName && !problems.length ? rosterMatchFor(clickupUserName, roster, claimed) : null;
    if (person) claimed.push(person.id);
    rows.push({ line: i + 1, email, clickupUserName, person, problems });
  });
  return rows;
}
