import React, { useState, useEffect } from "react";
import { LayoutDashboard, FileText, BarChart3, TrendingUp, CalendarDays, Clock, Users, Building2, Sun, Moon, LogOut, ChevronLeft, ChevronRight, Settings, Plug, HelpCircle, Menu, X, MoreHorizontal, Handshake } from "lucide-react";
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
import UsersPage from "./Users.jsx";
import ForcePasswordChange from "./ForcePasswordChange.jsx";
import { supabase } from "./supabaseClient.js";
import { fetchCostCentres } from "./clientsSync.js";
import { setDynamicCostCentres } from "./nameMatch.js";
import { PG_DATA_EVENT } from "./idbStore.js";
import { PG_COST_CENTRES_KEY } from "./storageKeys.js";
import { fetchOwnProfile, ROLE_LABELS, ADMIN_TIER_ROLES, CLIENT_SCOPED_ROLES } from "./usersSync.js";

// Nav order/labels follow the approved Purple Giraffe Design OS mockup.
// Consultant/Coordinator (client-scoped roles) only get a subset — see
// CLIENT_SCOPED_MODULE_KEYS below. Everything here is the full, Admin-tier nav.
const MODULES = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "invoicing", label: "Client Invoicing", icon: FileText },
  { key: "capacity", label: "Capacity Planning", icon: BarChart3 },
  { key: "team", label: "Consultants", icon: Users },
  { key: "clients", label: "Clients", icon: Building2 },
  { key: "timesheet", label: "Timesheets", icon: CalendarDays },
  { key: "accruals", label: "Client Accruals", icon: Clock },
  { key: "performance", label: "Reporting", icon: TrendingUp },
  { key: "bdm", label: "BDM", icon: Handshake },
];
// What Consultant/Coordinator can see: Overview, Clients, Client Accruals,
// Reporting only — real enforcement is the RLS scoping to their assigned
// clients (usersSync/pginvoice_rbac migration), this is just matching nav to it.
const CLIENT_SCOPED_MODULE_KEYS = new Set(["overview", "clients", "accruals", "performance"]);
// Mobile bottom tab bar: the 4 most-used modules, short labels so 5 tabs
// (these plus "More") fit comfortably on a phone-width bar.
const BOTTOM_NAV_MODULES = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "invoicing", label: "Invoicing", icon: FileText },
  { key: "capacity", label: "Capacity", icon: BarChart3 },
  { key: "team", label: "Team", icon: Users },
];
// Present in the approved nav, but no real functionality behind them yet —
// each renders an honest "not built" placeholder rather than fake content.
const SECONDARY_MODULES = [
  { key: "settings", label: "Settings", icon: Settings },
  { key: "integrations", label: "Integrations", icon: Plug },
  { key: "help", label: "Help", icon: HelpCircle },
];
// Users management: Super Admin + Admin only (spec: "Super Admins have access
// to integration and all other features. Admins have access to all other
// features" — Integrations is Super Admin-only, Users is both admin tiers).
const USERS_MODULE = { key: "users", label: "Users", icon: Users };

const THEME_KEY = "pg-theme";

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

const COLLAPSE_KEY = "pg-sidebar-collapsed";

