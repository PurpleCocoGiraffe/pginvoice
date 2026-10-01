// Client-type badge wording/tone for Client Invoicing, looked up through nameMatch.js's
// canonical maps with a local fallback for a type those maps don't know yet (so a client
// moved to a new type never renders a blank badge/"undefined" in an export).
import { CLIENT_TYPE_LABELS, TYPE_LABELS_SHORT, CLIENT_TYPE_TONES } from "./nameMatch.js";

const FALLBACK_LONG = { digital: "Digital Package" };
const FALLBACK_SHORT = { digital: "Digital" };
const FALLBACK_TONE = { digital: "var(--status-info)" };

export const typeLabelShort = (t) => TYPE_LABELS_SHORT[t] ?? FALLBACK_SHORT[t] ?? CLIENT_TYPE_LABELS[t] ?? String(t ?? "");
export const typeLabelLong = (t) => CLIENT_TYPE_LABELS[t] ?? FALLBACK_LONG[t] ?? typeLabelShort(t);
export const typeTone = (t) => CLIENT_TYPE_TONES[t] ?? FALLBACK_TONE[t] ?? "var(--fg-tertiary)";
