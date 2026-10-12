import { useEffect, useRef } from "react";

// Shared outside-click + Escape dismissal for dropdowns/menus/popovers. Attach the
// returned ref to the dismissable container (the thing that should NOT trigger a
// dismiss when clicked inside it). Pass `extraRef` for a second element that should
// also be excluded from the outside-click check (e.g. the trigger button that lives
// outside the menu's own DOM subtree). Pass `onReposition` for menus that also need
// to re-measure/reposition on scroll or resize while open.
export function useDismissable(onDismiss, { extraRef = null, onReposition = null } = {}) {
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        if (extraRef && extraRef.current && extraRef.current.contains(e.target)) return;
        onDismiss();
      }
    };
    const onKey = (e) => { if (e.key === "Escape") onDismiss(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    let onScroll, onResize;
    if (onReposition) {
      onScroll = () => onReposition();
      onResize = () => onReposition();
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onResize);
    }
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      if (onReposition) {
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", onResize);
      }
    };
  }, [onDismiss, extraRef, onReposition]);
  return ref;
}

// Escape-only dismissal for cases with no outside-click container (e.g. a full-screen
// drawer where any outside click doesn't apply).
export function useEscape(onDismiss) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onDismiss(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Focus handling for modal dialogs/drawers. Attach the returned ref to the dialog element
// (give it tabIndex={-1} so it can take focus itself as a last resort). On mount, focus
// moves inside -- to `initialFocusRef`, or the first focusable element -- unless something
// inside already has it (an autoFocus field). Tab / Shift+Tab wrap around inside the
// dialog. On unmount focus returns to whatever had it when the dialog opened (the
// trigger), unless `restoreFocus` is false (a caller that manages that itself).
export function useFocusTrap({ initialFocusRef = null, restoreFocus = true } = {}) {
  const ref = useRef(null);
  // Captured during the first render, before any autoFocus child steals focus at commit.
  const trigger = useRef(undefined);
  if (trigger.current === undefined) trigger.current = typeof document !== "undefined" ? document.activeElement : null;
  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const focusables = () => [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
    if (!root.contains(document.activeElement)) (initialFocusRef?.current || focusables()[0] || root).focus();
    const onKey = (e) => {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (!list.length) { e.preventDefault(); root.focus(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const inside = root.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first || document.activeElement === root)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    const returnTo = trigger.current;
    return () => {
      document.removeEventListener("keydown", onKey);
      if (restoreFocus && returnTo && typeof returnTo.focus === "function" && document.contains(returnTo)) returnTo.focus();
    };
    // Mount/unmount only: re-running would steal focus back on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}
