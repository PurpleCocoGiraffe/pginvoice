// Confirm dialog for Client Accruals Management's ledger actions (admin tier). Shows the
// working before anything is written; the reason is required for anything that changes a
// balance. The write itself is done by the caller's onConfirm (accrualsSync.js writers),
// followed by a recompute.
import React, { useRef, useState } from "react";
import { monthLabelOf, shiftMonthKey } from "./accrualsSync.js";
import { carryOutOf } from "./format.js";
import { useEscape, useFocusTrap } from "./useDismissable.js";
import { carryInto, notInvoicedBalance } from "./accrualsView.js";
import { ACTION_LABEL, balanceText, fmtH } from "./AccrualClientDrawer.jsx";

const REASON_REQUIRED = new Set(["write_off", "not_invoiced"]);

export default function AccrualActionDialog({ action, client, monthKey, busy, error, onConfirm, onClose }) {
  const cell = client.months[monthKey] || {};
  const [reason, setReason] = useState("");
  const [value, setValue] = useState("0");
  const reasonRef = useRef(null);
  const dialogRef = useFocusTrap({ initialFocusRef: reasonRef });
  useEscape(() => { if (!busy) onClose(); });

  const month = monthLabelOf(monthKey);
  const next = monthLabelOf(shiftMonthKey(monthKey, 1));
  const before = carryOutOf(cell);
  const prior = carryInto(client, monthKey);
  const niBalance = action === "not_invoiced" ? notInvoicedBalance(client, monthKey) : null;
  const numValue = Number(value);
  const valueOk = action !== "write_off" || (value.trim() !== "" && Number.isFinite(numValue));
  const canSubmit = !busy && valueOk && (!REASON_REQUIRED.has(action) || reason.trim().length > 0);

  function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    onConfirm({ reason: reason.trim(), value: numValue, balance: niBalance });
  }

  return (
    <>
      <div className="pg-acc-backdrop" onClick={() => { if (!busy) onClose(); }} />
      <form ref={dialogRef} tabIndex={-1} className="pg-acc-modal" role="dialog" aria-modal="true" aria-labelledby="pg-acc-action-title" onSubmit={submit}>
        <h2 id="pg-acc-action-title" className="pg-acc-modal__title">{ACTION_LABEL[action]} · {client.client}, {month}</h2>

        {action === "acknowledge" && (
          <>
            <p>Worked hours for {month} changed after the month closed{cell.flaggedFromHours != null ? `, from ${fmtH(cell.flaggedFromHours)} h to ${fmtH(cell.workedHours)} h` : ""}. The balance already uses the new hours. Acknowledging clears the warning; it comes back only if the hours change again.</p>
          </>
        )}

        {action === "write_off" && (
          <>
            <p>Sets the balance carried out of {month} by agreement. {month}'s own computed figure still shows; {next} starts from the value below instead.</p>
            <div className="pg-acc-working">Closing balance now: {balanceText(before)}</div>
            <label className="pg-field">
              <span className="pg-field__label">Carry into {next} (h; positive = over-serviced, negative = unused, 0 = nothing)</span>
              <input className="pg-input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
          </>
        )}

        {action === "remove_write_off" && (
          <>
            <p>Removes the write-off on {month}; {next} goes back to carrying the computed balance.</p>
            <div className="pg-acc-working">Written off to: {balanceText(cell.resetValue)}<br />Computed balance: {balanceText(cell.accrualValue)}</div>
            {cell.resetNote && <p>{cell.resetNote}</p>}
          </>
        )}

        {action === "not_invoiced" && (
          <>
            <p>{month}'s package was not invoiced, so its package hours don't count: the closing balance becomes the worked hours against the balance carried in. The month is then frozen (not recomputed) and Client Accruals shows this working on the {next} invoice.</p>
            <div className="pg-acc-working">
              Carried in: {fmtH(prior)} h<br />
              + worked: {fmtH(cell.workedHours ?? 0)} h<br />
              = closing balance: {balanceText(niBalance)} (was {balanceText(cell.accrualValue)})
            </div>
          </>
        )}

        {action === "undo_not_invoiced" && (
          <p>Turns {month} back into a normal package month; the recompute that follows recalculates it (and every later month) from ClickUp hours.</p>
        )}

        <label className="pg-field">
          <span className="pg-field__label">{REASON_REQUIRED.has(action) ? "Reason (required, kept on the month, in the client's notes and history)" : "Note (optional)"}</span>
          <textarea ref={reasonRef} className="pg-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={action === "write_off" ? "e.g. Written off at Lynda's request" : ""} />
        </label>

        {error && <div className="pg-banner-warn" style={{ marginTop: 0 }}>{error}</div>}

        <div className="pg-acc-modal__foot">
          <button type="button" className="pg-btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="pg-btn" disabled={!canSubmit}>{busy ? "Saving…" : ACTION_LABEL[action]}</button>
        </div>
      </form>
    </>
  );
}
