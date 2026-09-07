import React, { useState, useEffect, useMemo } from "react";
import { Search, ArrowRight, Pencil, Check, AlertTriangle, Upload, X, ChevronRight, ChevronDown, ArrowLeft, Plus, Trash2 } from "lucide-react";
import {
  fetchClients, fetchClientEvents, createClientEvent, deleteClientEvent, applyDueClientEvents,
  updateClickupFolder, updateClientWebsite, updateClientLogo, fetchCostCentres, addCostCentreFolder, removeCostCentreFolder,
  fetchClientHistory, fetchClientNotes, addClientNote, updateClientNote, deleteClientNote,
} from "./clientsSync.js";
import { multiFolderMatchesFor, multiFolderAccrualMatchesFor, setDynamicCostCentres, isDynamicCostCentreClient, findPersonMatch } from "./nameMatch.js";
import { idbGet, PG_DATA_EVENT } from "./idbStore.js";
import { CLICKUP_DB_KEY, PG_CLIENTS_KEY, PG_COST_CENTRES_KEY, CAP_PEOPLE_KEY } from "./storageKeys.js";
import { SEED_PEOPLE, loadKey as loadCapKey } from "./capacityData.js";
import { ClientAvatar, PersonAvatar, resizePhotoFile } from "./avatar.jsx";
import { useDismissable, useEscape } from "./useDismissable.js";

