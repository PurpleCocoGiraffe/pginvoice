import React, { useState, useEffect } from "react";
import { LayoutDashboard, FileText, BarChart3, TrendingUp, CalendarDays, Clock, Users, Building2, Sun, Moon, LogOut, ChevronLeft, ChevronRight, Settings, HelpCircle, Menu, X, MoreHorizontal, Handshake, Wallet } from "lucide-react";
import Overview from "./Overview.jsx";
import PlaceholderPage from "./PlaceholderPage.jsx";
import PGReconciliation from "./App.jsx";
import CapacityDashboard from "./CapacityDashboard.jsx";
import PerformanceScorecard from "./PerformanceScorecard.jsx";
import TimesheetSummary from "./TimesheetSummary.jsx";
import ClientAccruals from "./ClientAccruals.jsx";
import Clients from "./Clients.jsx";
import TeamDashboard from "./TeamDashboard.jsx";
import SettingsPage from "./Settings.jsx";
import WagesReview from "./WagesReview.jsx";
import ForcePasswordChange from "./ForcePasswordChange.jsx";
import { supabase } from "./supabaseClient.js";
import { fetchCostCentres } from "./clientsSync.js";
import { setDynamicCostCentres } from "./nameMatch.js";
import { PG_DATA_EVENT, idbClear } from "./idbStore.js";
import { ensureCacheOwner, releaseCacheOwner } from "./cacheOwner.js";
import { PG_COST_CENTRES_KEY, THEME_KEY, COLLAPSE_KEY } from "./storageKeys.js";
import { fetchOwnProfile, fetchOwnAccess, ROLE_LABELS } from "./usersSync.js";
import { visibleNav, bottomNavFor, reachableKeys, canSee, settingsTabsFor, accessFromRole, isMissingRpcError } from "./permissions.js";

// Which nav items a user gets comes from permissions.js (driven by pginvoice_my_access());
// this only adds the icons. Order/labels live there and are pinned by permissions.test.js.
const NAV_ICONS = {
  overview: LayoutDashboard, invoicing: FileText, capacity: BarChart3, team: Users, clients: Building2,
  timesheet: CalendarDays, accruals: Clock, performance: TrendingUp, wages: Wallet, bdm: Handshake,
  settings: Settings, help: HelpCircle,
};
const withIcon = (m) => ({ ...m, icon: NAV_ICONS[m.key] });

// Effective access for a freshly-fetched profile. Until the 20261016_user_permissions
// migration is applied the RPC doesn't exist, so access is derived from role exactly as
// before; any other failure keeps this user's previous access (a refocus blip mustn't
// change the nav) or, on first load, null -> an error screen rather than a guessed nav.
function resolveAccess(profile, result, prev) {
  if (result.error) {
    if (isMissingRpcError(result.error)) return accessFromRole(profile.role, profile.clients);
    console.warn("Couldn't load module access", result.error);
    return prev && prev.userId === profile.userId ? prev.access ?? null : null;
  }
  // Profile but no access row would be a race with a delete -- show nothing rather than guess.
  return result.access ?? { role: profile.role, isAdminTier: false, modules: {}, clients: [] };
}

// Real Supabase Auth — checked server-side. Every pginvoice_* table's RLS
// policy requires the `authenticated` role, so signing in here is what
// actually unlocks data access, not just a client-side gate on the UI.
function LoginGate({ onSuccess }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });
      setSubmitting(false);
      if (authError) {
        // Wrong credentials come back as a 400 with this exact reason -- everything
        // else (outage, rate limit, network hiccup) gets its real message instead of
        // being flattened to "wrong password", which just told a user hitting a real
        // outage to keep retrying the same credentials forever.
        setError(authError.status === 400 ? "Incorrect email or password." : (authError.message || "Sign-in failed. Please try again."));
        return;
      }
      onSuccess(data.session);
    } catch (e) {
      setSubmitting(false);
      setError("Couldn't reach the server. Check your connection and try again.");
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "var(--bg-base)", padding: 16 }}>
      <form onSubmit={submit} className="pg-cap-card" style={{ width: 320, maxWidth: "100%", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 4 }}>
          <img src="/assets/giraffe-mark.png" alt="Purple Giraffe" style={{ height: 44, width: "auto" }} />
        </div>
        <label className="pg-field">
          <span className="pg-field__label">Email</span>
          <input className="pg-input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </label>
        <label className="pg-field">
          <span className="pg-field__label">Password</span>
          <input className="pg-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <p className="pg-footnote" style={{ color: "var(--status-over)" }}>{error}</p>}
        <button className="pg-btn" type="submit" disabled={submitting} style={{ justifyContent: "center" }}>{submitting ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}

