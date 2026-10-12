// Display formatting for the Wages review module (cards, drawer, table, settings, paste
// dialog). Pure -- no React. null is "not entered / not applicable" and always renders
// as an em dash, never 0.
import { BASES } from "./wagesCalc.js";

const isNum = (v) => v != null && Number.isFinite(Number(v));

export const fmtH = (v, dp = 1) => (isNum(v) ? `${Number(v).toFixed(dp)} h` : "—");
export const fmtNum = (v, dp = 1) => (isNum(v) ? Number(v).toFixed(dp) : "—");
// "+1.5 h" / "−1.5 h" (true minus sign) / "0.0 h"; the sign follows the rounded value.
export const fmtSigned = (v, dp = 1) => {
  if (!isNum(v)) return "—";
  const r = Number(Number(v).toFixed(dp));
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(dp)} h`;
};
export const fmtPct = (r, dp = 0) => (isNum(r) ? `${(Number(r) * 100).toFixed(dp)}%` : "—");

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-10-05" -> "5 Oct". String-split, never a Date, so there's no timezone shift.
export const fmtDay = (d) => {
  if (!d) return "";
  const [, m, day] = String(d).slice(0, 10).split("-").map(Number);
  return `${day} ${MONTHS_SHORT[m - 1]}`;
};
// "2026-10" -> "Oct 2026", or "October 2026" with long.
export const monthLabel = (mk, long = false) => {
  const [y, m] = String(mk).split("-").map(Number);
  return long
    ? new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" })
    : `${MONTHS_SHORT[m - 1]} ${y}`;
};
export const basisName = (b) => BASES[b]?.long || b;
