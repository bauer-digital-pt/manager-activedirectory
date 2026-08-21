// A focus-trapping dialog surface with the app's standard backdrop + card motion
// (anim-overlay / anim-modal) and proper dialog semantics (role="dialog",
// aria-modal, aria-labelledby). Renders nothing when closed. Use for new overlays
// and confirmations; existing bespoke modals can instead adopt useFocusTrap
// directly to avoid restructuring their layout.
import { useId, useRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useFocusTrap } from "../../hooks/useFocusTrap";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Rendered as the dialog heading and wired to aria-labelledby. */
  title?: ReactNode;
  children: ReactNode;
  /** Extra classes for the card (width, etc.). */
  className?: string;
  /** Close when the backdrop is clicked (default true). */
  closeOnBackdrop?: boolean;
  /** Close on Escape (default true). */
  closeOnEscape?: boolean;
  /** Focused when the dialog opens (else the first focusable). */
  initialFocus?: React.RefObject<HTMLElement>;
  /**
   * Primary action fired on Enter from anywhere in the dialog (except controls
   * that own Enter — textareas, buttons, SearchableSelect, etc.). Wire this to
   * the confirm/submit action so keyboard users don't have to Tab to the button.
   */
  onEnter?: () => void;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  closeOnBackdrop = true,
  closeOnEscape = true,
  initialFocus,
  onEnter,
}: ModalProps): React.ReactElement | null {
  const titleId = useId();
  const trapRef = useFocusTrap<HTMLDivElement>(open, {
    onEscape: closeOnEscape ? onClose : undefined,
    onEnter,
    initialFocus,
  });
  const mouseDownInside = useRef(false);

  if (!open) return null;

  return (
    <div
      className="anim-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      // Only close when both the press AND release happen on the backdrop, so a
      // drag that starts inside the card and releases outside doesn't dismiss it.
      onMouseDown={(e) => {
        mouseDownInside.current = e.target !== e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget && !mouseDownInside.current) onClose();
      }}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cn(
          "anim-modal w-full max-w-md rounded-2xl bg-white p-6 shadow-xl outline-none",
          className,
        )}
      >
        {title && (
          <h2 id={titleId} className="text-lg font-semibold text-zinc-900">
            {title}
          </h2>
        )}
        {children}
      </div>
    </div>
  );
}
