import { useCallback, useEffect, useRef, useState } from "react";

// Copy text to the clipboard and flip a transient `copied` flag so a button can
// show a "Copiado!" confirmation, auto-clearing after `timeoutMs`. A clipboard
// that's unavailable (permissions, insecure context) fails silently — the same
// swallow-and-ignore the inline versions did. The pending timer is cleared on
// unmount so it never fires against a gone component.
export function useCopyFeedback(timeoutMs = 2000): {
  copied: boolean;
  copy: (text: string) => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), timeoutMs);
    } catch { /* clipboard indisponível — ignorar silenciosamente */ }
  }, [timeoutMs]);

  return { copied, copy };
}
