// Client Accruals Management's per-client drawer: the whole ledger history for one client
// (every month, newest first, with what kind of entry each is and why), a balance chart,
// scheduled and past lifecycle events, and -- admin tier only -- the ledger actions
// (acknowledge a changed-hours flag, record / remove a write-off, mark / unmark a month not
// invoiced). Unrelated to Client Accruals' ClientDrawer.jsx and the Clients module's
// ClientProfileDrawer.
import React, { useMemo, useState } from "react";
import { X, AlertTriangle } from "lucide-react";
import { monthLabelOf } from "./accrualsSync.js";
import { adelaideDateKey } from "./dateMath.js";
import { carryOutOf } from "./format.js";
import { CLIENT_TYPE_LABELS } from "./nameMatch.js";
import { useEscape } from "./useDismissable.js";
import {
  cellKind, CELL_KIND_LABEL, CELL_KIND_HELP, resetKind, agreedForMonth, watchReasons, monthActions,
} from "./accrualsView.js";

const STATUS_LABEL = { active: "Active", offboarded: "Offboarded", archived: "Archived (unverified)", on_hold: "On Hold" };
export const ACTION_LABEL = {
  acknowledge: "Acknowledge hours change",
  not_invoiced: "Mark not invoiced",
  undo_not_invoiced: "Undo not invoiced",
  write_off: "Record write-off",
  remove_write_off: "Remove write-off",
};
const EVENT_LABEL = { type: "Type change", consultant: "Consultant", offboarding: "Offboarding", reactivation: "Reactivation", hold: "On hold", resume: "Resumed" };

