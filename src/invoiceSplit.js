// Per-cost-centre invoice caps for Client Invoicing. Some clients can't accept an invoice
// above a fixed dollar amount per cost centre (Clarke Energy: $10,000), so a cost centre
// whose billable hours exceed that at the agreed rate is split across several invoices.
// Pure (no React/Supabase imports) so the money math is directly testable.
import { fmt } from "./format.js";

// Keyed by the client's display name in Client Invoicing (the registered client name).
// Applies to the client's own row and to any sub-project row nested under it.
export const INVOICE_CAP_RULES = {
  "Clarke Energy (CEA)": { rate: 190, cap: 10000 },
};

export function invoiceCapRuleFor(c) {
  if (!c) return null;
  return INVOICE_CAP_RULES[c.displayName] || INVOICE_CAP_RULES[c.name]
    || (c.costCentreParentAccName ? INVOICE_CAP_RULES[c.costCentreParentAccName] : null) || null;
}

// Hours are carried in 1/10000 h units and money in cents, so the lines always add back up
// to exactly the input hours and the exact (cent-rounded) total.
const H_UNITS = 10000;

// hours -> [{ hours, amount }], every amount <= cap. Full invoices bill exactly `cap` for
// cap/rate hours (4 dp); the last one takes whatever hours are left.
// e.g. 127.55 h @ $190, cap $10,000 -> 52.6316 h/$10,000 · 52.6316 h/$10,000 · 22.2868 h/$4,234.50
export function splitInvoice(hours, { rate, cap }) {
  const h = Number(hours) || 0;
  const hUnits = Math.round(h * H_UNITS);
  // From the unrounded hours: rounding to 1/10000 h first could push exactly-N-caps of
  // work a cent over and produce a $0.01 extra invoice.
  const totalCents = Math.round(h * rate * 100);
  const capCents = Math.round(cap * 100);
  if (hUnits <= 0 || !(rate > 0) || !(capCents > 0) || totalCents <= capCents) {
    return [{ hours: hUnits / H_UNITS, amount: Math.max(0, totalCents) / 100 }];
  }
  const fullUnits = Math.round((cap / rate) * H_UNITS);
  const count = Math.ceil(totalCents / capCents);
  const lines = [];
  for (let i = 0; i < count - 1; i++) lines.push({ hours: fullUnits / H_UNITS, amount: capCents / 100 });
  lines.push({ hours: (hUnits - fullUnits * (count - 1)) / H_UNITS, amount: (totalCents - capCents * (count - 1)) / 100 });
  return lines;
}

// One entry per cost centre for a capped client: { name, hours, amount, lines }. Uses each
// roll-up line item's BILLABLE hours (the "Billable only" toggle is display-only), or the
// whole row as a single cost centre when it isn't rolled up this month. null = no rule.
export function costCentreInvoicesFor(c) {
  const rule = invoiceCapRuleFor(c);
  if (!rule) return null;
  const centres = c.costCentre?.lineItems?.length
    ? c.costCentre.lineItems.map((item) => ({ name: item.name, hours: item.billableHours ?? item.hours }))
    : [{ name: c.displayName ?? c.name, hours: c.billableWorked ?? c.worked ?? 0 }];
  return centres.map(({ name, hours }) => costCentreInvoice(name, hours, rule));
}

// One cost centre's invoices: { name, hours, amount, lines, rule }.
export function costCentreInvoice(name, hours, rule) {
  const lines = splitInvoice(hours, rule);
  return { name, hours, amount: lines.reduce((a, l) => a + Math.round(l.amount * 100), 0) / 100, lines, rule };
}

export const fmtMoney = (n) => "$" + (Number(n) || 0).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// "Invoice 1 of 3: 52.63 h · $10,000.00"
export const invoiceLineLabel = (line, i, n) => `Invoice ${i + 1} of ${n}: ${fmt(line.hours)} h · ${fmtMoney(line.amount)}`;