export default function Shell() {
  // null = still checking for an existing session (avoids a login-screen flash
  // for someone who's already signed in); false/session once known.
  const [session, setSession] = useState(null);
  // null = still loading; false = loaded but no pginvoice_profiles row (no access).
  // Otherwise the profile plus `access` (permissions.js shape; null = couldn't load it).
  const [profile, setProfile] = useState(null);
  // User id whose cached data (IndexedDB + user-data localStorage) has been verified as
  // theirs -- modules don't mount until this matches the session, see cacheOwner.js.
  const [cacheReadyFor, setCacheReadyFor] = useState(null);
  // Set when that wipe failed: fail closed rather than mount over someone else's data.
  const [cacheError, setCacheError] = useState(null);
  const [active, setActive] = useState("overview");
  const [theme, setTheme] = useState(() => {
    try { return window.localStorage.getItem(THEME_KEY) || "light"; } catch (e) { return "light"; }
  });
  const [collapsed, setCollapsed] = useState(() => {
    try { return window.localStorage.getItem(COLLAPSE_KEY) === "1"; } catch (e) { return false; }
  });
  // Mobile only — the sidebar becomes a compact top bar (brand + hamburger) below
  // 760px, and this opens it as a full-screen sheet instead of the desktop
  // collapse-to-icons behavior, per §15 "navigation becomes a sheet" on mobile.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const goTo = (key) => { setActive(key); setMobileNavOpen(false); };

  // Applied on <html> (not just the shell) so the whole document — including anything
  // rendered outside .pg-shell, like a future modal or the browser's own UI chrome via
  // color-scheme — picks up the theme, not just the app content.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme;
    try { window.localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  }, [theme]);

  useEffect(() => {
    try { window.localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch (e) {}
  }, [collapsed]);

  // supabase-js persists the session in localStorage and auto-refreshes the
  // token, so this also covers "already signed in from a previous visit"
  // and "signed out in another tab" without extra plumbing.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? false));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => setSession(newSession ?? false));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Wipe the previous user's cached data before any module mounts (they read it on mount).
  // Every user change (including sign-out) starts unverified, so the same user signing
  // back in after an explicit sign-out waits for the re-clear too.
  const userId = session?.user?.id ?? null;
  useEffect(() => {
    setCacheReadyFor(null);
    setCacheError(null);
    setProfile(null); // don't render the new user's modules with the previous user's role/nav
    if (!userId) return;
    let cancelled = false;
    ensureCacheOwner(userId, { storage: window.localStorage, clearIdb: idbClear })
      .then(() => { if (!cancelled) setCacheReadyFor(userId); })
      .catch((e) => { console.error("Couldn't clear the previous user's cached data", e); if (!cancelled) setCacheError(e); });
    return () => { cancelled = true; };
  }, [userId]);

  // Explicit sign-out also wipes the cache, so nothing is left at rest for whoever uses
  // this browser next. Sign out first so the modules unmount and can't write it back.
  const logOut = async () => {
    let error = null;
    try { ({ error } = await supabase.auth.signOut()); } catch (e) { error = e; }
    // Offline with an expired token, the global sign-out returns an error and keeps the
    // stored session -- drop it locally instead (no network call), which emits SIGNED_OUT.
    if (error) { try { await supabase.auth.signOut({ scope: "local" }); } catch (e) { /* ignore */ } }
    releaseCacheOwner({ storage: window.localStorage, clearIdb: idbClear })
      .catch((e) => console.warn("Couldn't clear cached data on sign-out", e));
  };

  // Own role + effective module access (pginvoice_my_access) — decides which nav items
  // render and which modules mount. The actual data access restriction happens at the
  // RLS layer regardless of what's shown here; this just keeps the UI honest about it.
  useEffect(() => {
    if (!session) { setProfile(session === false ? false : null); return; }
    let cancelled = false;
    const reload = async () => {
      const [p, result] = await Promise.all([
        fetchOwnProfile(),
        fetchOwnAccess().then((access) => ({ access }), (error) => ({ error })),
      ]);
      if (cancelled) return;
      if (!p) { setProfile(false); return; }
      setProfile((prev) => ({ ...p, access: resolveAccess(p, result, prev) }));
    };
    reload();
    // An admin changing someone's role while they have a tab open otherwise leaves
    // that tab's nav stale until a manual reload -- refetch on refocus so the common
    // case (switch away, come back) picks it up without needing a realtime subscription.
    window.addEventListener("focus", reload);
    return () => { cancelled = true; window.removeEventListener("focus", reload); };
  }, [session]);

  // The user-editable cost-centre/sub-project links (pginvoice_cost_centres, managed from
  // the Clients module) -- fetched once here at the top, rather than by each page that
  // needs it, since every page is mounted simultaneously (just hidden via CSS below) and
  // nameMatch.js's matching functions are a synchronous singleton fed by setDynamicCostCentres,
  // not something each caller fetches for itself. Requires a session (RLS needs an
  // authenticated user), so this only runs once logged in.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const load = () => fetchCostCentres().then((rows) => { if (!cancelled) setDynamicCostCentres(rows); }).catch(() => {});
    load();
    const onUpdate = (e) => { if (!e.detail || e.detail.key === PG_COST_CENTRES_KEY) load(); };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => { cancelled = true; window.removeEventListener(PG_DATA_EVENT, onUpdate); };
  }, [session]);

  if (session === null) return null; // brief check, avoids a login-screen flash
  if (!session) return <LoginGate onSuccess={setSession} />;
  if (cacheError) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 16, textAlign: "center" }}>
        <div>
          <p>Couldn't clear data saved in this browser by a previous account. Reload to try again.</p>
          <button className="pg-btn" onClick={() => window.location.reload()} style={{ marginTop: 12, marginRight: 8 }}>Reload</button>
          <button className="pg-btn" onClick={logOut} style={{ marginTop: 12 }}>Sign out</button>
        </div>
      </div>
    );
  }
  if (!userId || cacheReadyFor !== userId) return null; // brief: previous user's cache being cleared
  if (profile === null) return null; // brief check, avoids a nav flash of the wrong scope
  if (!profile) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 16, textAlign: "center" }}>
        <div>
          <p>Your account isn't set up with access yet. Ask an Admin to add you in Settings → Users &amp; permissions.</p>
          <button className="pg-btn" onClick={logOut} style={{ marginTop: 12 }}>Sign out</button>
        </div>
      </div>
    );
  }
  if (profile.mustChangePassword) {
    return <ForcePasswordChange userId={profile.userId} onDone={() => setProfile((p) => ({ ...p, mustChangePassword: false }))} />;
  }

  const access = profile.access;
  if (!access) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 16, textAlign: "center" }}>
        <div>
          <p>Couldn't load what your account can access. Check your connection and reload.</p>
          <button className="pg-btn" onClick={() => window.location.reload()} style={{ marginTop: 12, marginRight: 8 }}>Reload</button>
          <button className="pg-btn" onClick={logOut} style={{ marginTop: 12 }}>Sign out</button>
        </div>
      </div>
    );
  }
  const nav = visibleNav(access);
  const visibleModules = nav.modules.map(withIcon);
  const visibleSecondary = nav.secondary.map(withIcon);
  const visibleBottomNav = bottomNavFor(access).map(withIcon);
  const settingsTabs = settingsTabsFor(access);
  const reachable = reachableKeys(access);
  if (!reachable.length) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 16, textAlign: "center" }}>
        <div>
          <p>No modules have been turned on for your account yet. Ask an Admin to grant access in Settings → Users &amp; permissions.</p>
          <button className="pg-btn" onClick={logOut} style={{ marginTop: 12 }}>Sign out</button>
        </div>
      </div>
    );
  }
  // Redirect guard: access can shrink while a tab is open (refetched on focus).
  if (!reachable.includes(active)) { setActive(reachable[0]); return null; }
  const show = (key) => ({ display: active === key ? "block" : "none" });

  const username = session.user?.email?.split("@")[0] || "Account";

  return (
    <div className="pg-shell">
      {mobileNavOpen && <div className="pg-sidebar-backdrop" onClick={() => setMobileNavOpen(false)} />}
      <aside className={"pg-sidebar" + (collapsed ? " pg-sidebar--collapsed" : "") + (mobileNavOpen ? " pg-sidebar--mobile-open" : "")}>
        <div className="pg-sidebar__brand">
          <img
            src={collapsed
              ? (theme === "dark" ? "/assets/pg-icon-reverse.png" : "/assets/pg-icon-normal.png")
              : (theme === "dark" ? "/assets/pg-wordmark-reverse.png" : "/assets/pg-wordmark-normal.png")}
            alt="Purple Giraffe"
            className="pg-sidebar__brand-logo"
          />
          <button
            className="pg-sidebar__icon-btn pg-sidebar__desktop-only"
            style={{ marginLeft: "auto" }}
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          </button>
          <button
            className="pg-sidebar__mobile-toggle"
            onClick={() => setMobileNavOpen((o) => !o)}
            aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
          >
            {mobileNavOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
        <div className="pg-sidebar__scroll">
          <nav className="pg-sidebar__nav">
            {visibleModules.map((m) => (
              <button
                key={m.key}
                className={"pg-sidebar__link" + (active === m.key ? " pg-sidebar__link--active" : "")}
                onClick={() => goTo(m.key)}
                title={collapsed ? m.label : undefined}
              >
                <m.icon size={16} />
                <span className="pg-sidebar__hide-collapsed">{m.label}</span>
              </button>
            ))}
          </nav>

          <nav className="pg-sidebar__nav" style={{ marginTop: "auto" }}>
            {visibleSecondary.map((m) => (
              <button
                key={m.key}
                className={"pg-sidebar__link" + (active === m.key ? " pg-sidebar__link--active" : "")}
                onClick={() => goTo(m.key)}
                title={collapsed ? m.label : undefined}
              >
                <m.icon size={16} />
                <span className="pg-sidebar__hide-collapsed">{m.label}</span>
              </button>
            ))}
          </nav>

          <div className="pg-sidebar__profile" title={collapsed ? username : undefined}>
            <div className="pg-sidebar__avatar">{username.slice(0, 1).toUpperCase()}</div>
            <div className="pg-sidebar__profile-text pg-sidebar__hide-collapsed">
              <div className="pg-sidebar__profile-name">{username}</div>
              <div className="pg-sidebar__profile-role">{ROLE_LABELS[profile.role] || profile.role}</div>
            </div>
          </div>

          <div className="pg-sidebar__footer-row">
            <button
              className="pg-sidebar__icon-btn"
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label="Toggle dark / light mode"
            >
              {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            <button
              className="pg-sidebar__icon-btn"
              onClick={logOut}
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
      <main className="pg-shell__main">
        {/* All modules stay mounted at once — switching tabs used to unmount the
            inactive one and wipe its in-memory state (an uploaded CSV, filters,
            etc). Hiding with CSS instead of conditional rendering keeps that
            state alive across tab switches. Only modules this user can open are
            mounted at all — no point fetching data for a page they can't reach,
            on top of RLS already scoping what comes back. */}
        {canSee(access, "overview") && <div style={show("overview")}><Overview /></div>}
        {canSee(access, "invoicing") && <div style={show("invoicing")}><PGReconciliation onNavigateClients={() => setActive("clients")} /></div>}
        {canSee(access, "capacity") && <div style={show("capacity")}><CapacityDashboard onNavigateTeam={() => setActive("team")} /></div>}
        {canSee(access, "team") && <div style={show("team")}><TeamDashboard /></div>}
        {canSee(access, "timesheet") && <div style={show("timesheet")}><TimesheetSummary /></div>}
        {canSee(access, "bdm") && (
          <div style={show("bdm")}>
            <PlaceholderPage title="BDM." subtitle="Business development tracking isn't built yet." icon={Handshake} empty="BDM module coming soon." />
          </div>
        )}
        {canSee(access, "performance") && <div style={show("performance")}><PerformanceScorecard /></div>}
        {canSee(access, "accruals") && <div style={show("accruals")}><ClientAccruals /></div>}
        {canSee(access, "clients") && <div style={show("clients")}><Clients /></div>}
        {canSee(access, "wages") && <div style={show("wages")}><WagesReview /></div>}
        {reachable.includes("settings") && (
          <div style={show("settings")}><SettingsPage tabs={settingsTabs} ownRole={profile.role} ownUserId={profile.userId} /></div>
        )}
        {reachable.includes("help") && (
          <div style={show("help")}>
            <PlaceholderPage title="Help." subtitle="Documentation and support aren't built yet." icon={HelpCircle} empty="Help module coming soon." />
          </div>
        )}
      </main>
      {/* Mobile only (see .pg-bottom-nav's media query) -- a persistent bottom
          tab bar instead of the sidebar's hamburger, matching how a native
          mobile app surfaces primary navigation. Only room for a handful of
          tabs, so this shows the four most-used modules plus a "More" tab
          that reuses the same full-screen sheet the (now desktop-only)
          hamburger opens, rather than building a second nav-list UI. */}
      <nav className="pg-bottom-nav">
        {visibleBottomNav.map((m) => (
          <button
            key={m.key}
            className={"pg-bottom-nav__link" + (active === m.key ? " pg-bottom-nav__link--active" : "")}
            onClick={() => goTo(m.key)}
          >
            <m.icon size={20} />
            <span>{m.label}</span>
          </button>
        ))}
        <button
          className={"pg-bottom-nav__link" + (mobileNavOpen ? " pg-bottom-nav__link--active" : "")}
          onClick={() => setMobileNavOpen((o) => !o)}
        >
          <MoreHorizontal size={20} />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}
