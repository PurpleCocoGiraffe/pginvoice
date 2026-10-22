import React, { useState, useEffect, useMemo } from "react";
import { fetchClients } from "./clientsSync.js";
import { fetchAccrualsFromSupabase } from "./accrualsSync.js";
import { fetchClickupFromSupabase } from "./clickupSync.js";
import { loadKey, SEED_PEOPLE, last6MonthKeys } from "./capacityData.js";
import { loadMyRoster } from "./capacityStore.js";
import { CAP_PEOPLE_KEY, CAP_LEAVES_KEY } from "./storageKeys.js";
import { CLIENT_TYPE_LABELS } from "./nameMatch.js";
import { LineChart } from "./LineChart.jsx";
import { OverviewKpiCard } from "./OverviewKpiCard.jsx";
import { OverviewList } from "./OverviewList.jsx";
import {
  activeClientStats, overServicedFromAccruals, accrualHealth, NEGATIVE_BALANCE_THRESHOLD_HRS,
  teamMonthlyTotals, teamUtilization, overUtilizedConsultants, OVER_UTILIZATION_PCT,
  sixMonthTrend, clientTypeMix, filterToActiveClients,
} from "./overviewData.js";

function fmt0(n) { return (n === null || n === undefined || isNaN(n)) ? "—" : Math.round(n).toLocaleString(); }
function fmt1(n) { return (n === null || n === undefined || isNaN(n)) ? "—" : n.toFixed(1); }
function pct0(n) { return (n === null || n === undefined || isNaN(n)) ? "—" : `${Math.round(n)}%`; }

function monthLabelShort(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "short", year: "2-digit" });
}

function SkeletonGrid() {
  return (
    <>
      <div className="ov-kpi-grid">
        {[0, 1, 2, 3].map((i) => <div key={i} className="ov-card ov-kpi ov-skeleton" />)}
      </div>
      <div className="ov-row">
        <div className="ov-card ov-trend ov-skeleton" style={{ minHeight: 300 }} />
        <div className="ov-card ov-skeleton" style={{ minHeight: 300 }} />
      </div>
      <div className="ov-lists">
        <div className="ov-card ov-skeleton" style={{ minHeight: 180 }} />
        <div className="ov-card ov-skeleton" style={{ minHeight: 180 }} />
      </div>
    </>
  );
}