// Popover for a client's logo -- upload an image directly, or type in the
// client's website and let a favicon service supply the logo automatically.
function LogoEditor({ client, onClose, onSaved }) {
  const [website, setWebsite] = useState(client.website || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const ref = useDismissable(onClose);

  async function saveWebsite() {
    setSaving(true);
    setErr(null);
    try {
      // updateClientWebsite is the single source of truth for the resulting logo_url
      // (including clearing it when the website's cleared, and leaving a manually
      // uploaded logo alone) -- apply its returned patch verbatim rather than
      // re-deriving it here.
      const patch = await updateClientWebsite(client.client, website.trim(), { currentLogoUrl: client.logoUrl });
      onSaved(patch);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSaving(true);
    setErr(null);
    resizePhotoFile(file, async (dataUrl) => {
      try {
        await updateClientLogo(client.client, dataUrl);
        onSaved({ logoUrl: dataUrl });
      } catch (err2) {
        setErr(err2.message || String(err2));
      } finally {
        setSaving(false);
      }
    }, (msg) => { setErr(msg); setSaving(false); });
  }

  async function clearLogo() {
    setSaving(true);
    try {
      await updateClientLogo(client.client, null);
      onSaved({ logoUrl: null });
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={ref} className="pg-menu" style={{ top: "calc(100% + 4px)", left: 0, right: "auto", width: 280, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}
      onClick={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ClientAvatar name={client.client} logo={client.logoUrl} size={40} />
        <div style={{ fontSize: 12, color: "var(--fg-secondary)" }}>Logo / website for {client.client}</div>
      </div>
      <label className="pg-field">
        <span className="pg-field__label">Website</span>
        <input className="pg-input" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="e.g. clientdomain.com"
          onKeyDown={(e) => { if (e.key === "Enter") saveWebsite(); }} />
      </label>
      <button className="pg-btn" disabled={saving} onClick={saveWebsite}>Save & fetch favicon</button>
      <label className="pg-btn-ghost" style={{ justifyContent: "center", gap: 6, cursor: "pointer" }}>
        <Upload size={12} /> Upload logo instead
        <input type="file" accept="image/*" style={{ display: "none" }} onChange={handleUpload} disabled={saving} />
      </label>
      {client.logoUrl && (
        <button className="pg-btn-ghost" disabled={saving} onClick={clearLogo} style={{ justifyContent: "center", gap: 6 }}>
          <X size={12} /> Remove logo
        </button>
      )}
      {err && <p className="pg-footnote" style={{ color: "var(--status-over)" }}>{err}</p>}
      <button className="pg-btn-ghost" style={{ justifyContent: "center" }} onClick={onClose}>Close</button>
    </div>
  );
}

const TYPE_LABEL = {
  package: "Package", hourly: "Hourly", quoted: "Quoted", queensland: "Queensland",
  map: "MAP", project: "Project", strategy: "Strategy", ad_hoc: "Ad hoc",
};
const TYPES = Object.keys(TYPE_LABEL);
// Strategy is an ongoing engagement with agreed recurring hours -- same fixed-hours
// accrual shape as Package (see accrualsSync.js) -- so it needs the same "agreed hours"
// field wherever the UI asks for a Package's monthly commitment. Quoted reuses the exact
// same input/column too (gating whether the hours field shows and gets required/saved),
// just as a single lifetime budget rather than a recurring monthly one -- callers that
// care about that distinction (the display label below) special-case "quoted" separately
// before falling through to this.
const isPackageLikeType = (t) => t === "package" || t === "strategy" || t === "quoted";
const todayStr = () => new Date().toISOString().slice(0, 10);

// Client names carry their state as a "(Qld)"/"(WA)" suffix rather than a dedicated
// column -- this just reads that same convention back out for the snapshot breakdown.
function stateOf(clientName) {
  const n = (clientName || "").toLowerCase();
  if (n.includes("(qld)")) return "QLD";
  if (n.includes("(wa)")) return "WA";
  return "SA / Other";
}

function arrangementLabel(c) {
  if (c.type === "hourly") return "Time-based billing";
  if (c.type === "quoted") return c.agreedHours != null ? `${c.agreedHours} hours quoted` : "Project fee";
  if (isPackageLikeType(c.type) && c.agreedHours != null) return `${c.agreedHours} hours / month`;
  return TYPE_LABEL[c.type] || c.type;
}
function arrangementTagLabel(c) {
  if (c.type === "hourly") return "Hourly";
  if (c.type === "quoted") return "Quoted";
  if (isPackageLikeType(c.type)) return "Package";
  return TYPE_LABEL[c.type] || c.type;
}

const STATUS_LABEL = { active: "Active", on_hold: "On Hold", offboarded: "Offboarded", archived: "Archived" };
const STATUS_TONE = {
  active: "var(--status-ok)", on_hold: "var(--status-warn)",
  offboarded: "var(--fg-tertiary)", archived: "var(--status-over)",
};
function StatusBalloon({ status }) {
  return (
    <span className="pg-tag pg-tag--pill" style={{ color: STATUS_TONE[status] || "var(--fg-tertiary)", background: "var(--bg-elevated)" }}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function timeAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toISOString().slice(0, 10);
}

function Stat({ value, label }) {
  return (
    <div>
      <div className="pg-stat__value">{value}</div>
      <div className="pg-stat__label">{label}</div>
    </div>
  );
}

// One line of a client's transition history -- past (applied) or scheduled (pending).
// Only pending rows get a delete button: an applied event already mutated the client's
// current profile row, and typeTimelineFor's replay of past months reads applied=true
// events specifically, so removing one after the fact would silently rewrite already-
// closed months' history (see deleteClientEvent's guard in clientsSync.js).
function EventRow({ event: e, onDelete, deleting }) {
  const desc = e.kind === "type"
    ? `→ ${TYPE_LABEL[e.new_type] || e.new_type}${isPackageLikeType(e.new_type) && e.new_agreed_hours != null ? ` (${e.new_agreed_hours} hrs)` : ""}`
    : e.kind === "consultant" ? `→ ${e.new_consultant || "unassigned"}`
    : e.kind === "offboarding" ? "Offboarded"
    : e.kind === "reactivation" ? "Reactivated"
    : e.kind === "hold" ? "On Hold"
    : e.kind === "resume" ? "Resumed"
    : e.kind;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12 }}>
      <span style={{ color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)", minWidth: 88 }}>{e.effective_date}</span>
      <span className="pg-tag pg-tag--muted" style={{ minWidth: 76, textAlign: "center" }}>{e.kind}</span>
      <span style={{ flex: 1 }}>{desc}{e.note ? ` — ${e.note}` : ""}</span>
      <span className="pg-tag pg-tag--pill" style={{ color: e.applied ? "var(--status-ok)" : "var(--status-warn)" }}>
        {e.applied ? "Applied" : "Pending"}
      </span>
      {!e.applied && onDelete && (
        <button type="button" className="pg-icon-btn-sm" style={{ padding: 0 }} title="Remove this scheduled transition" disabled={deleting}
          onClick={() => onDelete(e)}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function ModifyPanel({ client, events, onSaved, onEventsChanged }) {
  const [action, setAction] = useState(null); // "transition" | "consultant" | "offboarding"
  const [newType, setNewType] = useState(client.type);
  const [newHours, setNewHours] = useState(client.agreedHours ?? "");
  const [newConsultant, setNewConsultant] = useState(client.consultant || "");
  const [holdNote, setHoldNote] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayStr());
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [err, setErr] = useState(null);

  // Reset the local draft whenever the underlying client changes (drawer switched
  // to a different client) so a half-filled transition for one client never bleeds
  // into another's panel.
  useEffect(() => {
    setAction(null); setNewType(client.type); setNewHours(client.agreedHours ?? "");
    setNewConsultant(client.consultant || ""); setHoldNote(""); setEffectiveDate(todayStr()); setErr(null);
  }, [client.client]);

  const isActive = client.status === "active";
  const sortedEvents = useMemo(() => [...(events || [])].sort((a, b) => a.effective_date.localeCompare(b.effective_date) || a.id - b.id), [events]);
  // Flags the exact conflict this was built for: two 'type' events sharing the same
  // effective_date. typeTimelineFor sorts by date and, on a tie, falls back to array/
  // insertion order to decide which one is "current" for that day -- which one wins is
  // effectively arbitrary from the UI's point of view, not something you actually chose.
  const dateConflict = action === "transition" && effectiveDate
    ? sortedEvents.find((e) => e.kind === "type" && e.effective_date === effectiveDate)
    : null;

  async function save() {
    // A blank hours field on a Package transition used to silently submit 0 -- a real,
    // billable "0 hrs/month" package, indistinguishable from someone just not having
    // filled the field in yet. Block the save and say so instead of guessing.
    if (action === "transition" && isPackageLikeType(newType) && newHours.trim() === "") {
      setErr("Enter the agreed hours for this package (or choose a different type).");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      if (action === "transition") {
        const fields = { new_type: newType, new_agreed_hours: isPackageLikeType(newType) ? Number(newHours) || 0 : null };
        await createClientEvent(client.client, "type", effectiveDate, fields);
      } else if (action === "consultant") {
        await createClientEvent(client.client, "consultant", effectiveDate, { new_consultant: newConsultant || null });
      } else if (action === "offboarding") {
        await createClientEvent(client.client, "offboarding", effectiveDate, {});
      } else if (action === "reactivate") {
        await createClientEvent(client.client, "reactivation", effectiveDate, {});
      } else if (action === "hold") {
        await createClientEvent(client.client, "hold", effectiveDate, {}, holdNote || null);
      } else if (action === "resume") {
        await createClientEvent(client.client, "resume", effectiveDate, {});
      }
      await applyDueClientEvents();
      onSaved();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  async function removeEvent(e) {
    setDeletingId(e.id);
    setErr(null);
    try {
      await deleteClientEvent(e.id, { applied: e.applied, client: client.client, kind: e.kind });
      await onEventsChanged?.();
    } catch (err2) {
      setErr(err2.message || String(err2));
    } finally {
      setDeletingId(null);
    }
  }

  // Pending (not-yet-applied) scheduled changes only -- a quick "what's coming up"
  // list right in the edit popover. The full applied+pending log lives in the
  // drawer's own History section now, reading from pginvoice_client_history
  // instead of duplicating it here.
  const pendingEvents = useMemo(() => sortedEvents.filter((e) => !e.applied), [sortedEvents]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {pendingEvents.length > 0 && (
        <div>
          <div className="pg-field__label" style={{ marginBottom: 4 }}>Scheduled</div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {pendingEvents.map((e) => (
              <EventRow key={e.id} event={e} onDelete={removeEvent} deleting={deletingId === e.id} />
            ))}
          </div>
        </div>
      )}

      {!action && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="pg-btn-ghost" onClick={() => setAction("transition")}>Transitioning</button>
          <button className="pg-btn-ghost" onClick={() => setAction("consultant")}>Consultant Update</button>
          {isActive && <button className="pg-btn-ghost" onClick={() => setAction("offboarding")}>Offboarding</button>}
          {isActive && <button className="pg-btn-ghost" onClick={() => setAction("hold")}>Put On Hold</button>}
          {client.status === "on_hold" && <button className="pg-btn-ghost" onClick={() => setAction("resume")}>Resume</button>}
          {(client.status === "offboarded" || client.status === "archived") && (
            <button className="pg-btn-ghost" onClick={() => setAction("reactivate")}>Reactivate</button>
          )}
        </div>
      )}

      {action === "transition" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="pg-tag">{TYPE_LABEL[client.type]}{isPackageLikeType(client.type) && client.agreedHours != null ? ` (${client.agreedHours} hrs)` : ""}</span>
            <ArrowRight size={14} />
            <select className="pg-input" value={newType} onChange={(e) => setNewType(e.target.value)}>
              {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
            {isPackageLikeType(newType) && (
              <input className="pg-input" style={{ width: 90 }} type="number" placeholder="hrs" value={newHours} onChange={(e) => setNewHours(e.target.value)} />
            )}
          </div>
          <label className="pg-field">
            <span className="pg-field__label">Effective date</span>
            <input className="pg-input" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </label>
          {dateConflict && (
            <div className="pg-banner-warn">
              Another transition is already scheduled for {effectiveDate} (→ {TYPE_LABEL[dateConflict.new_type] || dateConflict.new_type}). Two transitions on the same date is ambiguous — which one actually applies that day isn't well-defined. Pick a different date, or remove the existing one from the history above first.
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="pg-btn" disabled={saving} onClick={save}>Save</button>
            <button className="pg-btn-ghost" onClick={() => setAction(null)}>Back</button>
          </div>
        </div>
      )}

      {action === "consultant" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="pg-tag">{client.consultant || "unassigned"}</span>
            <ArrowRight size={14} />
            <input className="pg-input" value={newConsultant} onChange={(e) => setNewConsultant(e.target.value)} placeholder="New consultant" />
          </div>
          <label className="pg-field">
            <span className="pg-field__label">Effective date</span>
            <input className="pg-input" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="pg-btn" disabled={saving} onClick={save}>Save</button>
            <button className="pg-btn-ghost" onClick={() => setAction(null)}>Back</button>
          </div>
        </div>
      )}

      {action === "offboarding" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label className="pg-field">
            <span className="pg-field__label">Offboarding date</span>
            <input className="pg-input" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="pg-btn" disabled={saving} onClick={save}>Save</button>
            <button className="pg-btn-ghost" onClick={() => setAction(null)}>Back</button>
          </div>
        </div>
      )}

      {action === "hold" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="pg-tag">Active</span>
            <ArrowRight size={14} />
            <span className="pg-tag pg-tag--muted">On Hold</span>
          </div>
          <label className="pg-field">
            <span className="pg-field__label">Hold date</span>
            <input className="pg-input" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </label>
          <label className="pg-field">
            <span className="pg-field__label">Reason (optional)</span>
            <input className="pg-input" value={holdNote} onChange={(e) => setHoldNote(e.target.value)} placeholder="e.g. paused pending payment of $X owing" />
          </label>
          <p className="pg-footnote">Type and agreed hours stay as they are — this only flags the client as paused. Use Resume once work starts again.</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="pg-btn" disabled={saving} onClick={save}>Save</button>
            <button className="pg-btn-ghost" onClick={() => setAction(null)}>Back</button>
          </div>
        </div>
      )}

      {action === "resume" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="pg-tag pg-tag--muted">On Hold</span>
            <ArrowRight size={14} />
            <span className="pg-tag">Active</span>
          </div>
          <label className="pg-field">
            <span className="pg-field__label">Resume date</span>
            <input className="pg-input" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="pg-btn" disabled={saving} onClick={save}>Save</button>
            <button className="pg-btn-ghost" onClick={() => setAction(null)}>Back</button>
          </div>
        </div>
      )}

      {action === "reactivate" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="pg-tag pg-tag--muted">{client.status === "archived" ? "Archived (unverified)" : "Offboarded"}</span>
            <ArrowRight size={14} />
            <span className="pg-tag">Active</span>
          </div>
          <label className="pg-field">
            <span className="pg-field__label">Reactivation date</span>
            <input className="pg-input" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </label>
          <p className="pg-footnote">Clears the end date and sets status back to active. Type, agreed hours, and consultant stay as they were — use Transitioning/Consultant Update afterward if those need to change too.</p>
          {client.status === "archived" && (
            <p className="pg-footnote" style={{ color: "var(--status-warn)" }}>
              This client was marked "Archived (unverified)" by a bulk data cleanup, not through a real offboarding event — there's no record of it ever actually being offboarded. Reactivating it is a guess that it should be active, not a confirmed correction. Double-check this is the right call before saving.
            </p>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="pg-btn" disabled={saving} onClick={save}>Save</button>
            <button className="pg-btn-ghost" onClick={() => setAction(null)}>Back</button>
          </div>
        </div>
      )}
      {err && <div className="pg-banner-warn">{err}</div>}
    </div>
  );
}

// Pencil button next to the client's name -- opens a popover offering the same
// lifecycle actions the old inline Modify panel had (Transitioning, Consultant
// Update, Offboarding/Put on Hold, contextually Resume/Reactivate), rendering the
// chosen action's fields right inside the same popover instead of navigating away.
function EditPopover({ client, events, onSaved, onEventsChanged }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(() => setOpen(false));
  return (
    <div style={{ position: "relative" }} ref={open ? ref : undefined}>
      <button type="button" className="pg-drawer__icon-btn" title="Edit client" aria-label="Edit client" onClick={() => setOpen((o) => !o)}>
        <Pencil size={15} />
      </button>
      {open && (
        <div className="pg-menu" style={{ top: "calc(100% + 4px)", right: 0, left: "auto", width: 340, padding: 14 }} onClick={(e) => e.stopPropagation()}>
          <ModifyPanel client={client} events={events} onSaved={() => { setOpen(false); onSaved(); }} onEventsChanged={onEventsChanged} />
        </div>
      )}
    </div>
  );
}

// Right-side drawer -- one client's full profile: engagement/service arrangement,
// account owner (consultant), status/lifecycle actions (via the pencil popover),
// ClickUp folder, cost centres/sub-projects, notes, and a full change history.
// Everything that used to live in the table's inline expand-on-row now lives here
// instead, reached by clicking a row in the list.
function ClientProfileDrawer({
  client: c, events, folderSet, folderList, costCentreInfo, isDynamic, capPeople,
  editingFolder, draftFolder, savingFolder, folderMenuOpen, folderSuggestions,
  onStartEditFolder, onDraftFolderChange, onFolderFocus, onFolderBlur, onSaveFolder, onCancelEditFolder,
  managingCostCentres, draftCostCentreFolder, draftCostCentreKind, savingCostCentre,
  onStartManageCostCentres, onCancelManageCostCentres, onDraftCostCentreFolderChange, onDraftCostCentreKindChange,
  onAddCostCentre, onRemoveCostCentre,
  editingLogo, onToggleLogoEditor, onLogoSaved,
  onClose, onSaved, onEventsChanged,
}) {
  useEscape(onClose);
  const matched = folderSet && c.clickupFolder && folderSet.has(c.clickupFolder);
  const unmatched = folderSet && c.clickupFolder && !folderSet.has(c.clickupFolder);
  const owner = c.consultant ? findPersonMatch(c.consultant, capPeople) : null;
  const costCentres = costCentreInfo?.costCentres || [];
  const subProjects = costCentreInfo?.subProjects || [];
  const assigned = new Set([c.clickupFolder, ...costCentres, ...subProjects].filter(Boolean));

  return (
    <aside className="pg-drawer pg-drawer--push" role="dialog" aria-label={`${c.client} detail`}>
      <div className="pg-drawer__header">
        <button className="pg-drawer__icon-btn" onClick={onClose} aria-label="Back" title="Back">
          <ArrowLeft size={16} />
        </button>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
          <EditPopover client={c} events={events} onSaved={onSaved} onEventsChanged={onEventsChanged} />
          <button className="pg-drawer__icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="pg-drawer__title-row">
        <div style={{ position: "relative" }}>
          <button type="button" className="pg-icon-btn-sm" style={{ padding: 0, borderRadius: "50%" }}
            title="Set client logo / website" onClick={onToggleLogoEditor}>
            <ClientAvatar name={c.client} logo={c.logoUrl} size={40} />
          </button>
          {editingLogo && <LogoEditor client={c} onClose={onToggleLogoEditor} onSaved={onLogoSaved} />}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="pg-drawer__name">{c.client}</div>
          <div className="pg-drawer__sub" style={{ marginTop: 4 }}>
            <StatusBalloon status={c.status} />
          </div>
        </div>
      </div>

      <div className="pg-drawer-tabs">
        <span className="pg-drawer-tabs__tab pg-drawer-tabs__tab--active">Overview</span>
      </div>

      <div className="pg-drawer__section" style={{ borderTop: 0, paddingTop: 0 }}>
        <div className="pg-drawer__section-title" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Engagement</span>
        </div>
        <div className="pg-drawer__field">
          <span className="pg-field__label">Service arrangement</span>
          <span className="pg-drawer__field-value" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
            <span className="pg-tag">{arrangementTagLabel(c)}</span>
            {arrangementLabel(c)}
          </span>
        </div>
        <div className="pg-drawer__field" style={{ marginTop: 14 }}>
          <span className="pg-field__label">Engaged since</span>
          <span className="pg-drawer__field-value" style={{ fontSize: 14 }}>{c.startDate || "Not set"}</span>
        </div>
        {c.endDate && (
          <div className="pg-drawer__field" style={{ marginTop: 14 }}>
            <span className="pg-field__label">End date</span>
            <span className="pg-drawer__field-value" style={{ fontSize: 14 }}>{c.endDate}</span>
          </div>
        )}
      </div>

      <div className="pg-drawer__section">
        <div className="pg-drawer__section-title">Consultant</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <PersonAvatar name={c.consultant} photo={owner?.photo} size={36} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, color: "var(--fg-primary)" }}>{c.consultant || "Unassigned"}</div>
            {owner?.email && <div style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>{owner.email}</div>}
          </div>
        </div>
      </div>

      <div className="pg-drawer__section">
        <div className="pg-drawer__section-title" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>ClickUp folder</span>
        </div>
        {editingFolder ? (
          <div style={{ display: "flex", gap: 4, position: "relative" }}>
            <input
              className="pg-input" autoFocus value={draftFolder}
              onChange={(e) => onDraftFolderChange(e.target.value)}
              onFocus={onFolderFocus}
              onBlur={onFolderBlur}
              placeholder={folderSet && folderSet.size ? "Type to search live ClickUp folders…" : "Real ClickUp folder name"}
              onKeyDown={(e) => { if (e.key === "Enter") onSaveFolder(); if (e.key === "Escape") onCancelEditFolder(); }}
            />
            <button className="pg-btn-ghost" disabled={savingFolder} onClick={() => onSaveFolder()}><Check size={12} /></button>
            {folderMenuOpen && folderSuggestions.length > 0 && (
              <div className="pg-menu" style={{ top: "calc(100% + 2px)", left: 0, right: "auto", width: "100%", maxHeight: 240, overflow: "auto" }}>
                {folderSuggestions.map((f) => (
                  <button
                    key={f} type="button" className="pg-menu-item"
                    onMouseDown={() => onSaveFolder(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
            onClick={onStartEditFolder}
            title={matched ? "Matches a real ClickUp folder" : unmatched ? "This folder name isn't in the currently-synced ClickUp data -- may be renamed, archived, or a typo" : "No ClickUp folder set for this client"}
          >
            {matched && <span style={{ color: "var(--status-ok)" }}>✓</span>}
            {unmatched && <AlertTriangle size={12} style={{ color: "var(--status-warn)" }} />}
            <span style={{ flex: 1, fontSize: 13, color: c.clickupFolder ? "var(--fg-primary)" : "var(--fg-tertiary)" }}>{c.clickupFolder || "Not set"}</span>
            <Pencil size={11} />
          </div>
        )}
      </div>

      {isDynamic === false && costCentres.length + subProjects.length > 0 ? (
        // A hardcoded MULTI_FOLDER_CLIENTS rule (nameMatch.js), not this module's own
        // editable pginvoice_cost_centres rows -- read-only, but still split into the
        // same two labeled sections as the editable case below (not lumped into one
        // "cost centres & sub-projects" block), and still using the SAME collapsible
        // list component -- a hardcoded rule can easily have far more than 5 folders
        // (Magain: 27), and a plain unbounded .map() here means only the dynamic path
        // ever got the collapse/expand toggle, not this one.
        <>
          {costCentres.length > 0 && (
            <CostCentreSection title="Cost Centres" items={costCentres} readOnlyNote="Built into the app — ask to have this made editable" />
          )}
          {subProjects.length > 0 && (
            <CostCentreSection title="Sub Project" items={subProjects} readOnlyNote="Built into the app — ask to have this made editable" />
          )}
        </>
      ) : (
        <>
          <CostCentreSection
            title="Cost Centres" kind="cost_centre" items={costCentres} assigned={assigned} folderList={folderList}
            managing={managingCostCentres === "cost_centre"} draftFolder={draftCostCentreFolder} savingCostCentre={savingCostCentre}
            onStart={() => onStartManageCostCentres("cost_centre")} onCancel={onCancelManageCostCentres}
            onDraftFolderChange={onDraftCostCentreFolderChange} onAdd={onAddCostCentre} onRemove={(f) => onRemoveCostCentre(f, "cost_centre")}
          />
          <CostCentreSection
            title="Sub Project" kind="sub_project" items={subProjects} assigned={assigned} folderList={folderList}
            managing={managingCostCentres === "sub_project"} draftFolder={draftCostCentreFolder} savingCostCentre={savingCostCentre}
            onStart={() => onStartManageCostCentres("sub_project")} onCancel={onCancelManageCostCentres}
            onDraftFolderChange={onDraftCostCentreFolderChange} onAdd={onAddCostCentre} onRemove={(f) => onRemoveCostCentre(f, "sub_project")}
          />
        </>
      )}

      <NotesSection client={c.client} />

      <HistorySection client={c.client} />
    </aside>
  );
}

// One cost-centre or sub-project list, each with its own inline "add" affordance --
// split into two sections (rather than one combined list with a kind tag on each
// row) so Cost Centres and Sub Project read as the two distinct things they are,
// matching the drawer's field order.
const COST_CENTRE_COLLAPSE_AT = 5;

// One cost-centre or sub-project list. Plain view shows just the first 5 names;
// past that, an inline "N items ⌄" text toggle (not a button styled as one) expands
// the rest -- clicking it again while expanded collapses back down to 5, always
// showing the true total either way rather than just "+N more" for the hidden tail.
// Editing (add/remove) only happens once "Edit" is clicked, which also expands the
// full list so nothing being removed is hidden behind the collapse.
// `readOnlyNote` set (hardcoded MULTI_FOLDER_CLIENTS rule) -> no Edit button, no
// add/remove, just the collapsible list plus that note. Left unset (the normal,
// pginvoice_cost_centres-backed case) -> full add/remove editing, gated behind Edit.
function CostCentreSection({ title, kind, items, assigned, folderList, managing, draftFolder, savingCostCentre, onStart, onCancel, onDraftFolderChange, onAdd, onRemove, readOnlyNote }) {
  const [expanded, setExpanded] = useState(false);
  const datalistId = `cc-folders-${kind}`;
  const overflows = items.length > COST_CENTRE_COLLAPSE_AT;
  const showAll = expanded || managing || !overflows;
  const shown = showAll ? items : items.slice(0, COST_CENTRE_COLLAPSE_AT);
  const readOnly = readOnlyNote !== undefined;
  const listId = `cc-list-${kind}-${title}`.replace(/\s+/g, "-");

  return (
    <div className="pg-drawer__section">
      <div className="pg-drawer__section-title" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>{title} {items.length > 0 ? `(${items.length})` : ""}</span>
        {!readOnly && (
          <button className="pg-btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => (managing ? onCancel() : onStart())}>
            {managing ? "Done" : "Edit"}
          </button>
        )}
      </div>
      <div id={listId} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {shown.map((f) => (
          <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
            <span style={{ flex: 1, fontSize: 13, color: "var(--fg-primary)" }}>{f}</span>
            {managing && (
              <button type="button" className="pg-icon-btn-sm" style={{ padding: 0 }} title="Remove" disabled={savingCostCentre} onClick={() => onRemove(f)}>
                <X size={10} />
              </button>
            )}
          </div>
        ))}
        {items.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--fg-tertiary)" }}>None yet.</div>
        )}
        {overflows && !managing && (
          <button
            type="button"
            className="pg-row__name-sub pg-row__name-sub--toggle"
            style={{ marginTop: 2 }}
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            aria-controls={listId}
          >
            {expanded ? "Show fewer" : `${items.length} items`}
            <ChevronDown size={12} style={{ transform: expanded ? "rotate(180deg)" : undefined }} />
          </button>
        )}
        {managing && (
          <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
            <input
              className="pg-input" autoFocus style={{ flex: 1, minWidth: 160, fontSize: 12 }}
              list={datalistId}
              placeholder="Type or pick a ClickUp folder…"
              value={draftFolder}
              onChange={(e) => onDraftFolderChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && draftFolder.trim()) onAdd(); if (e.key === "Escape") onCancel(); }}
            />
            <datalist id={datalistId}>
              {folderList.filter((f) => !assigned.has(f)).map((f) => <option key={f} value={f} />)}
            </datalist>
            <button className="pg-btn-ghost" disabled={!draftFolder.trim() || savingCostCentre} onClick={onAdd}><Check size={12} /></button>
          </div>
        )}
        {readOnly && (
          <div style={{ color: "var(--fg-tertiary)", fontStyle: "italic", fontSize: 11, marginTop: 4 }}>{readOnlyNote}</div>
        )}
      </div>
    </div>
  );
}

// Multiple dated notes -- "Add notes" while empty (or to append another), each
// existing note gets its own "Modify" toggle to edit its text or delete it.
function NotesSection({ client }) {
  const [notes, setNotes] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function load() {
    try { setNotes(await fetchClientNotes(client)); } catch (e) { setErr(e.message || String(e)); setNotes((n) => n ?? []); }
  }
  useEffect(() => { load(); }, [client]);

  async function save() {
    if (!draft.trim()) return;
    setBusy(true); setErr(null);
    try { await addClientNote(client, draft.trim()); setDraft(""); setAdding(false); await load(); }
    catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  }
  async function saveEdit(id) {
    if (!editDraft.trim()) return;
    setBusy(true); setErr(null);
    try { await updateClientNote(id, client, editDraft.trim()); setEditingId(null); await load(); }
    catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  }
  async function remove(id) {
    setBusy(true); setErr(null);
    try { await deleteClientNote(id, client); setEditingId(null); await load(); }
    catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  }

  return (
    <div className="pg-drawer__section">
      <div className="pg-drawer__section-title" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Notes {notes && notes.length > 0 ? `(${notes.length})` : ""}</span>
        {!adding && (
          <button className="pg-btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => setAdding(true)}><Plus size={11} /> Add notes</button>
        )}
      </div>
      {adding && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          <textarea className="pg-input" rows={3} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Note…" />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="pg-btn" disabled={busy || !draft.trim()} onClick={save}>Save</button>
            <button className="pg-btn-ghost" onClick={() => { setAdding(false); setDraft(""); }}>Cancel</button>
          </div>
        </div>
      )}
      {notes === null ? (
        <div style={{ fontSize: 12, color: "var(--fg-tertiary)" }}>Loading…</div>
      ) : notes.length === 0 && !adding ? (
        <div style={{ fontSize: 12, color: "var(--fg-tertiary)" }}>No notes yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {notes.map((n) => (
            <div key={n.id} style={{ borderBottom: "1px dashed var(--border-subtle)", paddingBottom: 8 }}>
              {editingId === n.id ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <textarea className="pg-input" rows={3} autoFocus value={editDraft} onChange={(e) => setEditDraft(e.target.value)} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="pg-btn" disabled={busy || !editDraft.trim()} onClick={() => saveEdit(n.id)}>Save</button>
                    <button className="pg-btn-ghost" disabled={busy} onClick={() => remove(n.id)}><Trash2 size={12} /> Delete</button>
                    <button className="pg-btn-ghost" onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 13, color: "var(--fg-primary)", whiteSpace: "pre-wrap" }}>{n.text}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                    <span style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>
                      {n.author_email || "unknown"} · {timeAgo(n.updated_at || n.created_at)}
                    </span>
                    <button type="button" className="pg-row-inline__more" style={{ fontSize: 11, padding: 0 }}
                      onClick={() => { setEditingId(n.id); setEditDraft(n.text); }}>Modify</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {err && <div className="pg-banner-warn" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}

const HISTORY_ICON_LABEL = {
  event_type: "Transition", event_type_removed: "Transition cancelled",
  event_consultant: "Consultant update", event_consultant_removed: "Consultant update cancelled",
  event_offboarding: "Offboarding", event_offboarding_removed: "Offboarding cancelled",
  event_reactivation: "Reactivation", event_reactivation_removed: "Reactivation cancelled",
  event_hold: "Put on hold", event_hold_removed: "Hold cancelled",
  event_resume: "Resume", event_resume_removed: "Resume cancelled",
  folder_change: "ClickUp folder", cost_centre_add: "Cost centre", cost_centre_remove: "Cost centre",
  note_add: "Note", note_edit: "Note", note_delete: "Note",
};

// Full chronological log of everything that's happened to this client -- every
// scheduled/cancelled lifecycle change, folder edit, cost-centre/sub-project
// add/remove, and note edit, each tagged with who made it and when. Reads from
// pginvoice_client_history, which every mutation in clientsSync.js writes to.
function HistorySection({ client }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchClientHistory(client).then((r) => { if (!cancelled) setRows(r); }).catch((e) => { if (!cancelled) { setErr(e.message || String(e)); setRows([]); } });
    return () => { cancelled = true; };
  }, [client]);

  const shown = rows ? (expanded ? rows : rows.slice(0, 8)) : [];

  return (
    <div className="pg-drawer__section">
      <div className="pg-drawer__section-title">History</div>
      {err && <div className="pg-banner-warn">{err}</div>}
      {rows === null ? (
        <div style={{ fontSize: 12, color: "var(--fg-tertiary)" }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--fg-tertiary)" }}>No changes recorded yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {shown.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 10 }}>
              <span className="pg-tag pg-tag--muted" style={{ flex: "none", minWidth: 92, textAlign: "center", height: "fit-content" }}>
                {HISTORY_ICON_LABEL[r.action] || r.action}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "var(--fg-primary)" }}>{r.detail?.summary || r.action}</div>
                <div style={{ fontSize: 11, color: "var(--fg-tertiary)", marginTop: 2 }}>
                  {r.actor_email || "unknown"} · {timeAgo(r.created_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {rows && rows.length > 8 && (
        <button className="pg-manual-note" style={{ background: "none", border: 0, cursor: "pointer", padding: 0, marginTop: 10 }} onClick={() => setExpanded((o) => !o)}>
          <span style={{ color: "var(--accent)" }}>{expanded ? "Show fewer" : `View all ${rows.length} changes`}</span>
        </button>
      )}
    </div>
  );
}

export default function Clients() {
  const [clients, setClients] = useState(null);
  const [clientEvents, setClientEvents] = useState([]); // full history across all clients, filtered per-row when the drawer opens
  const [loadError, setLoadError] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [typeFilter, setTypeFilter] = useState("all");
  const [openClient, setOpenClient] = useState(null); // client name currently shown in the drawer
  const [folderSet, setFolderSet] = useState(null); // null = not loaded; Set of real ClickUp folder names once loaded
  const [editingFolder, setEditingFolder] = useState(false);
  const [draftFolder, setDraftFolder] = useState("");
  const [savingFolder, setSavingFolder] = useState(false);
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [editingLogo, setEditingLogo] = useState(false);
  const [managingCostCentres, setManagingCostCentres] = useState(false);
  const [draftCostCentreFolder, setDraftCostCentreFolder] = useState("");
  const [draftCostCentreKind, setDraftCostCentreKind] = useState("cost_centre");
  const [savingCostCentre, setSavingCostCentre] = useState(false);
  const [capPeople, setCapPeople] = useState(SEED_PEOPLE);
  // nameMatch.js's dynamic cost-centre rules are a module-level singleton (see
  // setDynamicCostCentres) fed by Shell.jsx, not React state -- costCentreInfo below reads
  // them via a plain function call, so it has no way to know they changed on its own. This
  // is bumped whenever the underlying table changes (via this tab's own edits or another
  // tab's, both arrive as the same PG_DATA_EVENT) purely to force that useMemo to rerun.
  const [costCentreVersion, setCostCentreVersion] = useState(0);

  const folderList = useMemo(() => (folderSet ? [...folderSet].sort((a, b) => a.localeCompare(b)) : []), [folderSet]);
  // Reflects the cost-centre/sub-project relationships defined in nameMatch.js's
  // MULTI_FOLDER_CLIENTS (the same rules Client Invoicing's roll-up and Client
  // Accruals' accrual math both read) -- read-only here, since those rules are still
  // code-defined, not stored data; this just makes them visible where a client's
  // folder is otherwise managed, instead of leaving them undiscoverable outside the
  // codebase. `info` maps a parent client -> its cost-centre folders (accrual-
  // eligible siblings) and sub-project folders (billed separately, excluded from the
  // accrual); `subProjectOf` is the reverse lookup, folder -> parent client name, so
  // a sub-project's OWN row (e.g. BAMSS Childcare Security Services) can show which
  // parent tile it rolls up under in Client Invoicing.
  const costCentreInfo = useMemo(() => {
    const info = new Map();
    const subProjectOf = new Map();
    // `clients` starts null until fetchClients() resolves (see the useState above) --
    // this ran unguarded against that null on first render, which is exactly what took
    // the whole page down: iterating null throws immediately inside a useMemo, with no
    // error boundary to catch it, so React unmounts everything -- the "loads then goes
    // black" symptom, on every single load, since this runs before data ever arrives.
    if (!clients || !folderList.length) return { info, subProjectOf };
    for (const c of clients) {
      const all = multiFolderMatchesFor(c.client, folderList);
      if (!all) continue;
      // The `< 2` floor only makes sense for a hardcoded MULTI_FOLDER_CLIENTS rule, where
      // `all` naturally includes the client's own primary folder alongside any real
      // siblings -- a bare match with nothing else is just the client matching its own
      // rule, not an actual cost centre. A DYNAMIC client's `all` is exclusively the rows
      // explicitly added via this module's Cost Centres/Sub Project editors (it never
      // includes the client's own registered clickupFolder at all -- see
      // multiFolderMatchesFor in nameMatch.js), so even a single dynamic row is a real,
      // deliberately-added link and must never be silently dropped here. Without this
      // split, adding exactly one sub-project to a client with no other cost centres
      // (e.g. ARAS + its Website Optimisation Project) always failed this guard and
      // showed as "None yet" despite being saved correctly.
      if (!isDynamicCostCentreClient(c.client) && all.length < 2) continue;
      const accrual = multiFolderAccrualMatchesFor(c.client, folderList) || [];
      const costCentres = all.filter((f) => f !== c.clickupFolder && accrual.includes(f));
      const subProjects = all.filter((f) => !accrual.includes(f));
      if (costCentres.length || subProjects.length) info.set(c.client, { costCentres, subProjects });
      subProjects.forEach((f) => subProjectOf.set(f, c.client));
    }
    return { info, subProjectOf };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- costCentreVersion isn't read
    // in the body; it's here purely to force a rerun when the dynamic table changes (see
    // its declaration above).
  }, [clients, folderList, costCentreVersion]);
  const folderSuggestions = useMemo(() => {
    const q = draftFolder.trim().toLowerCase();
    const pool = q ? folderList.filter((f) => f.toLowerCase().includes(q)) : folderList;
    return pool.slice(0, 8);
  }, [folderList, draftFolder]);

  async function load() {
    try {
      await applyDueClientEvents();
      const data = await fetchClients();
      setClients(data);
    } catch (e) {
      setLoadError(e.message || String(e));
      setClients((c) => c ?? []);
    }
  }

  async function loadEvents() {
    try {
      setClientEvents(await fetchClientEvents());
    } catch (e) {
      // Non-fatal -- the drawer just shows an empty history rather than
      // taking the whole page down over a history fetch failing.
      setClientEvents((prev) => prev ?? []);
    }
  }

  async function loadFolders() {
    const cu = await idbGet(CLICKUP_DB_KEY);
    setFolderSet(new Set((cu?.rows || []).map((r) => r.folder).filter(Boolean)));
  }

  // Fetched independently here (Shell.jsx also fetches this to feed every other module) rather
  // than just relying on Shell's own fetch to finish and trusting the timing -- awaiting it
  // directly before bumping costCentreVersion means this page's own display can never show a
  // stale dynamic-rules snapshot after an edit, regardless of when Shell's fetch resolves.
  async function loadCostCentres() {
    try {
      const rows = await fetchCostCentres();
      setDynamicCostCentres(rows);
      setCostCentreVersion((v) => v + 1);
    } catch (e) {}
  }

  useEffect(() => {
    load();
    loadFolders();
    loadCostCentres();
    loadEvents();
    let cancelled = false;
    loadCapKey(CAP_PEOPLE_KEY, SEED_PEOPLE).then((v) => { if (!cancelled) setCapPeople(v || SEED_PEOPLE); });
    const onUpdate = (e) => {
      if (!e.detail || e.detail.key === CLICKUP_DB_KEY) loadFolders();
      // A consultant/status/new-client change made from Capacity Planning writes to the same
      // pginvoice_clients table -- refresh so it shows here without a full page reload.
      if (!e.detail || e.detail.key === PG_CLIENTS_KEY) { load(); loadEvents(); }
      if (!e.detail || e.detail.key === PG_COST_CENTRES_KEY) loadCostCentres();
      if (!e.detail || e.detail.key === CAP_PEOPLE_KEY) loadCapKey(CAP_PEOPLE_KEY, SEED_PEOPLE).then((v) => setCapPeople(v || SEED_PEOPLE));
    };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => { cancelled = true; window.removeEventListener(PG_DATA_EVENT, onUpdate); };
  }, []);

  // Any per-client editor state (folder edit, cost-centre add, logo popover) resets
  // whenever a different client's drawer opens, so switching clients never leaves a
  // stale draft or open editor pointed at the wrong client.
  function openDrawer(clientName) {
    setOpenClient(clientName);
    setEditingFolder(false);
    setDraftFolder("");
    setFolderMenuOpen(false);
    setEditingLogo(false);
    setManagingCostCentres(false);
    setDraftCostCentreFolder("");
    setDraftCostCentreKind("cost_centre");
  }

  async function saveFolder(client, folderOverride) {
    // Accepts an explicit folder value (used when picking a suggestion, since setDraftFolder
    // just before calling this wouldn't be visible yet — state updates aren't synchronous)
    // and otherwise falls back to whatever's currently in the draft input.
    const folder = (folderOverride ?? draftFolder).trim();
    const previousFolder = clients.find((c) => c.client === client)?.clickupFolder || null;
    setSavingFolder(true);
    try {
      await updateClickupFolder(client, folder, { previousFolder });
      setClients((prev) => prev.map((c) => (c.client !== client ? c : { ...c, clickupFolder: folder || null })));
      setEditingFolder(false);
      setFolderMenuOpen(false);
    } catch (e) {
      setLoadError("Couldn't save that ClickUp folder name: " + (e.message || e));
    } finally {
      setSavingFolder(false);
    }
  }

  async function addCostCentre(client) {
    const folder = draftCostCentreFolder.trim();
    if (!folder) return;
    setSavingCostCentre(true);
    try {
      await addCostCentreFolder(client, folder, draftCostCentreKind);
      // loadCostCentres() will run again from the PG_DATA_EVENT this dispatches, but that's
      // async on its own schedule -- refresh directly too so the just-added folder appears
      // in this same interaction instead of waiting on the event round-trip.
      await loadCostCentres();
      setDraftCostCentreFolder("");
    } catch (e) {
      setLoadError("Couldn't add that cost centre: " + (e.message || e));
    } finally {
      setSavingCostCentre(false);
    }
  }

  async function removeCostCentre(client, folder, kind) {
    setSavingCostCentre(true);
    try {
      await removeCostCentreFolder(client, folder, kind);
      await loadCostCentres();
    } catch (e) {
      setLoadError("Couldn't remove that cost centre: " + (e.message || e));
    } finally {
      setSavingCostCentre(false);
    }
  }

  const filtered = useMemo(() => {
    if (!clients) return [];
    const q = search.trim().toLowerCase();
    return clients.filter((c) => {
      if (q && !c.client.toLowerCase().includes(q)) return false;
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (typeFilter !== "all" && c.type !== typeFilter) return false;
      return true;
    });
  }, [clients, search, statusFilter, typeFilter]);

  const snapshot = useMemo(() => {
    if (!clients) return { total: 0, byState: [] };
    const active = clients.filter((c) => c.status === "active");
    const byState = new Map();
    active.forEach((c) => { const s = stateOf(c.client); byState.set(s, (byState.get(s) || 0) + 1); });
    return { total: active.length, byState: [...byState.entries()].sort((a, b) => b[1] - a[1]) };
  }, [clients]);

  const openC = openClient ? filtered.find((c) => c.client === openClient) || (clients || []).find((c) => c.client === openClient) : null;
  const openCostCentreInfo = openC ? costCentreInfo.info.get(openC.client) : null;
  const openIsDynamic = openC ? isDynamicCostCentreClient(openC.client) : null;

  if (clients === null) return <div className="pg-cap-container"><div className="pg-empty">Loading…</div></div>;

  return (
    <div className={"pg-app pg-app--invoicing" + (openC ? " pg-app--drawer-open" : "")}>
      <div className={"pg-cap-container pg-container" + (openC ? " pg-container--dimmed" : "")}>
        <div className="pg-app-header">
          <div>
            <span className="pg-eyebrow">Purple Giraffe · Internal</span>
            <h1 className="pg-app-header__title">Clients</h1>
            <p className="pg-app-header__sub">Client roster — package/hourly/quoted type, consultant, and lifecycle. Click a client to view and modify their profile.</p>
          </div>
        </div>

        {loadError && <div className="pg-banner-warn">{loadError}</div>}

        <div className="pg-panel" style={{ gap: 24, flexWrap: "wrap" }}>
          <Stat value={snapshot.total} label="Active clients" />
          {snapshot.byState.map(([state, count]) => <Stat key={state} value={count} label={state} />)}
        </div>

        <div className="pg-panel" style={{ alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <label className="pg-field" style={{ width: 240 }}>
            <span className="pg-field__label"><Search size={11} /> Client</span>
            <input className="pg-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients…" />
          </label>
          <label className="pg-field">
            <span className="pg-field__label">Status</span>
            <select className="pg-input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="active">Active</option>
              <option value="on_hold">On Hold</option>
              <option value="offboarded">Offboarded</option>
              <option value="archived">Archived (unverified)</option>
              <option value="all">All</option>
            </select>
          </label>
          <label className="pg-field">
            <span className="pg-field__label">Type</span>
            <select className="pg-input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">All</option>
              {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
          </label>
        </div>

        <div className="pg-cap-card pg-client-list">
          <div className="pg-client-list__head">
            <span>Client</span>
            <span>Service Arrangement</span>
            <span>Consultant</span>
            <span>Client Status</span>
            <span />
          </div>
          {filtered.map((c) => {
            const owner = c.consultant ? findPersonMatch(c.consultant, capPeople) : null;
            const active = openClient === c.client;
            return (
              <button type="button" key={c.client} className={"pg-client-list__row" + (active ? " pg-client-list__row--active" : "")} onClick={() => openDrawer(c.client)}>
                <span className="pg-client-list__client">
                  <ClientAvatar name={c.client} logo={c.logoUrl} size={32} />
                  <span className="pg-client-list__client-text">
                    <span className="pg-client-list__name">{c.client}</span>
                  </span>
                </span>
                <span className="pg-client-list__arrangement">
                  <span className="pg-tag">{arrangementTagLabel(c)}</span>
                  <span className="pg-client-list__arrangement-text">{arrangementLabel(c)}</span>
                </span>
                <span className="pg-client-list__owner">
                  {c.consultant ? (
                    <>
                      <PersonAvatar name={c.consultant} photo={owner?.photo} size={26} />
                      <span>{c.consultant}</span>
                    </>
                  ) : <span style={{ color: "var(--fg-tertiary)" }}>Unassigned</span>}
                </span>
                <span>
                  <StatusBalloon status={c.status} />
                </span>
                <span className="pg-client-list__expand">
                  <ChevronRight size={16} style={{ color: "var(--fg-tertiary)" }} />
                </span>
              </button>
            );
          })}
          {filtered.length === 0 && <div className="pg-empty">No clients match this filter.</div>}
        </div>
        <p className="pg-footnote">Purple Giraffe · Clients · Transitions, consultant reassignments, and offboarding are scheduled by effective date and applied automatically once that date arrives.</p>
      </div>

      {openC && (
        <ClientProfileDrawer
          client={openC}
          events={clientEvents.filter((e) => e.client === openC.client)}
          folderSet={folderSet}
          folderList={folderList}
          costCentreInfo={openCostCentreInfo}
          isDynamic={openIsDynamic}
          capPeople={capPeople}
          editingFolder={editingFolder}
          draftFolder={draftFolder}
          savingFolder={savingFolder}
          folderMenuOpen={folderMenuOpen}
          folderSuggestions={folderSuggestions}
          onStartEditFolder={() => { setEditingFolder(true); setDraftFolder(openC.clickupFolder || ""); setFolderMenuOpen(true); }}
          onDraftFolderChange={(v) => { setDraftFolder(v); setFolderMenuOpen(true); }}
          onFolderFocus={() => setFolderMenuOpen(true)}
          onFolderBlur={() => setTimeout(() => setFolderMenuOpen(false), 150)}
          onSaveFolder={(f) => saveFolder(openC.client, f)}
          onCancelEditFolder={() => { setEditingFolder(false); setFolderMenuOpen(false); }}
          managingCostCentres={managingCostCentres}
          draftCostCentreFolder={draftCostCentreFolder}
          draftCostCentreKind={draftCostCentreKind}
          savingCostCentre={savingCostCentre}
          onStartManageCostCentres={(kind) => { setManagingCostCentres(kind); setDraftCostCentreFolder(""); setDraftCostCentreKind(kind); }}
          onCancelManageCostCentres={() => { setManagingCostCentres(false); setDraftCostCentreFolder(""); }}
          onDraftCostCentreFolderChange={setDraftCostCentreFolder}
          onDraftCostCentreKindChange={setDraftCostCentreKind}
          onAddCostCentre={() => addCostCentre(openC.client)}
          onRemoveCostCentre={(f, kind) => removeCostCentre(openC.client, f, kind)}
          editingLogo={editingLogo}
          onToggleLogoEditor={() => setEditingLogo((o) => !o)}
          onLogoSaved={(patch) => {
            setClients((prev) => prev.map((x) => (x.client !== openC.client ? x : { ...x, ...patch })));
            setEditingLogo(false);
          }}
          onClose={() => setOpenClient(null)}
          onSaved={() => { load(); loadEvents(); }}
          onEventsChanged={loadEvents}
        />
      )}
    </div>
  );
}
