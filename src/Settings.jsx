import React, { useEffect, useState } from "react";
import { Settings as SettingsIcon, Users as UsersIcon, Plug } from "lucide-react";
import { TabBar, tabPanelProps } from "./WageCard.jsx";
import UsersPanel from "./Users.jsx";
import Integrations from "./Integrations.jsx";

const TAB_ICONS = { users: UsersIcon, integrations: Plug };

// Settings: Users & permissions (admin tier) and Integrations (Super Admin). Which tabs
// a user gets comes from permissions.js's settingsTabsFor via Shell.jsx -- the
// manage-users / clickup-key Edge Functions re-check the caller's role server-side.
// Both panels stay mounted (hidden) so switching tabs keeps their in-progress state.
export default function Settings({ tabs, ownRole, ownUserId }) {
  const [active, setActive] = useState(tabs[0]?.key ?? null);
  useEffect(() => {
    if (!tabs.some((t) => t.key === active)) setActive(tabs[0]?.key ?? null);
  }, [tabs, active]);
  const idBase = "pg-settings";
  const has = (key) => tabs.some((t) => t.key === key);

  return (
    <div className="pg-app">
      <div className="pg-container">
        <div className="pg-app-header">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <div className="pg-app-header__icon"><SettingsIcon size={18} /></div>
            <div>
              <span className="pg-eyebrow">Purple Giraffe · Internal</span>
              <h1 className="pg-app-header__title">Settings.</h1>
              <p className="pg-app-header__sub">Who can see what, and connected apps.</p>
            </div>
          </div>
        </div>

        <div className="pg-settings-tabs">
          <TabBar tabs={tabs.map((t) => ({ ...t, icon: TAB_ICONS[t.key] }))} active={active} onChange={setActive} idBase={idBase} label="Settings sections" />
        </div>

        {has("users") && (
          <div {...tabPanelProps(idBase, "users")} hidden={active !== "users"} style={{ marginTop: 20 }}>
            <UsersPanel ownRole={ownRole} ownUserId={ownUserId} />
          </div>
        )}
        {has("integrations") && (
          <div {...tabPanelProps(idBase, "integrations")} hidden={active !== "integrations"} style={{ marginTop: 20 }}>
            <Integrations />
          </div>
        )}
      </div>
    </div>
  );
}