export default function Shell() {
  // null = still checking for an existing session (avoids a login-screen flash
  // for someone who's already signed in); false/session once known.
  const [session, setSession] = useState(null);
  // null = still loading; false = loaded but no pginvoice_profiles row (no access).
  const [profile, setProfile] = useState(null);
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

  // Own role + (if client-scoped) assigned clients — decides which nav items
  // render. The actual data access restriction happens at the RLS layer
  // regardless of what's shown here; this just keeps the UI honest about it.
  useEffect(() => {
    if (!session) { setProfile(session === false ? false : null); return; }
    let cancelled = false;
    const reload = () => fetchOwnProfile().then((p) => { if (!cancelled) setProfile(p ?? false); });
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
  if (profile === null) return null; // brief check, avoids a nav flash of the wrong scope
  if (!profile) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 16, textAlign: "center" }}>
        <div>
          <p>Your account isn't set up with access yet. Ask a Super Admin to add you in Users.</p>
          <button className="pg-btn" onClick={() => supabase.auth.signOut()} style={{ marginTop: 12 }}>Sign out</button>
        </div>
      </div>
    );
  }
  if (profile.mustChangePassword) {
    return <ForcePasswordChange userId={profile.userId} onDone={() => setProfile((p) => ({ ...p, mustChangePassword: false }))} />;
  }

  const isClientScoped = CLIENT_SCOPED_ROLES.has(profile.role);
  const isAdminTier = ADMIN_TIER_ROLES.has(profile.role);
  const isSuperAdmin = profile.role === "super_admin";
  const visibleModules = isClientScoped ? MODULES.filter((m) => CLIENT_SCOPED_MODULE_KEYS.has(m.key)) : MODULES;
  const visibleBottomNav = isClientScoped ? BOTTOM_NAV_MODULES.filter((m) => CLIENT_SCOPED_MODULE_KEYS.has(m.key)) : BOTTOM_NAV_MODULES;
  const visibleSecondary = isClientScoped
    ? []
    : SECONDARY_MODULES.filter((m) => m.key !== "integrations" || isSuperAdmin);
  if (isAdminTier) visibleSecondary.push(USERS_MODULE);
  if (isClientScoped && !CLIENT_SCOPED_MODULE_KEYS.has(active)) { setActive("overview"); return null; }

  const username = session.user?.email?.split("@")[0] || "Account";
  const logOut = () => { supabase.auth.signOut(); };

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
            state alive across tab switches. Client-scoped roles (Consultant/
            Coordinator) don't even mount the modules outside their nav — no
            point fetching data for a page they can't reach, on top of RLS
            already scoping what comes back. */}
        <div style={{ display: active === "overview" ? "block" : "none" }}><Overview /></div>
        {!isClientScoped && <>
          <div style={{ display: active === "invoicing" ? "block" : "none" }}><PGReconciliation onNavigateClients={() => setActive("clients")} /></div>
          <div style={{ display: active === "capacity" ? "block" : "none" }}><CapacityDashboard onNavigateTeam={() => setActive("team")} /></div>
          <div style={{ display: active === "team" ? "block" : "none" }}><TeamDashboard /></div>
          <div style={{ display: active === "timesheet" ? "block" : "none" }}><TimesheetSummary /></div>
          <div style={{ display: active === "bdm" ? "block" : "none" }}>
            <PlaceholderPage title="BDM." subtitle="Business development tracking isn't built yet." icon={Handshake} empty="BDM module coming soon." />
          </div>
        </>}
        <div style={{ display: active === "performance" ? "block" : "none" }}><PerformanceScorecard /></div>
        <div style={{ display: active === "accruals" ? "block" : "none" }}><ClientAccruals /></div>
        <div style={{ display: active === "clients" ? "block" : "none" }}><Clients /></div>
        {!isClientScoped && <>
          <div style={{ display: active === "settings" ? "block" : "none" }}>
            <PlaceholderPage title="Settings." subtitle="Workspace preferences aren't built yet." icon={Settings} empty="Settings module coming soon." />
          </div>
          {isSuperAdmin && <div style={{ display: active === "integrations" ? "block" : "none" }}><SettingsPage /></div>}
          <div style={{ display: active === "help" ? "block" : "none" }}>
            <PlaceholderPage title="Help." subtitle="Documentation and support aren't built yet." icon={HelpCircle} empty="Help module coming soon." />
          </div>
          {isAdminTier && <div style={{ display: active === "users" ? "block" : "none" }}><UsersPage ownRole={profile.role} ownUserId={profile.userId} /></div>}
        </>}
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