export const fmtH = (n) => (typeof n === "number" ? (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—");
export function balanceText(v) {
  if (typeof v !== "number") return "—";
  if (v > 0) return `${fmtH(v)} h over`;
  if (v < 0) return `${fmtH(-v)} h unused`;
  return "0 h";
}

function eventText(e) {
  if (e.kind === "type") {
    const t = CLIENT_TYPE_LABELS[e.new_type] || e.new_type || "?";
    return `${t}${e.new_agreed_hours != null ? ` (${e.new_agreed_hours} h)` : ""}`;
  }
  if (e.kind === "consultant") return e.new_consultant || "Unassigned";
  return EVENT_LABEL[e.kind] || e.kind;
}

// Bars above / below a zero line: over-serviced up, unused hours down.
function BalanceChart({ points }) {
  if (points.length < 2) return null;
  const W = 420, H = 120, pad = 18;
  const vals = points.map((p) => p.v);
  const max = Math.max(1, ...vals.map((v) => Math.abs(v)));
  const zeroY = H / 2;
  const bw = Math.max(4, Math.min(22, (W - pad * 2) / points.length - 3));
  const step = (W - pad * 2) / points.length;
  const labelEvery = Math.ceil(points.length / 8);
  return (
    <svg viewBox={`0 0 ${W} ${H + 16}`} width="100%" role="img" aria-label="Closing balance by month">
      <line x1={pad} x2={W - pad} y1={zeroY} y2={zeroY} stroke="var(--border-soft)" />
      {points.map((p, i) => {
        const h = (Math.abs(p.v) / max) * (H / 2 - 6);
        const x = pad + i * step + (step - bw) / 2;
        return (
          <g key={p.mk}>
            <rect x={x} y={p.v >= 0 ? zeroY - h : zeroY} width={bw} height={Math.max(1, h)} rx="2"
              fill={p.v > 0 ? "var(--status-over)" : p.v < 0 ? "var(--status-warn)" : "var(--fg-tertiary)"}>
              <title>{`${monthLabelOf(p.mk)}: ${balanceText(p.v)}`}</title>
            </rect>
            {i % labelEvery === 0 && <text x={x + bw / 2} y={H + 12} fontSize="9" textAnchor="middle" fill="var(--fg-tertiary)" fontFamily="var(--font-mono)">{monthLabelOf(p.mk)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export default function AccrualClientDrawer({ client, profile, events = [], canWrite, uptoMonth, onClose, onAction }) {
  useEscape(onClose);
  const [showAll, setShowAll] = useState(false);
  const monthsDesc = useMemo(() => Object.keys(client.months).sort().reverse(), [client]);
  const points = useMemo(() => [...monthsDesc].reverse().map((mk) => ({ mk, v: carryOutOf(client.months[mk]) })).filter((p) => p.v !== null).slice(-24), [client, monthsDesc]);
  const latest = points[points.length - 1] || null;
  const reasons = watchReasons(client, uptoMonth);
  const today = adelaideDateKey();
  const myEvents = events.filter((e) => e.client === client.client);
  const upcoming = myEvents.filter((e) => !e.applied).sort((a, b) => a.effective_date.localeCompare(b.effective_date));
  const past = myEvents.filter((e) => e.applied).sort((a, b) => b.effective_date.localeCompare(a.effective_date)).slice(0, 8);
  const visibleMonths = showAll ? monthsDesc : monthsDesc.slice(0, 12);

  return (
    <aside className="pg-drawer pg-drawer--push" role="dialog" aria-label={`${client.client} accrual ledger`}>
      <div className="pg-drawer__header">
        <button className="pg-drawer__icon-btn" onClick={onClose} aria-label="Close" title="Close"><X size={16} /></button>
      </div>
      <div className="pg-drawer__title-row">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="pg-drawer__name">
            {client.client}
            {profile?.status && profile.status !== "active" && <span className="pg-tag pg-tag--muted" style={{ marginLeft: 6 }}>{STATUS_LABEL[profile.status] || profile.status}</span>}
            {!profile && <span className="pg-tag pg-tag--muted" style={{ marginLeft: 6 }} title="No matching client profile in the Clients module">Unmatched</span>}
          </div>
          <div className="pg-drawer__sub">
            {profile ? (CLIENT_TYPE_LABELS[profile.type] || profile.type) : "No Clients-module profile"}
            {profile?.agreedHours != null && (profile.type === "package" || profile.type === "strategy") && ` · ${profile.agreedHours} h/month now`}
            {client.manager && ` · ${client.manager}`}
          </div>
        </div>
      </div>

      <div className="pg-drawer__section">
        <div className="pg-drawer__section-title">Balance</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 24 }} className={latest?.v > 0 ? "pg-acc-pos" : latest?.v < 0 ? "pg-acc-neg" : undefined}>
          {latest ? balanceText(latest.v) : "No balance on file"}
        </div>
        {latest && <div className="pg-drawer__sub">Closing balance, {monthLabelOf(latest.mk)} — carried into the next month</div>}
        {reasons.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {reasons.map((r) => <div key={r.kind} className="pg-drawer__sub"><span className={`pg-acc-watch pg-acc-watch--${r.tone}`} style={{ marginLeft: 0, marginRight: 6 }}>{r.label}</span>{r.detail}</div>)}
          </div>
        )}
        <div style={{ marginTop: 10 }}><BalanceChart points={points} /></div>
      </div>

      {(upcoming.length > 0 || past.length > 0) && (
        <div className="pg-drawer__section">
          <div className="pg-drawer__section-title">Lifecycle (Clients module)</div>
          {upcoming.map((e) => (
            <div key={e.id} className="pg-acc-event"><span className="pg-acc-event__date">{e.effective_date}</span><span><strong>{e.effective_date > today ? "Scheduled" : "Due"}:</strong> {EVENT_LABEL[e.kind] || e.kind} — {eventText(e)}</span></div>
          ))}
          {past.map((e) => (
            <div key={e.id} className="pg-acc-event"><span className="pg-acc-event__date">{e.effective_date}</span><span>{EVENT_LABEL[e.kind] || e.kind} — {eventText(e)}</span></div>
          ))}
        </div>
      )}

      <div className="pg-drawer__section">
        <div className="pg-drawer__section-title">Ledger</div>
        <table className="pg-acc-ledger">
          <thead><tr><th>Month</th><th className="pg-acc-num">Worked</th><th className="pg-acc-num">Agreed</th><th className="pg-acc-num">Balance</th></tr></thead>
          <tbody>
            {visibleMonths.map((mk) => {
              const cell = client.months[mk];
              const kind = cellKind(cell);
              const rk = resetKind(mk, cell);
              const agreed = agreedForMonth(client, mk);
              const actions = canWrite ? monthActions(client, mk) : [];
              return (
                <tr key={mk}>
                  <td>
                    {monthLabelOf(mk)}
                    {kind && kind !== "computed" && <span className={`pg-acc-kind pg-acc-kind--${kind}`} title={CELL_KIND_HELP[kind]}>{CELL_KIND_LABEL[kind]}</span>}
                    {cell?.comment && <div className="pg-acc-ledger__comment">{cell.comment}</div>}
                    {rk && <div className="pg-acc-ledger__comment">{rk === "macro" ? "Macro-sheet reset" : "Write-off"}: carried {balanceText(cell.resetValue)}{cell.resetNote ? ` — ${cell.resetNote}` : ""}</div>}
                    {actions.length > 0 && (
                      <div className="pg-acc-actions">
                        {actions.map((a) => <button key={a} type="button" className="pg-btn-ghost" onClick={() => onAction(a, client, mk)}>{ACTION_LABEL[a]}</button>)}
                      </div>
                    )}
                  </td>
                  <td className={`pg-acc-num${cell?.hoursFlagged ? " pg-acc-flagged" : ""}`} title={cell?.hoursFlagged ? `Worked hours changed after the month closed${cell.flaggedFromHours != null ? ` (was ${fmtH(cell.flaggedFromHours)} h)` : ""}` : undefined}>
                    {cell?.hoursFlagged && <AlertTriangle size={11} style={{ marginRight: 3, verticalAlign: "-1px" }} />}
                    {fmtH(cell?.workedHours)}
                  </td>
                  <td className="pg-acc-num">{agreed ?? "—"}</td>
                  <td className="pg-acc-num">
                    <span className={cell?.accrualValue > 0 ? "pg-acc-pos" : cell?.accrualValue < 0 ? "pg-acc-neg" : undefined}>{cell?.accrualValue != null ? fmtH(cell.accrualValue) : "—"}</span>
                    {rk && <div className="pg-acc-ledger__comment">→ {fmtH(cell.resetValue)}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {monthsDesc.length > 12 && (
          <button type="button" className="pg-btn-ghost" style={{ marginTop: 8 }} onClick={() => setShowAll((s) => !s)}>
            {showAll ? "Show the last 12 months" : `Show all ${monthsDesc.length} months`}
          </button>
        )}
        <p className="pg-footnote">Balance: positive = over-serviced (hours used beyond the package), negative = unused package hours owed to the client.</p>
      </div>
    </aside>
  );
}
