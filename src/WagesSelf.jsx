import React, { useState, useEffect } from "react";
import { AlertTriangle, Info, Lock } from "lucide-react";
import { loadState } from "./capacityStore.js";
import { CAP_PEOPLE_KEY } from "./storageKeys.js";
import { adelaideMonthKey, adelaideDayOfMonth } from "./dateMath.js";
import { isMissingRpcError } from "./permissions.js";
import { fetchMyWageMonths, fetchMyWageLine } from "./wagesSync.js";
import { selfWageView } from "./wagesView.js";
import { monthLabel } from "./wagesFormat.js";
import { WageCard } from "./WageCard.jsx";

// Wages review for a non-admin whose Wages scope is "own" (permissions.js): their own card,
// read-only, for months the admin team has closed. Everything comes from two SECURITY DEFINER
// RPCs (20261017_scoped_modules.sql) that return only the caller's own snapshot line --
// payroll tables stay admin-tier-only under RLS. A month that isn't closed shows "Not yet
// reviewed" and no numbers (never zeros). No drawer, inputs, settings, Xero paste or close
// controls exist on this page at all.

const shiftMonth = (mk, d) => {
  const [y, m] = mk.split("-").map(Number);
  const t = y * 12 + (m - 1) + d;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
// Same "month being reviewed" rule as WagesReview.jsx: last month until the 15th.
function reviewMonth() {
  const cur = adelaideMonthKey();
  return adelaideDayOfMonth() <= 15 ? shiftMonth(cur, -1) : cur;
}

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
  const [photo, setPhoto] = useState("");
  const pending = reviewMonth();

  useEffect(() => {
    if (!personId) return;
    let live = true;
    fetchMyWageMonths().then(
      (list) => { if (!live) return; setMonths({ list }); setMonthKey(list[0]?.monthKey ?? pending); },
      (error) => { if (!live) return; setMonths(isMissingRpcError(error) ? { unavailable: true } : { error }); },
    );
    // The roster photo is display-only; a failed read just shows initials.
    loadState(CAP_PEOPLE_KEY, null).then(
      (people) => { if (live) setPhoto((Array.isArray(people) ? people : []).find((p) => p.id === personId)?.photo || ""); },
      () => {},
    );
    return () => { live = false; };
  }, [personId, pending]);

  useEffect(() => {
    if (!monthKey) return;
    let live = true;
    setResult(null);
    fetchMyWageLine(monthKey).then(
      (data) => { if (live) setResult({ monthKey, data }); },
      (error) => { if (live) setResult({ monthKey, error }); },
    );
    return () => { live = false; };
  }, [monthKey]);

  const closedKeys = new Set((months?.list || []).map((m) => m.monthKey));
  // Closed months, plus the month currently under review so the person can see it's pending.
  const options = months?.list
    ? [...(closedKeys.has(pending) ? [] : [{ monthKey: pending, pending: true }]), ...months.list]
        .sort((a, b) => (a.monthKey < b.monthKey ? 1 : -1))
    : [];
  const self = result && !result.error && result.monthKey === monthKey ? selfWageView(result.data, { photo }) : null;
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
        <label className="pg-pill">
          <span className="wr-sr">Month</span>
          <select value={monthKey || ""} onChange={(e) => setMonthKey(e.target.value)} aria-label="Month">
            {options.map((o) => (
              <option key={o.monthKey} value={o.monthKey}>{monthLabel(o.monthKey)}{o.pending ? " · not yet reviewed" : ""}</option>
            ))}
          </select>
        </label>
      </div>
      {!months.list.length && <Notice icon={Info}>No months have been reviewed and closed yet. Your card appears here once a month is signed off.</Notice>}
      {result?.error ? (
        isMissingRpcError(result.error)
          ? <Notice icon={Info}>Your wage card isn't available yet — this view is still being switched on.</Notice>
          : <Notice tone="error">Couldn't load {monthText}: {result.error.message || String(result.error)}</Notice>
      ) : !self ? (
        <div className="pg-empty">Loading…</div>
      ) : self.state === "not_reviewed" ? (
        <div className="pg-empty"><Lock size={14} aria-hidden="true" /> {monthText}: not yet reviewed. Your numbers appear once the month is closed.</div>
      ) : self.state === "not_included" ? (
        <div className="pg-empty">You weren't part of the wages review for {monthText}.</div>
      ) : (
        <>
          <p className="pg-footnote">
            {monthText} was closed{self.closedAt ? ` on ${new Date(self.closedAt).toLocaleDateString("en-AU")}` : ""}. These are the signed-off numbers.
          </p>
          <div className="wr-grid">
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
          <h1 className="pg-app-header__title">My wages.</h1>
          <p className="pg-app-header__sub">Your reviewed hours for each closed month: tracked time, Xero, leave and expected hours.</p>
        </div>
      </div>
      {body}
    </div>
  );
}
