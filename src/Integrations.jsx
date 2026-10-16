import React, { useEffect, useState } from "react";
import { Plug, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { fetchClickupKeyStatus, saveClickupApiKey, triggerManualSync, fetchSyncMeta } from "./clickupSync.js";

// Settings → Integrations tab (Super Admin only). Lets the ClickUp API key be rotated from the app instead of a Supabase
// dashboard visit — the key is validated against ClickUp before it's saved,
// and syncing is kicked off right away so a stale sync (the reason this
// screen exists) is fixed in one step instead of waiting for the next cron tick.
export default function Integrations() {
  const [status, setStatus] = useState(null); // null = loading
  const [statusErr, setStatusErr] = useState(null);
  const [draftKey, setDraftKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [saveOk, setSaveOk] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMeta, setSyncMeta] = useState(null);

  async function loadStatus() {
    try {
      const s = await fetchClickupKeyStatus();
      setStatus(s);
      setStatusErr(null);
    } catch (e) {
      setStatusErr(e.message || String(e));
      setStatus((s) => s ?? { connected: false });
    }
  }

  useEffect(() => {
    loadStatus();
    fetchSyncMeta().then(setSyncMeta).catch(() => {});
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    if (!draftKey.trim()) return;
    setSaving(true);
    setSaveErr(null);
    setSaveOk(null);
    try {
      const result = await saveClickupApiKey(draftKey.trim());
      setSaveOk(`Connected to ${result.workspaces?.join(", ") || "ClickUp"}.`);
      setDraftKey("");
      await loadStatus();
      // A key that was rejecting syncs is exactly why someone lands here —
      // trigger the current month's sync immediately rather than making them
      // find the "Sync now" button on another page.
      setSyncing(true);
      try {
        await triggerManualSync();
        setSyncMeta(await fetchSyncMeta());
      } catch (syncErr) {
        setSaveErr(`Key saved, but the sync that followed failed: ${syncErr.message || syncErr}`);
      } finally {
        setSyncing(false);
      }
    } catch (e) {
      setSaveErr(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pg-cap-card" style={{ maxWidth: 520, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Plug size={16} />
        <h2 style={{ margin: 0, fontSize: 15 }}>ClickUp</h2>
      </div>

      {status === null ? (
        <p className="pg-footnote">Checking connection…</p>
      ) : statusErr ? (
        <p className="pg-footnote" style={{ color: "var(--status-warn)" }}>Couldn't check connection status: {statusErr}</p>
      ) : status.connected ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <CheckCircle2 size={15} style={{ color: "var(--status-ok)" }} />
          <span style={{ fontSize: 13 }}>
            Connected · key {status.masked} · {status.workspaces?.join(", ") || "workspace"}
          </span>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <XCircle size={15} style={{ color: "var(--fg-tertiary)" }} />
          <span style={{ fontSize: 13, color: "var(--fg-secondary)" }}>No ClickUp API key set yet.</span>
        </div>
      )}

      {syncMeta?.last_sync_status === "error" && (
        <p className="pg-footnote" style={{ color: "var(--status-warn)" }}>
          Last sync failed: {syncMeta.last_sync_message}
        </p>
      )}

      <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label className="pg-field">
          <span className="pg-field__label">{status?.connected ? "Replace API key" : "ClickUp API key"}</span>
          <input
            className="pg-input"
            type="password"
            autoComplete="off"
            placeholder="pk_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
          />
        </label>
        <p className="pg-footnote">
          Find this under ClickUp → your avatar → Settings → Apps → API Token. The key is validated
          against ClickUp before it's saved, and never leaves the server once set.
        </p>
        {saveErr && <p className="pg-footnote" style={{ color: "var(--status-over)" }}>{saveErr}</p>}
        {saveOk && !saveErr && <p className="pg-footnote" style={{ color: "var(--status-ok)" }}>{saveOk}</p>}
        <button className="pg-btn" type="submit" disabled={saving || !draftKey.trim()} style={{ justifyContent: "center", gap: 6 }}>
          {(saving || syncing) && <Loader2 size={13} style={{ animation: "pg-spin 1s linear infinite" }} />}
          {saving ? "Validating…" : syncing ? "Syncing…" : "Save & connect"}
        </button>
      </form>

      {syncMeta?.last_synced_at && syncMeta.last_sync_status === "ok" && (
        <p className="pg-footnote">Last successful sync: {new Date(syncMeta.last_synced_at).toLocaleString()} · {syncMeta.rows_synced ?? "—"} entries.</p>
      )}
    </div>
  );
}
