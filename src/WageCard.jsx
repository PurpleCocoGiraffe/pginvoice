import React, { useState, useCallback, useRef } from "react";
import {
  CheckCircle2, AlertTriangle, TrendingUp, TrendingDown, Clock, MinusCircle, CalendarDays, ArrowLeftRight,
  BarChart3, Scale, Info, MessageSquare, ChevronRight,
} from "lucide-react";
import { PersonAvatar } from "./avatar.jsx";
import { useDismissable } from "./useDismissable.js";
import { DEFAULT_XERO_TOLERANCE_H } from "./wagesCalc.js";
import { REVIEWER_FIELDS, COMMENT_FIELDS } from "./wagesView.js";
import { fmtH, fmtNum, fmtSigned, fmtPct, fmtDay, basisName } from "./wagesFormat.js";

/* ---------------------------------------------------------------- status --------------- */
export const STATUS_META = {
  ok: { label: "Within tolerance", short: "OK", icon: CheckCircle2, tone: "var(--status-ok)" },
  check_sync: { label: "Check sync", short: "Check sync", icon: AlertTriangle, tone: "var(--status-over)" },
  over: { label: "Over", short: "Over", icon: TrendingUp, tone: "var(--status-warn)" },
  under: { label: "Under", short: "Under", icon: TrendingDown, tone: "var(--status-warn)" },
  awaiting_xero: { label: "Awaiting Xero", short: "Awaiting Xero", icon: Clock, tone: "var(--fg-tertiary)" },
  not_assessed: { label: "Not assessed", short: "Not assessed", icon: MinusCircle, tone: "var(--fg-tertiary)" },
};

// Icon + text, tinted fill; the text itself stays --fg-primary so it holds contrast in
// both themes (status colours are used only as the icon colour and a soft fill).
export function StatusPill({ status, compact }) {
  const m = STATUS_META[status] || STATUS_META.not_assessed;
  const Icon = m.icon;
  return (
    <span className={"wr-status" + (compact ? " wr-status--compact" : "")} style={{ "--tone": m.tone }}>
      <Icon size={12} aria-hidden="true" style={{ color: m.tone }} />
      {compact ? m.short : m.label}
    </span>
  );
}

/* ---------------------------------------------------------------- tabs ----------------- */
// Accessible tab strip: roving tabindex, Left/Right (and Home/End) move between tabs and
// select them. Each tab controls the panel rendered with tabPanelProps(idBase, key).
export function TabBar({ tabs, active, onChange, idBase, label }) {
  const refs = useRef({});
  const onKeyDown = (e) => {
    const i = tabs.findIndex((t) => t.key === active);
    let n = null;
    if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = tabs.length - 1;
    if (n == null) return;
    e.preventDefault();
    onChange(tabs[n].key);
    refs.current[tabs[n].key]?.focus();
  };
  return (
    <div className="pg-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const selected = t.key === active;
        const Icon = t.icon;
        return (
          <button key={t.key} ref={(el) => { refs.current[t.key] = el; }} type="button" role="tab"
            id={`${idBase}-tab-${t.key}`} aria-selected={selected} aria-controls={`${idBase}-panel-${t.key}`} tabIndex={selected ? 0 : -1}
            className={"pg-tab" + (selected ? " pg-tab--active" : "")} onClick={() => onChange(t.key)}>
            {Icon && <Icon size={13} aria-hidden="true" />} {t.label}
          </button>
        );
      })}
    </div>
  );
}
export const tabPanelProps = (idBase, key) => ({ role: "tabpanel", id: `${idBase}-panel-${key}`, "aria-labelledby": `${idBase}-tab-${key}`, tabIndex: 0 });

