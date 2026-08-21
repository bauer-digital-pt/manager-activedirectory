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
//   - Enter (if `onEnter` given) triggers the dialog's primary action, UNLESS
//     focus is on a control that owns Enter itself (see consumesEnter),
//   - on deactivate/unmount, focus returns to the previously-focused element.
//
// `onEscape`/`onEnter` are read through refs so an inline closure doesn't re-bind
// listeners every render (matching useOutsideClick's contract).
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Roles whose widgets handle Enter themselves (select an option, activate a menu
// item, etc.). Enter must reach them, not the dialog's primary action.
const ENTER_OWNING_ROLES = new Set([
  "combobox", "listbox", "menu", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "grid", "gridcell", "row", "tab", "tree", "treeitem", "textbox", "searchbox", "spinbutton",
]);

// True when the focused element consumes Enter on its own, so the trap must NOT
// hijack it for the primary action. Covers native line/activation controls
// (textarea newline, button/link/select/summary activation, contenteditable) and
// ARIA widgets that own Enter (SearchableSelect's combobox/listbox, menus, etc.).
// A plain single-line <input> is intentionally NOT here: Enter there should submit
// the dialog, exactly like a form's implicit submission.
function consumesEnter(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A" || tag === "SUMMARY") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.hasAttribute("aria-haspopup") || el.hasAttribute("aria-expanded")) return true;
  const role = el.getAttribute("role");
  return role != null && ENTER_OWNING_ROLES.has(role);
}

// Stack of the currently-active trap panels (mount order). Only the topmost one
// handles keys, so a modal opened on top of another (e.g. the label-preview
// dialog over a device-detail dialog) doesn't fight the trap underneath it over
// Tab / Shift+Tab / Escape.
const trapStack: HTMLElement[] = [];

export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  active: boolean,
  opts: { onEscape?: () => void; onEnter?: () => void; initialFocus?: React.RefObject<HTMLElement> } = {},
): React.RefObject<T> {
  const ref = useRef<T>(null);
  const onEscapeRef = useRef(opts.onEscape);
  onEscapeRef.current = opts.onEscape;
  const onEnterRef = useRef(opts.onEnter);
  onEnterRef.current = opts.onEnter;
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
      // Enter triggers the dialog's primary action — but only when focus rests on
      // something that doesn't own Enter itself. If focus is on the primary button
      // the browser already activates it (so we defer to that, avoiding a double
      // fire); if it's on a textarea, a menu, or SearchableSelect's combobox, Enter
      // belongs to them. This is what makes Enter confirm a dialog from anywhere in
      // it, not only while the primary button happens to hold focus.
      if (
        e.key === "Enter" &&
        onEnterRef.current &&
        !e.isComposing &&
        e.keyCode !== 229 && // IME composition still in progress
        panel.contains(document.activeElement) &&
        !consumesEnter(document.activeElement)
      ) {
        e.preventDefault();
        onEnterRef.current();
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
