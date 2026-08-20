// Label preview + print dialog for a single device.
//
// Renders the REAL `renderLabel` pipeline (the same pure code that will drive the
// printer) onto a <canvas>, so the operator sees exactly what will be printed
// before committing. The composition is entirely client-side and needs no
// hardware; the "Imprimir" button routes through `printAPI`, which degrades
// gracefully (a clear toast) until the Bluetooth transport is wired.
import { useEffect, useMemo, useRef, useState } from "react";
import { Printer, X } from "lucide-react";
import { fitLabelStyle } from "../../../main/supvan/label.ts";
import type { MonoBitmap } from "../../../main/supvan/mono.ts";
import type { ConsolidatedDevice } from "../lib/devices";
import {
  activePrintGeometry,
  buildLabelModel,
  getLabelEncoder,
  LABEL_TOO_WIDE,
  printAPI,
  printLabelViaBle,
  transportMode,
} from "../lib/printing";
import { cn } from "../lib/cn";
import { Button } from "./ui/Button";
import { focusRing } from "./ui/controls";
import { useFocusTrap } from "../hooks/useFocusTrap";

type Toast = { success: (m: string) => void; error: (m: string) => void };

/** Read a pixel from a row-major MSB-first bitmap (dark = 1). */
function bitAt(bmp: MonoBitmap, x: number, y: number): boolean {
  return ((bmp.data[y * bmp.bytesPerLine + (x >> 3)] >> (7 - (x & 7))) & 1) !== 0;
}

/** Paint a MonoBitmap onto a canvas at integer `zoom` (light tape, dark dots). */
function paint(canvas: HTMLCanvasElement, bmp: MonoBitmap, zoom: number): void {
  canvas.width = bmp.width * zoom;
  canvas.height = bmp.height * zoom;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#f7f4ec"; // light tape
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#141414"; // thermal dots
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      if (bitAt(bmp, x, y)) ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
    }
  }
}

export default function LabelPreviewModal({
  device,
  qrPayload,
  toast,
  onClose,
}: {
  device: ConsolidatedDevice;
  qrPayload: string;
  toast?: Toast;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [busy, setBusy] = useState(false);
  // Guard the backdrop dismiss: only close when both the press AND the release
  // land on the backdrop, so a drag that starts inside the card (e.g. selecting
  // the dimension caption) and releases outside doesn't close the preview.
  const mouseDownInside = useRef(false);
  // Trap focus inside the dialog panel while open, wire Escape, and restore focus
  // to the trigger on close — replaces the manual focus-on-open + Esc listener.
  const trapRef = useFocusTrap<HTMLDivElement>(true, { onEscape: onClose });

  const model = useMemo(() => buildLabelModel(device, qrPayload), [device, qrPayload]);

  // Compose once per model, fitting the QR to the printhead the print will actually
  // use (E11 heads are narrow; a URL QR overflows the default scale). This is the
  // SAME deterministic fit printLabelViaBle applies, so the preview shows the exact
  // bytes that will print. A render error (payload too long for any QR) or an
  // impossible fit is surfaced inline rather than crashing the dialog.
  const render = useMemo(() => {
    try {
      const fit = fitLabelStyle(model, activePrintGeometry());
      if (!fit) return { ok: false as const, error: LABEL_TOO_WIDE };
      return { ok: true as const, value: fit.render };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [model]);

  // Paint whenever the composition changes. Zoom to a comfortable on-screen size.
  useEffect(() => {
    if (!render.ok || !canvasRef.current) return;
    const bmp = render.value.bitmap;
    const zoom = Math.max(1, Math.min(6, Math.floor(520 / Math.max(1, bmp.width))));
    paint(canvasRef.current, bmp, zoom);
  }, [render]);

  const doPrint = async () => {
    if (!render.ok || busy) return;
    setBusy(true);
    try {
      const meta = { assetId: device.assetId, serial: device.serialNumber, name: device.displayName || device.name };
      let res: Awaited<ReturnType<typeof printAPI.printLabel>>;
      if (transportMode() === "webbt") {
        // Web Bluetooth path: requestDevice() must fire inside this user gesture, so
        // do NOT await anything before printLabelViaBle (its prelude is synchronous).
        const encode = getLabelEncoder();
        if (!encode) {
          // Defensive only: main.tsx registers the pure-TS LZMA-alone encoder at
          // startup, so this should never fire. If it does, the backend failed to
          // register — log it for diagnosis and give the operator a plain note.
          console.warn(
            "[label] Web Bluetooth transport ready but no LZMA-alone encoder registered — " +
              "setLabelEncoder() did not run at startup (see main.tsx).",
          );
          res = {
            ok: false,
            error: "A impressão por Bluetooth ainda não está disponível nesta versão.",
          };
        } else {
          res = await printLabelViaBle({ model, meta }, encode);
        }
      } else {
        res = await printAPI.printLabel({ model, meta });
      }
      if (res.ok) toast?.success("Etiqueta enviada para impressão.");
      else toast?.error(res.error || "Não foi possível imprimir a etiqueta.");
    } catch (e) {
      toast?.error((e as Error).message || "Falha inesperada ao imprimir.");
    } finally {
      setBusy(false);
    }
  };

  const unavailable = transportMode() === "none";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pré-visualização da etiqueta"
      className="anim-overlay fixed inset-0 z-40 bg-black/30 backdrop-blur-sm flex items-center justify-center"
      onMouseDown={(e) => {
        mouseDownInside.current = e.target !== e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && !mouseDownInside.current) onClose();
      }}
    >
      <div
        ref={trapRef}
        tabIndex={-1}
        className="anim-modal bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 overflow-hidden focus:outline-none"
      >
        <div className="flex items-center gap-2 px-5 py-4 border-b border-zinc-100">
          <Printer size={17} className="text-zinc-500" />
          <h2 className="font-semibold text-zinc-800">Etiqueta — {device.displayName || device.name}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className={cn(
              "ml-auto p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 transition-colors",
              focusRing,
            )}
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5">
          {render.ok ? (
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-lg border border-zinc-200 bg-[#f7f4ec] p-3">
                <canvas ref={canvasRef} style={{ imageRendering: "pixelated" }} />
              </div>
              <p className="text-xs text-zinc-500">
                {render.value.width}×{render.value.height} pontos · QR v{render.value.qr.version} (ecc {render.value.qr.ecc})
              </p>
            </div>
          ) : (
            <p role="alert" className="text-sm text-red-600 break-words whitespace-pre-wrap">Não foi possível compor a etiqueta: {render.error}</p>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-4 border-t border-zinc-100 bg-zinc-50/60">
          {unavailable && (
            <span role="status" className="mr-auto text-xs text-amber-600">
              Impressão indisponível neste ambiente (sem transporte Bluetooth).
            </span>
          )}
          <Button variant="ghost" onClick={onClose} className="ml-auto">
            Fechar
          </Button>
          <Button onClick={doPrint} disabled={!render.ok || busy || unavailable}>
            <Printer size={14} />
            {busy ? "A imprimir…" : "Imprimir"}
          </Button>
        </div>
      </div>
    </div>
  );
}