// Cross-module rollup landing page — loads live data from every module's own
// source of truth (Supabase tables + the shared roster) and computes every
// metric via overviewData.js's pure functions. Never fabricates a number when
// the underlying data is genuinely absent: a metric with no real input renders
// an explicit "no data yet" message instead of a 0 or NaN (see the original
// placeholder's own principle — an honest "not built yet" page rather than
// fabricated KPIs — carried forward here per-card even though the page itself
// is now built).
//
// `scope` (Overview scope "assigned", permissions.js; null = the whole business, exactly as
// before): { clients, personId, userNames }. Client counts, accrual health and the trend
// count only the user's clients (each client's real figures); hours and utilisation are the
// linked person's own; team-wide cards (team range, over-utilized consultants) are hidden.
// userNames null = pginvoice_my_access() predates clickupUserNames -> own hours "not available yet".
// The scope is applied in ONE layer, the pure overviewData.js functions -- this component
// never filters by it itself: client rows via activeClientStats / clientTypeMix, accrual
// rows once via filterToActiveClients (everything accrual-derived reads that list), ClickUp
// via teamMonthlyTotals / teamUtilization.
// `scope` is memoized by Shell (permissions.js moduleScopeProps), so it is a stable dependency.
export default function Overview({ scope = null }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [clients, setClients] = useState([]);
  const [accrualClients, setAccrualClients] = useState(null); // null = no data on file at all
  const [people, setPeople] = useState(SEED_PEOPLE);
  const [clickup, setClickup] = useState(null);
  const [leaves, setLeaves] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // allSettled, not all -- a single flaky source (e.g. the ClickUp sync having
      // a bad moment) must not wipe out clients/accruals/roster data that loaded
      // fine, which Promise.all's fail-fast behavior would otherwise do. Each card
      // below already renders its own honest "no data yet" state per source, so
      // showing what did load (with a banner naming what didn't) is strictly more
      // correct than blanking everything on one unrelated failure.
      // last6MonthKeys() is newest-first; the oldest of the 6 is the earliest month
      // this page ever needs, so the ClickUp fetch can skip the other 9+ months of
      // history (47k+ rows total) sitting in the table.
      const earliestNeededMonth = last6MonthKeys()[5];
      // Scoped: only the user's own ClickUp rows (exact spellings); unknown spellings -> none.
      const clickupSource = !scope ? fetchClickupFromSupabase(earliestNeededMonth)
        : scope.userNames ? fetchClickupFromSupabase(earliestNeededMonth, { userNames: scope.userNames })
        : Promise.resolve(null);
      // Scoped: Capacity data is admin-only, so the user's own roster record and leave come
      // from pginvoice_my_roster() (capacityStore.loadMyRoster) -- one call for both.
      const myRoster = scope ? loadMyRoster() : null;
      const sources = [
        ["clients", fetchClients()],
        ["accruals", fetchAccrualsFromSupabase()],
        ["team roster", myRoster ? myRoster.then((r) => r.people) : loadKey(CAP_PEOPLE_KEY, SEED_PEOPLE)],
        ["ClickUp sync", clickupSource],
        ["leave records", myRoster ? myRoster.then((r) => r.leaves) : loadKey(CAP_LEAVES_KEY, {})],
      ];
      const results = await Promise.allSettled(sources.map(([, p]) => p));
      if (cancelled) return;

      const [clRes, accrualsRes, pplRes, cuRes, lvRes] = results;
      if (clRes.status === "fulfilled") setClients(clRes.value || []);
      if (accrualsRes.status === "fulfilled") setAccrualClients(accrualsRes.value);
      if (pplRes.status === "fulfilled") setPeople(pplRes.value || SEED_PEOPLE);
      if (cuRes.status === "fulfilled") setClickup(cuRes.value || null);
      if (lvRes.status === "fulfilled") setLeaves(lvRes.value || {});

      const failed = results
        .map((r, i) => (r.status === "rejected" ? sources[i][0] : null))
        .filter(Boolean);
      if (failed.length) setLoadError(failed.join(", "));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [scope]);

  // Six-month trailing window, newest last — the canonical "recent" window
  // every other module already uses (capacityData.js's last6MonthKeys).
  const monthKeys = useMemo(() => last6MonthKeys().slice().reverse(), []);
  const latestMonth = monthKeys[monthKeys.length - 1];

  // Every client-scoped metric below counts/uses ACTIVE clients only, matching the
  // Clients module's own definition (status === "active") — pginvoice_clients has
  // three real statuses (active/offboarded/archived), and accrual rows carry no
  // status of their own, so both the client list and the accrual rows need this
  // same filter or an archived client's stale numbers silently skew the business
  // totals (confirmed: this page was showing 68 "active" clients — 42 active + 26
  // archived — against the Clients module's correctly-scoped 42).
  // The pure functions' scope: the user's clients + their linked roster person.
  const personName = scope ? (people.find((p) => p.id === scope.personId)?.name ?? null) : null;
  const dataScope = useMemo(
    () => (scope ? { clients: scope.clients || [], personName, userNames: scope.userNames || [] } : null),
    [scope, personName]
  );
  const activeClients = useMemo(() => clients.filter((c) => c.status === "active"), [clients]);
  const activeAccrualClients = useMemo(() => filterToActiveClients(accrualClients, clients, dataScope), [accrualClients, clients, dataScope]);

  const clientStats = useMemo(() => activeClientStats(clients, dataScope), [clients, dataScope]);
  const overServiced = useMemo(
    () => (activeAccrualClients ? overServicedFromAccruals(activeAccrualClients, latestMonth) : { overServiced: 0, withData: 0 }),
    [activeAccrualClients, latestMonth]
  );
  const health = useMemo(() => accrualHealth(activeAccrualClients), [activeAccrualClients]);
  const teamMonthly = useMemo(() => teamMonthlyTotals(people, clickup, monthKeys, dataScope), [people, clickup, monthKeys, dataScope]);
  // leaveHrsByPerson is keyed by name (per computeMonthlyAvailability's caller
  // contract), but cap_leaves is keyed by personId_monthKey -- convert for the
  // one month utilization actually needs, same as Capacity Planning/Team already
  // do. Omitting this (as the page did before) meant Overview's utilization was
  // always higher than the true figure, since nobody's leave was ever subtracted.
  const leaveHrsByName = useMemo(() => {
    const m = {};
    for (const p of people) m[p.name] = Number(leaves[`${p.id}_${latestMonth}`] || 0);
    return m;
  }, [people, leaves, latestMonth]);
  const utilization = useMemo(() => teamUtilization(people, teamMonthly, latestMonth, leaveHrsByName, dataScope), [people, teamMonthly, latestMonth, leaveHrsByName, dataScope]);
  const overUtilized = useMemo(() => overUtilizedConsultants(utilization.perConsultant), [utilization]);
  const trend = useMemo(() => sixMonthTrend(activeAccrualClients, clickup?.rows, monthKeys), [activeAccrualClients, clickup, monthKeys]);
  const typeMix = useMemo(() => clientTypeMix(activeClients, dataScope), [activeClients, dataScope]);

  const hasClients = clients.length > 0;
  const scoped = !!dataScope;
  // Scoped "My utilization" card: why there's no figure, when there isn't one.
  const ownUtil = utilization.perConsultant[0] || null;
  const ownHoursNote = !scoped ? null
    : scope.userNames == null ? "not available yet"
    : !scope.personId ? "no team member linked to your login"
    : !personName ? "your team member isn't on the roster"
    : !ownUtil ? "no logged time or availability this month"
    : null;
  const hasAccruals = !!activeAccrualClients && activeAccrualClients.length > 0;
  const hasTeamData = utilization.perConsultant.length > 0;
  const hasTrend = trend.months.length > 0;

  const typeMixEntries = useMemo(
    () => Object.entries(typeMix).sort((a, b) => b[1] - a[1]),
    [typeMix]
  );
  const topType = typeMixEntries[0];

  const trendSeries = useMemo(() => ([
    { label: "Over-serviced clients", color: "var(--status-over)", points: trend.overServicedCounts },
    { label: "Total accrued hours", color: "var(--accent)", points: trend.totalAccruedHours },
  ]), [trend]);

  const overUtilizedItems = useMemo(() => overUtilized.map((c) => ({
    key: c.name, name: c.name, badge: pct0(c.pct), tone: "var(--status-over)",
  })), [overUtilized]);

  const negativeBalanceItems = useMemo(() => health.negativeList.map((c) => ({
    key: c.client, name: c.client, badge: `${fmt1(c.balance)} h`, tone: "var(--status-warn)",
  })), [health.negativeList]);

  return (
    <div className="pg-app">
      <div className="pg-container">
        <div className="pg-app-header">
          <div>
            <span className="pg-eyebrow">Purple Giraffe · Internal</span>
            <h1 className="pg-app-header__title">Overview.</h1>
            <p className="pg-app-header__sub">
              {scoped
                ? "A live snapshot of your clients and your own hours — your clients' accruals and your utilization this month."
                : "A live cross-module snapshot of the whole business — clients, accruals, and team utilization, pulled straight from Client Invoicing, Client Accruals, and Capacity Planning's own data."}
            </p>
          </div>
        </div>

        {loadError && (
          <div className="pg-banner-warn">Couldn't load some Overview data: {loadError}. Figures below may be incomplete.</div>
        )}

        {loading ? (
          <SkeletonGrid />
        ) : (
          <>
            <div className="ov-kpi-grid">
              <OverviewKpiCard
                index={0}
                primaryLabel={scoped ? "My active clients" : "Active clients"}
                primary={hasClients ? fmt0(clientStats.active) : "—"}
                secondary={hasAccruals ? (overServiced.withData > 0 ? `${fmt0(overServiced.overServiced)} over-serviced` : "—") : null}
                secondaryLabel={
                  hasAccruals
                    ? (overServiced.withData > 0 ? `of ${fmt0(overServiced.withData)} with data this month` : "no data for this month yet")
                    : (!hasClients ? "no client data yet" : undefined)
                }
              />
              <OverviewKpiCard
                index={1}
                primaryLabel="Accrual balance (net)"
                primary={hasAccruals ? `${fmt1(health.netHours)} h` : "—"}
                tone={hasAccruals && health.netHours < 0 ? "var(--status-warn)" : undefined}
                secondary={hasAccruals ? fmt0(health.negativeCount) : null}
                secondaryLabel={hasAccruals ? `client${health.negativeCount === 1 ? "" : "s"} below -${NEGATIVE_BALANCE_THRESHOLD_HRS}h` : "no accrual data yet"}
                sparkline={hasTrend ? trend.totalAccruedHours : null}
                sparklineColor="var(--status-warn)"
              />
              {scoped ? (
                <OverviewKpiCard
                  index={2}
                  primaryLabel="My utilization"
                  primary={ownUtil ? pct0(ownUtil.pct) : "—"}
                  secondary={ownUtil ? `${fmt1(ownUtil.billable)} h` : null}
                  secondaryLabel={ownUtil ? `billable of ${fmt1(ownUtil.available)} h available this month` : ownHoursNote}
                />
              ) : (
                <OverviewKpiCard
                  index={2}
                  primaryLabel="Team utilization"
                  primary={hasTeamData ? pct0(utilization.avgPct) : "—"}
                  secondary={hasTeamData ? `${pct0(utilization.minPct)}–${pct0(utilization.maxPct)}` : null}
                  secondaryLabel={hasTeamData ? "range across the team" : "no ClickUp data loaded yet"}
                />
              )}
              <OverviewKpiCard
                index={3}
                primaryLabel="Client type mix"
                primary={topType ? CLIENT_TYPE_LABELS[topType[0]] || topType[0] : "—"}
                secondary={topType ? `${fmt0(topType[1])} of ${fmt0(clientStats.active)}` : null}
                secondaryLabel={topType ? "clients on the most common type" : (!hasClients ? "no client data yet" : undefined)}
              />
            </div>

            <div className="ov-row">
              <div className="ov-card ov-trend" style={{ ["--i"]: 4 }}>
                <div className="ov-trend__title">6-month trend</div>
                {hasTrend ? (
                  <>
                    <LineChart series={trendSeries} months={trend.months} />
                    <p className="pg-footnote" style={{ marginTop: 6 }}>
                      Months with no matching accrual data are omitted rather than shown as a fabricated zero — {trend.months.length} of the trailing {monthKeys.length} months have data.
                    </p>
                  </>
                ) : (
                  <div className="pg-empty">No accrual data yet to chart a trend — upload/sync Client Accruals to see this fill in.</div>
                )}
              </div>

              <div className="ov-card" style={{ padding: "20px 22px", ["--i"]: 5 }}>
                <div className="ov-trend__title">Client type mix</div>
                {hasClients ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
                    {typeMixEntries.map(([type, count]) => (
                      <div key={type} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0", borderBottom: "1px dashed var(--border-soft)" }}>
                        <span style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--fg-secondary)" }}>{CLIENT_TYPE_LABELS[type] || type}</span>
                        <span className="pg-stat__value" style={{ fontSize: 16 }}>{fmt0(count)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="pg-empty">No clients loaded yet.</div>
                )}
              </div>
            </div>

            <div className="ov-lists">
              {!scoped && (
                <OverviewList
                  index={6}
                  title={`Over-utilized consultants (≥${OVER_UTILIZATION_PCT}%)`}
                  items={overUtilizedItems}
                  emptyMessage={hasTeamData ? "No consultants currently over-utilized." : "No ClickUp/roster data yet to compute utilization."}
                />
              )}
              <OverviewList
                index={7}
                title={`Clients below -${NEGATIVE_BALANCE_THRESHOLD_HRS}h balance`}
                items={negativeBalanceItems}
                emptyMessage={hasAccruals ? "No clients with a meaningful negative balance." : "No accrual data yet."}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
