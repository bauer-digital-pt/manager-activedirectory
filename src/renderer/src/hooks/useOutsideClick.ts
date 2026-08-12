import { useEffect, useRef } from "react";

// Close a popover/menu when a pointer press lands outside it (and, optionally,
// on Escape). Returns a ref to attach to the container element. The effect is
// gated by `enabled` so it only listens while the thing is open. `onClose` is
// read through a ref so callers can pass an inline closure without re-binding
// the listeners on every render.
export function useOutsideClick<T extends HTMLElement = HTMLElement>(
  enabled: boolean,
  onClose: () => void,
  opts: { escape?: boolean } = {},
): React.RefObject<T> {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const escape = opts.escape ?? false;

  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    document.addEventListener("mousedown", onDown);
    let onKey: ((e: KeyboardEvent) => void) | undefined;
    if (escape) {
      onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
      document.addEventListener("keydown", onKey);
    }
    return () => {
      document.removeEventListener("mousedown", onDown);
      if (onKey) document.removeEventListener("keydown", onKey);
    };
  }, [enabled, escape]);

  return ref;
}
