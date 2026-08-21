// A styled, accessible replacement for window.confirm — used for the app's
// consequential confirmations (reset onboarding config, cancel an in-flight
// PC onboarding, discard an unsaved user). Native confirm() is unstyled, breaks
// the frameless-window look, and can't express a destructive tone. Built on
// Modal, so it inherits the focus trap, dialog semantics and Escape handling.
//
// Controlled by `open`; resolve the choice via onConfirm / onCancel. The confirm
// button takes initial focus for keyboard users; `tone="danger"` colours it red.
import { useRef } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body copy — string or rich content. */
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  tone = "default",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.ReactElement | null {
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onCancel}
      title={title}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      initialFocus={confirmRef}
      // Enter confirms from anywhere in the dialog (not just while the confirm
      // button holds focus); suppressed while an action is in flight.
      onEnter={busy ? undefined : onConfirm}
    >
      <div className="mt-2 text-sm text-zinc-600">{message}</div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button
          ref={confirmRef}
          variant={tone === "danger" ? "danger" : "primary"}
          onClick={onConfirm}
          disabled={busy}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
