import React, { useState, useEffect } from "react";
import { AlertTriangle, Info, Lock, ChevronLeft, ChevronRight, ChevronDown, Calendar, Radio, CheckCircle2 } from "lucide-react";
import { loadMyRoster } from "./capacityStore.js";
import { adelaideMonthKey } from "./dateMath.js";
import { isMissingRpcError } from "./permissions.js";
import { fetchMyWageMonths, fetchMyWageLine, fetchMyWageLive } from "./wagesSync.js";
import { selfWageView, selfLiveView, selfMonthOptions } from "./wagesView.js";
import { monthLabel } from "./wagesFormat.js";
import { WageCard } from "./WageCard.jsx";

// Billability Overview for a non-admin whose Wages scope is "own" (permissions.js): their own
// card, read-only. A closed month shows the signed-off snapshot (pginvoice_my_wage_line,
// 20261017_scoped_modules.sql); every other month from their first month to the current one
// is computed live from their own ClickUp time, leave and hours rule (pginvoice_my_wage_live,
// 20261026_my_wage_live.sql) with Xero always empty until the month is reviewed. Payroll
// tables stay admin-tier-only under RLS. No drawer, inputs, settings, Xero paste or close
// controls exist on this page at all.

function Notice({ tone = "warn", icon: Icon = AlertTriangle, children }) {
  return (
    <div className={`wr-banner wr-banner--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon size={14} aria-hidden="true" />
      <div className="wr-banner__body">{children}</div>
    </div>
  );
}

export default function WagesSelf({ personId }) {
  // months: null = loading; { list } | { unavailable } | { error }
  const [months, setMonths] = useState(null);
  const [monthKey, setMonthKey] = useState(null);
  const [result, setResult] = useState(null); // { monthKey, data } | { monthKey, error }
  // roster: null = loading; { person, capLeaves } (person null when not found) | { error }
  const [roster, setRoster] = useState(null);
  const current = adelaideMonthKey();

  useEffect(() => {
    if (!personId) return;
    let live = true;
    // The current month's live call also tells us how far back the picker goes (firstMonth).
    Promise.allSettled([fetchMyWageMonths(), fetchMyWageLive(current)]).then(([closedRes, liveRes]) => {
      if (!live) return;
      if (closedRes.status === "rejected") {
        setMonths(isMissingRpcError(closedRes.reason) ? { unavailable: true } : { error: closedRes.reason });
        return;
      }
      const list = closedRes.value;
      const firstMonth = liveRes.status === "fulfilled" ? liveRes.value?.firstMonth ?? null : null;
      setMonths({ list, options: selfMonthOptions({ firstMonth, currentMonth: current, closed: list }) });
      setMonthKey(current);
    });
    loadMyRoster().then(
      ({ people, leaves }) => { if (live) setRoster({ person: people.find((p) => p.id === personId) || null, capLeaves: leaves }); },
      (error) => { if (live) setRoster({ error }); },
    );
    return () => { live = false; };
  }, [personId, current]);

  const isClosed = !!months?.options?.find((o) => o.monthKey === monthKey)?.closed;
  useEffect(() => {
    if (!monthKey || !months?.options) return;
    let live = true;
    setResult(null);
    (isClosed ? fetchMyWageLine(monthKey) : fetchMyWageLive(monthKey)).then(
      (data) => { if (live) setResult({ monthKey, closed: isClosed, data }); },
      (error) => { if (live) setResult({ monthKey, error }); },
    );
    return () => { live = false; };
  }, [monthKey, months, isClosed]);

  const options = months?.options || [];
  const monthIndex = options.findIndex((o) => o.monthKey === monthKey);
  const photo = roster?.person?.photo || "";
  const ready = result && !result.error && result.monthKey === monthKey;
  const self = !ready ? null
    : result.closed ? selfWageView(result.data, { photo })
    : roster ? selfLiveView(result.data, { person: roster.person, capLeaves: roster.capLeaves, photo })
    : null;
  const monthText = monthKey ? monthLabel(monthKey) : "";

  let body;
  if (!personId) {
    body = <Notice icon={Info}>Your login isn't linked to a team member yet, so there's no wage card to show. Ask an admin to link you in Users.</Notice>;
  } else if (!months) {
    body = <div className="pg-empty">Loading…</div>;
  } else if (months.unavailable) {
    body = <Notice icon={Info}>Your wage card isn't available yet — this view is still being switched on.</Notice>;
  } else if (months.error) {
    body = <Notice tone="error">Couldn't load your wage months: {months.error.message || String(months.error)}</Notice>;
  } else {
    body = <>
      <div className="pg-pillbar wr-filters">
        {/* Same stepper as the admin page; the label is a styled <select> to jump straight to
            a month. options are newest first, so "previous" is the next index. */}
        <div className="pg-pill pg-pill--stepper" role="group" aria-label="Month">
          <button type="button" className="pg-pill__step" aria-label="Previous month" disabled={monthIndex < 0 || monthIndex >= options.length - 1}
            onClick={() => setMonthKey(options[monthIndex + 1].monthKey)}><ChevronLeft size={14} /></button>
          <label className="pg-pill__step-label wr-self-month">
            <Calendar size={13} className="pg-pill__icon" aria-hidden="true" />
            <select value={monthKey || ""} onChange={(e) => setMonthKey(e.target.value)} aria-label="Choose month">
              {options.map((o) => <option key={o.monthKey} value={o.monthKey}>{monthLabel(o.monthKey)}</option>)}
            </select>
            <ChevronDown size={13} className="pg-pill__chevron" aria-hidden="true" />
          </label>
          <button type="button" className="pg-pill__step" aria-label="Next month" disabled={monthIndex <= 0}
            onClick={() => setMonthKey(options[monthIndex - 1].monthKey)}><ChevronRight size={14} /></button>
        </div>
        {monthIndex >= 0 && (
          <span className={`wr-self-status${isClosed ? " is-reviewed" : ""}`}>
            {isClosed ? <CheckCircle2 size={13} aria-hidden="true" /> : <Radio size={13} aria-hidden="true" />}
            {isClosed ? "Reviewed" : "Live · not yet reviewed"}
          </span>
        )}
      </div>
      {result?.error ? (
        isMissingRpcError(result.error)
          ? <Notice icon={Info}>Your wage card isn't available yet — this view is still being switched on.</Notice>
          : <Notice tone="error">Couldn't load {monthText}: {result.error.message || String(result.error)}</Notice>
      ) : roster?.error && !result?.closed ? (
        <Notice tone="error">Couldn't load your roster record: {roster.error.message || String(roster.error)}</Notice>
      ) : !self ? (
        <div className="pg-empty">Loading…</div>
      ) : self.state === "not_reviewed" ? (
        <div className="pg-empty"><Lock size={14} aria-hidden="true" /> {monthText}: not yet reviewed. Your numbers appear once the month is closed.</div>
      ) : self.state === "not_included" ? (
        <div className="pg-empty">You weren't part of the billability review for {monthText}.</div>
      ) : self.state === "not_set_up" ? (
        <Notice icon={Info}>Your billability setup isn't finished yet, so there's nothing to show for {monthText}. Ask an admin to set you up in Billability Overview.</Notice>
      ) : self.state === "closed" ? (
        <Notice icon={Info}>{monthText} has just been reviewed. Reload the page to see the signed-off numbers.</Notice>
      ) : self.state === "live" ? (
        <>
          <Notice tone="info" icon={Info}>
            {monthText} hasn't been reviewed yet. These are live figures from your ClickUp time, leave and hours rule. Xero hours are added when the month is reviewed.
          </Notice>
          <div className="wr-grid wr-grid--self">
            <WageCard line={self.line} view={self.view} monthText={monthText} readOnly />
          </div>
        </>
      ) : (
        <>
          <Notice tone="ok" icon={CheckCircle2}>
            {monthText} was reviewed{self.closedAt ? ` on ${new Date(self.closedAt).toLocaleDateString("en-AU")}` : ""}. These are the signed-off numbers.
          </Notice>
          <div className="wr-grid wr-grid--self">
            <WageCard line={self.line} view={self.view} monthText={monthText} readOnly />
          </div>
        </>
      )}
    </>;
  }

  return (
    <div className="pg-cap-container wr">
      <div className="pg-app-header">
        <div>
          <span className="pg-eyebrow">Purple Giraffe</span>
          <h1 className="pg-app-header__title">My billability.</h1>
          <p className="pg-app-header__sub">Your tracked time, leave and expected hours for each month. Xero hours appear once a month is reviewed.</p>
        </div>
      </div>
      <div className="wr-self-body">{body}</div>
    </div>
  );
}
