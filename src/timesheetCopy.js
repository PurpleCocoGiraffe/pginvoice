// Plain-text month timesheet for the Xero browser extension: one line per day that has
// logged time, "20 Oct-6.53" (day, short month, hyphen, hours to 2 dp). Days with no time
// are left out -- there's nothing to log in Xero for them. Month names are fixed English
// abbreviations, not the browser locale, so the extension always sees the same text.
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// `monthKey` "YYYY-MM"; `dailyMinutes` Map(dateKey "YYYY-MM-DD" -> minutes).
export function buildXeroTimesheetText(monthKey, dailyMinutes) {
  if (!monthKey) return "";
  const [y, m] = monthKey.split("-").map(Number);
  const days = new Date(y, m, 0).getDate();
  const lines = [];
  for (let d = 1; d <= days; d++) {
    const dateKey = `${monthKey}-${String(d).padStart(2, "0")}`;
    const hours = (dailyMinutes?.get(dateKey) || 0) / 60;
    if (Math.round(hours * 100) <= 0) continue;
    lines.push(`${d} ${MONTHS_SHORT[m - 1]}-${hours.toFixed(2)}`);
  }
  return lines.join("\n");
}

// Clipboard write that also works where navigator.clipboard is unavailable (non-secure
// context, older browsers): falls back to a hidden textarea + execCommand("copy").
export async function copyText(text) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
