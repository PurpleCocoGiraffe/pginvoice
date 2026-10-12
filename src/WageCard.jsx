import React, { useState, useCallback, useRef, useEffect, useId } from "react";
import {
  CheckCircle2, AlertTriangle, AlertCircle, TrendingUp, TrendingDown, Clock, MinusCircle, CalendarDays, CalendarClock,
  ArrowLeftRight, BarChart3, Scale, Info, MessageSquare, ChevronRight, Leaf, MoreHorizontal, Pencil,
} from "lucide-react";
import { PersonAvatar } from "./avatar.jsx";
import { useDismissable } from "./useDismissable.js";
import { DEFAULT_XERO_TOLERANCE_H, STANDARD_DAY_HOURS, round2 } from "./wagesCalc.js";
import { REVIEWER_FIELDS, COMMENT_FIELDS, adjustedExpected, variancePctOfAdjusted } from "./wagesView.js";
import { fmtH, fmtNum, fmtSigned, fmtDay, basisName } from "./wagesFormat.js";

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
// A titled card panel (caps title, purple icon, lavender meta label on the right).
export function Section({ icon: Icon, title, aside, children, className }) {
  return (
    <section className={"wr-sec" + (className ? ` ${className}` : "")}>
      <header className="wr-sec__head">
        {Icon && <Icon size={18} className="wr-sec__icon" aria-hidden="true" />}
        <h3 className="wr-sec__title">{title}</h3>
        {aside && <span className="wr-sec__aside">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

// "137.2 h" as a big number with a smaller lavender unit; "—" (no unit) for null.
function BigValue({ value, unit = "h", dp = 1, signed, className }) {
  if (value == null || !Number.isFinite(Number(value))) return <span className={"wr-big" + (className ? ` ${className}` : "")}>—</span>;
  const text = signed ? fmtSigned(value, dp).replace(/ h$/, "") : Number(value).toFixed(dp);
  return (
    <span className={"wr-big" + (className ? ` ${className}` : "")}>
      {text}{unit && <span className="wr-big__unit"> {unit}</span>}
    </span>
  );
}

// Leave-panel tile: round icon well on the left, caps label, big value, optional sub.
function IconTile({ icon: Icon, label, children, sub, title, ariaLabel }) {
  return (
    <div className="wr-itile" title={title} aria-label={ariaLabel} role={ariaLabel ? "group" : undefined}>
      <span className="wr-well" aria-hidden="true"><Icon size={20} /></span>
      <div className="wr-itile__body">
        <div className="wr-label">{label}</div>
        <div className="wr-itile__value">{children}</div>
        {sub && <div className="wr-sub">{sub}</div>}
      </div>
    </div>
  );
}

// Work-hours tile: small icon + caps label on top, big value, sub line.
function StatTile({ icon: Icon, label, children, sub, extra }) {
  return (
    <div className="wr-stile">
      <div className="wr-stile__head"><Icon size={16} aria-hidden="true" /><span className="wr-label">{label}</span></div>
      <div className="wr-stile__value">{children}</div>
      {sub && <div className="wr-sub">{sub}</div>}
      {extra}
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
// Full-timers (38 h/week, "FT" for the whole month) see leave and public holidays in
// days at the standard day; everyone else in hours, as they enter it.
const isFullTime = (line) => line.typeShort === "FT";
const dayUnit = (d) => (Number(d.toFixed(1)) === 1 ? "day" : "days");

function DaysOrHours({ line, hours, perDay }) {
  if (hours == null) return <BigValue value={null} />;
  if (isFullTime(line) && perDay > 0) {
    const d = Number(hours) / perDay;
    return <BigValue value={d} unit={dayUnit(d)} />;
  }
  return <BigValue value={hours} />;
}

// Adjusted expected as displayed: "= Xero" for an all-casual month before Xero is entered.
function AdjustedValue({ line }) {
  const adj = adjustedExpected(line);
  if (adj == null && line.expected?.allCasualXero && line.expected_override_h == null) return <span className="wr-big">= Xero</span>;
  return <BigValue value={adj} />;
}

export function LeaveSection({ line, month, perDay }) {
  const pd = Number(perDay) || STANDARD_DAY_HOURS;
  const holidays = line.expected?.holidays || [];
  const phNames = holidays.map((h) => `${h.name} (${fmtDay(h.date)})`).join(", ");
  const otherLeave = line.O > 0 || line.P > 0 ? `Sick / Personal ${fmtH(line.O)} · LWOP ${fmtH(line.P)}` : "No other leave recorded.";
  return (
    <Section icon={CalendarDays} title="Monthly leave and calendar adjustments" aside={month}>
      <div className="wr-tiles wr-tiles--3">
        <IconTile icon={Leaf} label="Annual leave" ariaLabel={`Annual leave ${fmtH(line.N)}`}>
          <DaysOrHours line={line} hours={line.N} perDay={pd} />
        </IconTile>
        <IconTile icon={CalendarDays} label="Public holiday" title={phNames || undefined}
          ariaLabel={`Public holiday ${fmtH(line.Q)}${phNames ? `: ${phNames}` : ""}${line.ph_override_h != null ? " (override)" : ""}`}
          sub={line.ph_override_h != null ? "Override" : undefined}>
          <DaysOrHours line={line} hours={line.Q} perDay={pd} />
        </IconTile>
        <IconTile icon={CalendarClock} label="Adjusted expected hours" sub="After leave and public holidays">
          <AdjustedValue line={line} />
        </IconTile>
      </div>
      <p className="wr-sec__foot">
        <Info size={15} aria-hidden="true" />
        <span>{otherLeave}</span>
      </p>
      {line.unspecified > 0 && (
        <p className="wr-chip wr-chip--warn">
          <AlertTriangle size={11} aria-hidden="true" /> Untyped leave {fmtH(line.unspecified)}{line.leave?.legacy ? " (legacy total)" : ""}: set a type in Consultants
        </p>
      )}
    </Section>
  );
}

function XeroLogo() {
  return (
    <svg className="wr-logo" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="24" fill="#13B5EA" />
      <text x="24" y="29.5" textAnchor="middle" fill="#fff" fontSize="15" fontWeight="600" fontFamily="Inter, Arial, sans-serif" letterSpacing="-0.3">xero</text>
    </svg>
  );
}

function ClickUpLogo() {
  const id = useId().replace(/:/g, "");
  return (
    <svg className="wr-logo" viewBox="0 0 48 48" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}a`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#FF02F0" /><stop offset="1" stopColor="#8930FD" /></linearGradient>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#49CCF9" /><stop offset="1" stopColor="#2CE5A0" /></linearGradient>
      </defs>
      <circle cx="24" cy="24" r="24" className="wr-logo__disc" />
      <path d="M15 23.5 L24 15.5 L33 23.5" fill="none" stroke={`url(#${id}a)`} strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 28.5 Q24 37 33 28.5" fill="none" stroke={`url(#${id}b)`} strokeWidth="4.2" strokeLinecap="round" />
    </svg>
  );
}

export function ReconSection({ line, settings }) {
  const tol = settings?.xero_tolerance_h ?? DEFAULT_XERO_TOLERANCE_H;
  let badge;
  if (line.L == null) badge = { cls: "muted", text: "Awaiting Xero", Icon: Clock };
  else if (line.flags?.xeroMismatch) badge = { cls: "amber", text: "Needs review", Icon: AlertCircle };
  else badge = { cls: "green", text: "Matches", Icon: CheckCircle2 };
  const diffTone = line.L == null ? "" : line.flags?.xeroMismatch ? " wr-tone-amber" : " wr-tone-green";
  const xeroSrc = line.L == null ? "Not entered yet" : line.xero_source === "paste" ? "Pasted from Xero" : "Entered manually";
  return (
    <Section icon={Clock} title="Time tracking reconciliation" aside="Hours this month">
      <div className="wr-recon">
        <div className="wr-recon__src" title={xeroSrc}>
          <XeroLogo />
          <div className="wr-recon__txt">
            <div className="wr-recon__label">Xero Total</div>
            <BigValue value={line.L} />
            {line.L == null && <div className="wr-sub">Awaiting Xero</div>}
          </div>
        </div>
        <ArrowLeftRight size={22} className="wr-recon__swap" aria-hidden="true" />
        <div className="wr-recon__src" title={line.flags?.noClickup ? "No ClickUp time this month" : undefined}>
          <ClickUpLogo />
          <div className="wr-recon__txt">
            <div className="wr-recon__label">ClickUp Total</div>
            <BigValue value={line.H} />
          </div>
        </div>
        <div className="wr-recon__diff">
          <div className="wr-recon__txt">
            <div className="wr-recon__label">Difference</div>
            <BigValue value={line.M} signed className={diffTone.trim()} />
          </div>
          <span className={`wr-badge wr-badge--${badge.cls}`} title={`Tolerance ±${fmtNum(tol, 2)} h`}>
            <badge.Icon size={14} aria-hidden="true" /> {badge.text}
          </span>
        </div>
      </div>
    </Section>
  );
}

// SVG ring: muted track + coloured progress arc (round caps). pct null -> empty ring.
const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R;
function Donut({ pct, tone, label }) {
  const p = pct == null ? 0 : Math.max(0, Math.min(1, pct));
  return (
    <div className={`wr-donut wr-donut--${tone}`} role="img" aria-label={label}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="wr-donut__track" cx="50" cy="50" r={RING_R} />
        {p > 0 && (
          <circle className="wr-donut__arc" cx="50" cy="50" r={RING_R}
            strokeDasharray={`${p * RING_C} ${RING_C}`} transform="rotate(-90 50 50)" />
        )}
      </svg>
      <div className="wr-donut__centre" aria-hidden="true">
        <span className="wr-donut__pct">{pct == null ? "—" : `${Math.round(pct * 100)}%`}</span>
        <span className="wr-donut__cap">Billable</span>
      </div>
    </div>
  );
}

// `base` is the percentage's denominator: every donut is a share of the person's whole
// ClickUp time (H), so PG % + Client % = Total % (owner's rule: client billable / total
// time logged), not a share of that donut's own PG or client total.
function DonutCard({ title, tone, base, total, totalLabel, billable, billableLabel, nonBillable, nonBillableLabel }) {
  const pct = base > 0 ? billable / base : null;
  const aria = base > 0
    ? `${title}: ${billableLabel} is ${Math.round(pct * 100)}% of all ClickUp time. ${totalLabel} ${fmtH(total)}, ${billableLabel} ${fmtH(billable)}, ${nonBillableLabel} ${fmtH(nonBillable)}`
    : `${title}: no time tracked`;
  return (
    <div className="wr-dcard">
      <div className="wr-dcard__title">{title}</div>
      <Donut pct={pct} tone={tone} label={aria} />
      <ul className="wr-dlegend">
        <li><Clock size={14} aria-hidden="true" className="wr-dlegend__icon" /><span>{totalLabel}</span><b>{fmtH(total)}</b></li>
        <li><span className={`wr-dlegend__dot wr-dlegend__dot--${tone}`} aria-hidden="true" /><span>{billableLabel}</span><span>{fmtH(billable)}</span></li>
        <li><span className="wr-dlegend__dot" aria-hidden="true" /><span>{nonBillableLabel}</span><span>{fmtH(nonBillable)}</span></li>
      </ul>
    </div>
  );
}

// D/E/F/G/H come from computeLine; the PG and client non-billable halves of G are the
// line's own split buckets (the same ClickUp buckets G is summed from).
export function BillableSection({ line }) {
  const sp = line.split || {};
  const pgNon = Number(sp.pgNonBillable) || 0;
  const clientNon = Number(sp.clientNonBillable) || 0;
  const E = Number(line.E) || 0;
  const F = Number(line.F) || 0;
  const H = Number(line.H) || 0;
  return (
    <Section icon={BarChart3} title="Billable breakdown">
      <div className="wr-donuts">
        <DonutCard title="Total time" tone="purple" base={H} total={H} totalLabel="Total Worked"
          billable={Number(line.D) || 0} billableLabel="Billable" nonBillable={Number(line.G) || 0} nonBillableLabel="Unbillable" />
        <DonutCard title="PG time" tone="purple" base={H} total={round2(E + pgNon)} totalLabel="Total PG Time"
          billable={E} billableLabel="PG Billable" nonBillable={pgNon} nonBillableLabel="PG Non-billable" />
        <DonutCard title="Client time" tone="green" base={H} total={round2(F + clientNon)} totalLabel="Total Client Time"
          billable={F} billableLabel="Client Billable" nonBillable={clientNon} nonBillableLabel="Client Non-billable" />
      </div>
      {sp.taskless > 0 && <p className="wr-sec__foot wr-sec__foot--small">of which no task (Private): {fmtH(sp.taskless)}</p>}
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

// Variance vs adjusted expected = L − (S − leave − Q) = T. Only shown where T is a real
// over/under; casual-equals-Xero and no-rule months say so instead of showing a number.
function VarianceBox({ line }) {
  let tone = "muted", main, sub;
  if (!line.varianceApplicable) {
    main = line.expected?.allCasualXero ? "n/a" : "—";
    sub = line.expected?.allCasualXero ? "casual" : line.expected?.missingRule ? "no hours rule" : "not assessed";
  } else if (line.T == null) {
    main = "—"; sub = "Awaiting Xero";
  } else {
    tone = line.flags?.over || line.flags?.under ? "amber" : "green";
    main = fmtSigned(line.T);
    const pct = variancePctOfAdjusted(line);
    sub = pct == null ? null : `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct * 100).toFixed(1)}%`;
  }
  return (
    <div className={`wr-varbox wr-varbox--${tone}`}>
      <span className="wr-varbox__main">{main}</span>
      {sub && <span className="wr-varbox__sub">{sub}</span>}
    </div>
  );
}

export function HoursSection({ line, view }) {
  const baseSub = line.expected_override_h != null ? "Override"
    : line.expected?.missingRule && line.expected?.segments?.length ? "Partial: some days have no rule"
      : "Standard monthly hours";
  return (
    <Section icon={TrendingUp} title="Work hours summary" aside="Hours this month">
      <div className="wr-tiles wr-tiles--4">
        <StatTile icon={CalendarDays} label="Base expected hours" sub={baseSub} extra={<ShowWorking line={line} view={view} />}>
          {line.S == null && line.expected?.allCasualXero && line.expected_override_h == null
            ? <span className="wr-big">= Xero</span> : <BigValue value={line.S} />}
        </StatTile>
        <StatTile icon={CalendarClock} label="Adjusted expected hours" sub="After leave and public holidays">
          <AdjustedValue line={line} />
        </StatTile>
        <StatTile icon={Clock} label="Actual worked hours" sub={line.L == null ? "Awaiting Xero" : "Xero timesheet total"}>
          <BigValue value={line.L} />
        </StatTile>
        <div className="wr-stile wr-stile--var">
          <div className="wr-stile__head"><Scale size={16} aria-hidden="true" /><span className="wr-label">Variance vs adjusted</span></div>
          <VarianceBox line={line} />
        </div>
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
// Today as YYYY-MM-DD in local time (string compare against the line's ISO dates).
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "Active", or the month's start/finish date: "Starts 13 Oct" / "Started 13 Oct",
// "Leaves 31 Oct" / "Left 14 Oct". A person who has already left isn't shown as online.
function presenceOf(line) {
  const lc = line.lifecycle || {};
  const today = todayKey();
  if (lc.left) {
    const past = lc.left < today;
    return { text: `${past ? "Left" : "Leaves"} ${fmtDay(lc.left)}`, tone: past ? "muted" : "amber", online: !past };
  }
  if (lc.started) {
    const future = lc.started > today;
    return { text: `${future ? "Starts" : "Started"} ${fmtDay(lc.started)}`, tone: future ? "amber" : "green", online: !future };
  }
  return { text: "Active", tone: "green", online: true };
}

const CARD_ACTIONS = [
  { tab: "recon", label: "Open details", icon: ChevronRight },
  { tab: "inputs", label: "Edit hours and overrides", icon: Pencil },
  { tab: "review", label: "Review comments", icon: MessageSquare },
];

// "•••" actions menu. Choosing an item hands focus back to the trigger first, so the
// drawer restores focus there on close (the menu item itself unmounts).
function CardMenu({ line, onOpen }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismissable(close);
  const btnRef = useRef(null);
  const itemRefs = useRef([]);
  const menuId = `wr-menu-${line.person_id}`;
  useEffect(() => { if (open) itemRefs.current[0]?.focus(); }, [open]);
  const onMenuKey = (e) => {
    const i = itemRefs.current.indexOf(document.activeElement);
    const n = CARD_ACTIONS.length;
    let next = null;
    if (e.key === "ArrowDown") next = (i + 1) % n;
    else if (e.key === "ArrowUp") next = (i - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btnRef.current?.focus(); return; }
    else if (e.key === "Tab") { setOpen(false); return; }
    if (next == null) return;
    e.preventDefault();
    itemRefs.current[next]?.focus();
  };
  return (
    <div className="wr-menuwrap" ref={ref}>
      <button type="button" ref={btnRef} className="wr-more" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        aria-label={`Actions for ${line.name}`} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal size={22} aria-hidden="true" />
      </button>
      {open && (
        <div className="pg-menu wr-menu" id={menuId} role="menu" aria-label={`Actions for ${line.name}`} onKeyDown={onMenuKey}>
          {CARD_ACTIONS.map((a, i) => (
            <button key={a.tab} type="button" role="menuitem" tabIndex={-1} className="pg-menu-item" ref={(el) => { itemRefs.current[i] = el; }}
              onClick={() => { setOpen(false); btnRef.current?.focus(); onOpen(line.person_id, a.tab); }}>
              <a.icon size={14} aria-hidden="true" /> {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function WageCard({ line, view, monthText, onOpen }) {
  const n = commentCount(line);
  const pres = presenceOf(line);
  const lc = line.lifecycle || {};
  return (
    <article className="wr-card" aria-label={`${line.name} wage reconciliation`}>
      <header className="wr-card__head">
        <span className="wr-card__avatar">
          <PersonAvatar name={line.name} photo={line.photo} size={64} style={{ width: "clamp(46px, 13cqi, 64px)", height: "clamp(46px, 13cqi, 64px)" }} />
          {pres.online && <span className="wr-card__online" title="Active this month"><span className="wr-sr">Active this month</span></span>}
        </span>
        <div className="wr-card__who">
          <h2 className="wr-card__name">{line.name}</h2>
          <div className="wr-card__meta">
            {line.role && <span className="wr-role">{line.role}</span>}
            <span className={`wr-presence wr-presence--${pres.tone}`}><span className="wr-presence__dot" aria-hidden="true" />{pres.text}</span>
          </div>
          <div className="wr-card__chips">
            <StatusPill status={line.status} compact />
            <span className="wr-chip">{[line.typeShort || "No rule", line.state || "?"].join(" · ")}</span>
            {lc.hoursChanged && <span className="wr-chip">Hours changed {fmtDay(lc.hoursChanged)}</span>}
          </div>
        </div>
        <CardMenu line={line} onOpen={onOpen} />
      </header>
      <LeaveSection line={line} month={monthText} perDay={view.perDay} />
      <ReconSection line={line} settings={view.settings} />
      <BillableSection line={line} />
      <HoursSection line={line} view={view} />
      <footer className="wr-card__foot">
        <ReviewDots line={line} />
        <span className="wr-card__count"><MessageSquare size={12} aria-hidden="true" /> {n}<span className="wr-sr"> comments</span></span>
        <button type="button" className="wr-card__details" onClick={() => onOpen(line.person_id)}>
          Details <ChevronRight size={14} aria-hidden="true" />
        </button>
      </footer>
    </article>
  );
}
