import { useEffect, useState } from "react";
import { Minus, Square, X } from "lucide-react";
import { cn } from "../lib/cn";
import { focusRing } from "./ui/controls";

// Custom top bar for the frameless window. It provides the draggable region the
// OS chrome used to (via `.drag`), and on Windows/Linux the minimize / maximize
// / close controls the missing frame no longer offers. On macOS the native
// traffic lights remain (titleBarStyle:"hidden"), so we only reserve space for
// them and render no buttons.
//
// Rendered ONCE, above every gate/screen — so login, setup, and the main app
// are all draggable and closable.
export default function TitleBar() {
  const platform = window.appAPI?.platform ?? "browser";
  const isMac = platform === "darwin";
  // Windows/Linux get custom controls. In the browser preview there's no
  // windowAPI, so we render a plain (non-functional) bar for layout parity.
  const showControls = !isMac && platform !== "browser";
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const onResize = () => setMaximized(window.outerWidth >= screen.availWidth - 4);
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <div
      className="drag flex-shrink-0 flex items-center h-8 bg-white border-b border-zinc-100 select-none"
      style={{ paddingLeft: isMac ? 78 : 0 }}
    >
      <div className="flex-1 h-full" />
      {showControls && (
        <div className="no-drag flex items-stretch h-full">
          <button
            type="button"
            onClick={() => window.windowAPI?.minimize()}
            className={cn(
              "w-11 h-full flex items-center justify-center text-zinc-500 hover:bg-zinc-100 transition-colors",
              focusRing,
            )}
            title="Minimizar"
            aria-label="Minimizar"
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            onClick={() => window.windowAPI?.toggleMaximize()}
            className={cn(
              "w-11 h-full flex items-center justify-center text-zinc-500 hover:bg-zinc-100 transition-colors",
              focusRing,
            )}
            title={maximized ? "Restaurar" : "Maximizar"}
            aria-label={maximized ? "Restaurar" : "Maximizar"}
          >
            <Square size={12} />
          </button>
          <button
            type="button"
            onClick={() => window.windowAPI?.close()}
            className={cn(
              "w-11 h-full flex items-center justify-center text-zinc-500 hover:bg-red-500 hover:text-white transition-colors",
              focusRing,
            )}
            title="Fechar"
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
