import { useEffect, useRef } from "react";

// Trap keyboard focus inside an overlay while it's open, then restore focus to
// whatever was focused before it opened. Fixes the app-wide dialog gap where a
// user could Tab past a modal into the chrome behind it (most dangerously the
// lock screen, where Tab reached the sidebar's logout/nav).
//
// Attach the returned ref to the dialog panel. While `active`:
//   - focus moves into the panel on open (initialFocus, else first focusable,
//     else the panel itself),
//   - Tab / Shift+Tab wrap within the panel,
//   - Escape (if `onEscape` given) closes it,
//   - on deactivate/unmount, focus returns to the previously-focused element.
//
// `onEscape` is read through a ref so an inline closure doesn't re-bind listeners
// every render (matching useOutsideClick's contract).
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Stack of the currently-active trap panels (mount order). Only the topmost one
// handles keys, so a modal opened on top of another (e.g. the label-preview
// dialog over a device-detail dialog) doesn't fight the trap underneath it over
// Tab / Shift+Tab / Escape.
const trapStack: HTMLElement[] = [];

export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  active: boolean,
  opts: { onEscape?: () => void; initialFocus?: React.RefObject<HTMLElement> } = {},
): React.RefObject<T> {
  const ref = useRef<T>(null);
  const onEscapeRef = useRef(opts.onEscape);
  onEscapeRef.current = opts.onEscape;
  const initialFocus = opts.initialFocus;

  useEffect(() => {
    if (!active) return;
    const panel = ref.current;
    if (!panel) return;

    trapStack.push(panel);
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    // Move focus in. Defer so the panel is painted (animations/mount) first.
    const raf = requestAnimationFrame(() => {
      const target = initialFocus?.current ?? focusables()[0] ?? panel;
      if (!panel.contains(document.activeElement)) target.focus();
    });

    const onKey = (e: KeyboardEvent): void => {
      // Only the topmost trap reacts, so keys don't reach a trap layered beneath.
      if (trapStack[trapStack.length - 1] !== panel) return;
      if (e.key === "Escape" && onEscapeRef.current) {
        e.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      // Wrap at either boundary, and also pull focus back in if it's sitting on
      // the panel container itself (tabIndex=-1, focused by a click on an inert
      // area) or has somehow escaped the panel — otherwise Shift+Tab from the
      // panel would walk out into the chrome behind the modal.
      const outside = !activeEl || !panel.contains(activeEl);
      if (e.shiftKey && (activeEl === first || activeEl === panel || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (activeEl === last || activeEl === panel || outside)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      const i = trapStack.indexOf(panel);
      if (i !== -1) trapStack.splice(i, 1);
      // Restore focus only if it's still inside the (closing) panel, so we don't
      // yank focus away from wherever the app legitimately moved it.
      if (previouslyFocused && panel.contains(document.activeElement)) {
        previouslyFocused.focus?.();
      }
    };
  }, [active, initialFocus]);

  return ref;
}
