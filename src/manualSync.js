// "Sync now" for Client Invoicing. triggerManualSync runs both months and throws if either
// failed -- but one month succeeding still changed the stored entries, so the data is always
// reloaded; the error is reported alongside rather than instead of the fresh data. Pure
// orchestration (dependencies injected) so it's testable without Supabase.
export async function runManualSync({ trigger, fetchLive, fetchMeta }) {
  let error = null;
  try { await trigger(); } catch (e) { error = e; }
  let live = null, meta = null;
  try { live = await fetchLive(); } catch (e) { error = error || e; }
  try { meta = await fetchMeta(); } catch (e) { /* status pill only -- not worth masking the real error */ }
  return { live, meta, error };
}
