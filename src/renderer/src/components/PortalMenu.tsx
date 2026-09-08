import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

// A row-action dropdown that renders into document.body via a portal and is
// positioned with `position: fixed` against its anchor. Row menus used to be
// `position: absolute` inside the table's `overflow-x-auto` wrapper — but a
// scroll container clips BOTH axes (setting overflow-x:auto forces overflow-y
// to auto too), so the menu was cut off on rows near the container edge (the
// "só aparece numa linha específica" bug). A fixed portal escapes every
// overflow ancestor, and we flip up / cap the height so it never spills off
// screen either.
export default function PortalMenu({
  open,
  onClose,
  anchorRef,
  children,
  width = 224,
  className,
}: {
  open: boolean;
  onClose: () => void;
  /** The trigger element the menu is positioned against (right-aligned to it). */
  anchorRef: RefObject<HTMLElement>;
  children: ReactNode;
  /** Menu width in px (default 224 = Tailwind w-56). */
  width?: number;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<
    { left: number; placement: "up" | "down"; edge: number; maxH: number } | null
  >(null);

  // Position (and reposition on scroll/resize) while open. `edge` is the y we
  // anchor to: the anchor's bottom for a down menu, its top for an up one.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const anchor = anchorRef.current;
    if (!anchor) return;
    const compute = () => {
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const below = vh - r.bottom;
      const above = r.top;
      const down = below >= above;
      const maxH = Math.max(160, Math.min(360, Math.round((down ? below : above) - 12)));
      const left = Math.max(8, Math.min(r.right - width, vw - width - 8));
      setPos({ left, placement: down ? "down" : "up", edge: down ? r.bottom : r.top, maxH });
    };
    compute();
    window.addEventListener("resize", compute);
    // capture: also catch scroll on any ancestor scroll container, not just window.
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open, anchorRef, width]);

  // Own the dismissal: close on an outside mousedown (ignoring the anchor and the
  // portaled panel, which live in different DOM subtrees) or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      style={{
        position: "fixed",
        left: pos.left,
        width,
        maxHeight: pos.maxH,
        ...(pos.placement === "down"
          ? { top: pos.edge + 4 }
          : { bottom: window.innerHeight - pos.edge + 4 }),
      }}
      className={cn(
        "anim-popover z-50 overflow-y-auto rounded-xl border border-zinc-200 bg-white shadow-lg text-left",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