/* ---------------------------------------------------------------- building blocks ------ */
export function Section({ icon: Icon, title, aside, children }) {
  return (
    <section className="wr-sec">
      <header className="wr-sec__head">
        {Icon && <span className="wr-sec__icon" aria-hidden="true"><Icon size={13} /></span>}
        <h3 className="wr-sec__title">{title}</h3>
        {aside && <span className="wr-sec__aside">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

function Tile({ label, value, sub, title, children, emphasis }) {
  return (
    <div className={"wr-tile" + (emphasis ? " wr-tile--emphasis" : "")} title={title}>
      <div className="wr-tile__label">{label}</div>
      <div className="wr-tile__value">{value}</div>
      {sub && <div className="wr-tile__sub">{sub}</div>}
      {children}
    </div>
  );
}

const SPLIT_PARTS = [
  { key: "clientBillable", label: "Client billed", col: "F", color: "var(--wr-c1)" },
  { key: "pgBillable", label: "PG billed", col: "E", color: "var(--wr-c2)" },
  { key: "clientNonBillable", label: "Client non-billable", color: "var(--wr-c3)" },
  { key: "pgNonBillable", label: "PG non-billable", color: "var(--wr-c4)" },
];

// One 100% stacked bar of ClickUp total H, split four ways.
export function StackedBar({ line }) {
  const total = Number(line.H) || 0;
  const parts = SPLIT_PARTS.map((p) => ({ ...p, h: Number(line.split?.[p.key]) || 0 }));
  const aria = total > 0
    ? `Billable breakdown of ${total.toFixed(1)} tracked hours: ${parts.map((p) => `${p.label} ${p.h.toFixed(1)} h`).join(", ")}`
    : "No ClickUp time tracked this month";
  return (
    <div>
      <div className="wr-bar" role="img" aria-label={aria}>
        {total > 0 && parts.map((p) => p.h > 0 && (
          <span key={p.key} className="wr-bar__seg" style={{ width: `${(p.h / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <ul className="wr-legend">
        {parts.map((p) => (
          <li key={p.key}>
            <span className="wr-legend__swatch" style={{ background: p.color }} aria-hidden="true" />
            <span className="wr-legend__label">{p.label}</span>
            <span className="wr-legend__value">{fmtH(p.h)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// "Show working" for expected hours S and public holidays Q: a real button (not
// hover-only) that opens a small popover listing the segment workings.
export function ShowWorking({ line, view }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismissable(close);
  const e = line.expected || {};
  return (
    <span className="wr-working" ref={ref}>
      <button type="button" className="wr-linkbtn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Info size={11} aria-hidden="true" /> Show working
      </button>
      {open && (
        <div className="wr-popover" role="dialog" aria-label={`Expected hours working for ${line.name}`}>
          {view && <p className="wr-popover__muted">Standard month: {view.weekdays} weekdays × {fmtNum(view.perDay, 1)} = {fmtNum(view.standardHours, 1)} h</p>}
          {(e.segments || []).length === 0 && <p>No hours rule covers this month.</p>}
          {(e.segments || []).map((s, i) => (
            <div key={i} className="wr-popover__seg">
              <div className="wr-popover__seg-head">{fmtDay(s.from)}–{fmtDay(s.to)} · {basisName(s.basis)}</div>
              <div>S: {s.working}</div>
              <div className="wr-popover__muted">Q: {s.qWorking}</div>
            </div>
          ))}
          {(e.holidays || []).length > 0 && (
            <p>Public holidays counted: {e.holidays.map((h) => `${h.name} (${fmtDay(h.date)})`).join(", ")}</p>
          )}
          {e.missingRule && <p className="wr-popover__warn">Some employed days have no hours rule, so over/under isn't assessed.</p>}
          {e.unknownState && <p className="wr-popover__warn">State "{line.state || "?"}" isn't SA/WA/QLD: no public holidays applied.</p>}
          {line.ph_override_h != null && <p>Q overridden to {fmtH(line.ph_override_h, 2)}.</p>}
          {line.expected_override_h != null && <p>S overridden to {fmtH(line.expected_override_h, 2)}: {line.expected_override_reason}</p>}
        </div>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- card sections -------- */
export function LeaveSection({ line, month }) {
  const lv = line.leave || {};
  const days = (t) => (lv.days?.[t] ? ` (${fmtNum(lv.days[t], lv.days[t] % 1 ? 1 : 0)} d)` : "");
  const phNames = (line.expected?.holidays || []).map((h) => `${h.name} (${fmtDay(h.date)})`).join(", ");
  return (
    <Section icon={CalendarDays} title="Leave and public holidays" aside={month}>
      <div className="wr-tiles wr-tiles--4">
        <Tile label="Annual leave" value={fmtH(line.N)} sub={days("annual").trim() || " "} />
        <Tile label="Sick / Personal" value={fmtH(line.O)} sub={days("personal").trim() || " "} />
        <Tile label="LWOP" value={fmtH(line.P)} sub={days("lwop").trim() || " "} />
        <Tile label="Public holiday" value={fmtH(line.Q)} title={phNames || undefined}
          sub={line.ph_override_h != null ? "override" : (phNames ? `${line.expected.holidays.length} day${line.expected.holidays.length === 1 ? "" : "s"}` : "none")} />
      </div>
      {phNames && <p className="wr-note">{phNames}</p>}
      {line.unspecified > 0 && (
        <p className="wr-chip wr-chip--warn">
          <AlertTriangle size={11} aria-hidden="true" /> Untyped leave {fmtH(line.unspecified)}{line.leave?.legacy ? " (legacy total)" : ""}: set a type in Consultants
        </p>
      )}
    </Section>
  );
}

export function ReconSection({ line, settings }) {
  const tol = settings?.xero_tolerance_h ?? DEFAULT_XERO_TOLERANCE_H;
  let statusText, StatusIcon, tone;
  if (line.L == null) { statusText = "Awaiting Xero"; StatusIcon = Clock; tone = "var(--fg-tertiary)"; }
  else if (line.flags?.xeroMismatch) { statusText = "Check"; StatusIcon = AlertTriangle; tone = "var(--status-over)"; }
  else { statusText = "Matches"; StatusIcon = CheckCircle2; tone = "var(--status-ok)"; }
  const xeroSrc = line.L == null ? "not entered" : line.xero_source === "paste" ? "pasted" : "manual";
  return (
    <Section icon={ArrowLeftRight} title="Time tracking reconciliation" aside="Hours this month">
      <div className="wr-recon">
        <div className="wr-recon__side">
          <span className="wr-badge">Xero</span>
          <div className="wr-recon__value">{fmtH(line.L, 2)}</div>
          <div className="wr-tile__sub">{xeroSrc}</div>
        </div>
        <ArrowLeftRight size={14} className="wr-recon__swap" aria-hidden="true" />
        <div className="wr-recon__side">
          <span className="wr-badge">ClickUp</span>
          <div className="wr-recon__value">{fmtH(line.H, 2)}</div>
          <div className="wr-tile__sub">auto{line.flags?.noClickup ? " · no time" : ""}</div>
        </div>
        <div className="wr-recon__diff">
          <div className="wr-tile__label">Difference</div>
          <div className="wr-recon__value">{fmtSigned(line.M, 2)}</div>
          <div className="wr-recon__status">
            <StatusIcon size={12} style={{ color: tone }} aria-hidden="true" /> {statusText}
            {line.L != null && <span className="wr-tile__sub"> · tolerance ±{fmtNum(tol, 2)} h</span>}
          </div>
        </div>
      </div>
    </Section>
  );
}

export function BillableSection({ line }) {
  return (
    <Section icon={BarChart3} title="Billable breakdown" aside={`${fmtH(line.H)} tracked`}>
      <StackedBar line={line} />
      <p className="wr-note wr-note--strong">Client billed {fmtPct(line.J)} · All billable {fmtPct(line.K)}</p>
      {line.split?.taskless > 0 && <p className="wr-note">of which no task (Private): {fmtH(line.split.taskless)}</p>}
    </Section>
  );
}

export function overUnderText(line) {
  if (!line.varianceApplicable) {
    if (line.expected?.allCasualXero) return { value: "n/a", sub: "casual", icon: null };
    return { value: "n/a", sub: line.expected?.missingRule ? "no hours rule" : "not assessed", icon: null };
  }
  if (line.T == null) return { value: "—", sub: "awaiting Xero", icon: null };
  const t = Number(line.T);
  const word = t > 0 ? "over" : t < 0 ? "under" : "on target";
  const pct = line.Tpct != null ? ` · ${line.Tpct > 0 ? "+" : ""}${(line.Tpct * 100).toFixed(1)}%` : "";
  return { value: `${t > 0 ? "▲" : t < 0 ? "▼" : ""} ${Math.abs(t).toFixed(1)} h`.trim(), sub: `${word}${pct}`, icon: t > 0 ? TrendingUp : t < 0 ? TrendingDown : null };
}

// Expected S as displayed: "= Xero" for an all-casual month before Xero is entered,
// otherwise S itself ("—" when null, e.g. no hours rule covers the month).
export function expectedText(line) {
  if (line.S == null && line.expected?.allCasualXero && line.expected_override_h == null) return "= Xero";
  return fmtH(line.S);
}

export function HoursSection({ line, view }) {
  const ou = overUnderText(line);
  const tone = line.status === "over" || line.status === "under" ? "var(--status-warn)" : line.status === "ok" ? "var(--status-ok)" : "var(--fg-tertiary)";
  return (
    <Section icon={Scale} title="Work hours summary" aside="Hours this month">
      <div className="wr-tiles wr-tiles--4">
        <Tile label="Expected" value={expectedText(line)}
          sub={line.expected_override_h != null ? "override" : line.expected?.missingRule && line.expected?.segments?.length ? "partial: some days have no rule" : "should be"}>
          <ShowWorking line={line} view={view} />
        </Tile>
        <Tile label="Accounted" value={fmtH(line.R)} sub="Xero + leave + PH" />
        <Tile label="Xero worked" value={fmtH(line.L)} sub={line.L == null ? "not entered" : " "} />
        <Tile label="Over / under" value={ou.value} sub={ou.sub} emphasis>
          <span className="wr-tile__tone" style={{ background: tone }} aria-hidden="true" />
        </Tile>
      </div>
    </Section>
  );
}

export function commentCount(line) {
  return COMMENT_FIELDS.filter((k) => line[k] && String(line[k]).trim()).length;
}
export function ReviewDots({ line }) {
  return (
    <span className="wr-dots">
      {REVIEWER_FIELDS.map((r) => {
        const done = !!(line[r.key] && String(line[r.key]).trim());
        return (
          <span key={r.key} className={"wr-dot" + (done ? " wr-dot--done" : "")} title={`${r.label}: ${done ? "commented" : "no comment yet"}`}>
            <span className="wr-dot__mark" aria-hidden="true" />{r.short}
            <span className="wr-sr">{done ? " commented" : " no comment"}</span>
          </span>
        );
      })}
    </span>
  );
}

export function PersonChips({ line }) {
  const lc = line.lifecycle || {};
  return (
    <div className="wr-chips">
      <span className="wr-chip">{[line.typeShort || "No rule", line.state || "?"].join(" · ")}</span>
      {lc.started && <span className="wr-chip">Started {fmtDay(lc.started)}</span>}
      {lc.left && <span className="wr-chip">Left {fmtDay(lc.left)}</span>}
      {lc.hoursChanged && <span className="wr-chip">Hours changed {fmtDay(lc.hoursChanged)}</span>}
    </div>
  );
}

/* ---------------------------------------------------------------- the card ------------- */
export function WageCard({ line, view, monthText, onOpen }) {
  const n = commentCount(line);
  return (
    <article className="wr-card" aria-label={`${line.name} wage reconciliation`}>
      <header className="wr-card__head">
        <PersonAvatar name={line.name} photo={line.photo} size={44} />
        <div className="wr-card__who">
          <h2 className="wr-card__name">{line.name}</h2>
          <div className="wr-card__meta">
            {line.role && <span className="wr-role">{line.role}</span>}
          </div>
        </div>
        <StatusPill status={line.status} />
      </header>
      <PersonChips line={line} />
      <LeaveSection line={line} month={monthText} />
      <ReconSection line={line} settings={view.settings} />
      <BillableSection line={line} />
      <HoursSection line={line} view={view} />
      <footer className="wr-card__foot">
        <ReviewDots line={line} />
        <span className="wr-card__count"><MessageSquare size={12} aria-hidden="true" /> {n}<span className="wr-sr"> comments</span></span>
        <button type="button" className="pg-btn-ghost wr-card__details" onClick={() => onOpen(line.person_id)}>
          Details <ChevronRight size={12} aria-hidden="true" />
        </button>
      </footer>
    </article>
  );
}
