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
import { inventoryAPI } from "../inventoryAPI";
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
  codedUrl,
  templateUrl,
  toast,
  onClose,
}: {
  device: ConsolidatedDevice;
  // The exact coded EZOffice QR URL (…/a/<seq>?c=<code>) if already known from the
  // API. Usually empty now that the list read is QR-less — resolved on demand from
  // device.assetId. A scan of THIS opens the public asset page without a login.
  codedUrl?: string;
  // Settings URL-template fallback (…/a/{id} with no ?c= code). Used ONLY when no
  // coded URL is available; a scan of it may not open the public view without a
  // session. It must never shadow the coded URL, or the fetch below is dead code.
  templateUrl?: string;
  toast?: Toast;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const printRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const known = (codedUrl ?? "").trim();
  const template = (templateUrl ?? "").trim();
  // The coded EZOffice label URL (…/a/<seq>?c=<code>) is no longer carried on the
  // device-list read (that per-asset lookup is rate-limited and stalled the list),
  // so when we don't already have one we fetch THIS asset's link on demand. The
  // Settings template does NOT gate this — a coded ?c= URL always wins over the
  // code-less template, so the fetch runs even when a template is configured.
  //   qrState "idle"     — nothing to fetch (coded URL already known, or AD-only)
  //           "loading"  — fetch in flight
  //           "resolved" — got a URL (fetchedUrl set)
  //           "none"     — asset has no public link (public pages disabled)
  //           "error"    — the lookup failed (connectivity / auth)
  const needsFetch = !known && !!device.assetId;
  const [qrState, setQrState] = useState<"idle" | "loading" | "resolved" | "none" | "error">(
    needsFetch ? "loading" : "idle",
  );
  const [fetchedUrl, setFetchedUrl] = useState<string>("");
  // Guard the backdrop dismiss: only close when both the press AND the release
  // land on the backdrop, so a drag that starts inside the card (e.g. selecting
  // the dimension caption) and releases outside doesn't close the preview.
  const mouseDownInside = useRef(false);
  // Trap focus inside the dialog panel while open, wire Escape, and focus the
  // primary "Imprimir" button on open so Enter prints (not the header ✕, which
  // would otherwise take initial focus and make Enter dismiss the dialog).
  const trapRef = useFocusTrap<HTMLDivElement>(true, {
    onEscape: onClose,
    onEnter: () => void doPrint(),
    initialFocus: printRef,
  });

  // Fetch the asset's coded label URL on demand (one API call, only when needed).
  // A resolved URL becomes the QR payload; a missing link ("none") or a failed
  // lookup ("error") falls back to the template (if any), else a QR-less label —
  // each with its own note below.
  useEffect(() => {
    if (!needsFetch) {
      // Nothing to resolve (coded URL already known, or no asset). Clear any stale
      // "loading" so the print button can't get stuck if needsFetch flips false.
      setQrState("idle");
      return;
    }
    let cancelled = false;
    setQrState("loading");
    void inventoryAPI
      .getAssetPublicLink(device.assetId as string)
      .then((r) => {
        if (cancelled) return;
        if (r.ok && r.data) {
          const url = (r.data.qr_url ?? "").trim();
          if (url) { setFetchedUrl(url); setQrState("resolved"); }
          else setQrState("none");
        } else {
          setQrState("error");
        }
      })
      .catch(() => { if (!cancelled) setQrState("error"); });
    return () => { cancelled = true; };
  }, [needsFetch, device.assetId]);

  // Precedence: the coded API URL (already known, else resolved on demand) always
  // wins; the Settings template is only a last-resort fallback (no ?c= check code).
  const codedPayload = known || fetchedUrl;
  const usingTemplate = !codedPayload && !!template; // the QR (if any) is the fallback
  const effectivePayload = codedPayload || template;
  const model = useMemo(() => buildLabelModel(device, effectivePayload), [device, effectivePayload]);

  // The note under the preview, driven by what actually ends up in the QR:
  //   - coded URL      → ideal, no note
  //   - template only  → why it's not the public coded link (error / none)
  //   - no QR at all   → why there's no QR (error / none / AD-only)
  const qrNote = useMemo<{ text: string; tone: string } | null>(() => {
    if (qrState === "loading" || codedPayload) return null;
    if (usingTemplate) {
      if (qrState === "error")
        return { tone: "text-amber-600", text: "Não foi possível obter o URL público do ativo (erro de ligação à API de inventário). A etiqueta usa o URL configurado em Definições — tenta novamente para o link público." };
      if (qrState === "none")
        return { tone: "text-amber-600", text: "Este ativo não tem link público no EZOffice. A etiqueta usa o URL configurado em Definições (pode não abrir a vista pública sem sessão)." };
      return null; // AD-only with a {name}/{serial} template: the template is the intended payload here
    }
    if (qrState === "error")
      return { tone: "text-amber-600", text: "Não foi possível obter o URL do ativo (erro de ligação à API de inventário). A etiqueta será impressa sem QR — tenta novamente." };
    if (qrState === "none")
      return { tone: "text-amber-600", text: "Este ativo não tem link público no EZOffice, por isso a etiqueta é impressa sem QR." };
    return { tone: "text-amber-600", text: "Dispositivo sem ativo no EZOffice — a etiqueta será impressa sem QR. Podes definir um modelo de URL em Definições para o botão de ligação." };
  }, [qrState, codedPayload, usingTemplate]);

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

  const unavailable = transportMode() === "none";

  const doPrint = async () => {
    // Hold off while the QR URL is still resolving so we don't print a QR-less
    // label a beat before the code arrives.
    if (!render.ok || busy || unavailable || qrState === "loading") return;
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
                {render.value.width}×{render.value.height} pontos
                {render.value.qr
                  ? ` · QR v${render.value.qr.version} (ecc ${render.value.qr.ecc})`
                  : " · sem QR"}
              </p>
              {qrState === "loading" && (
                <p role="status" className="max-w-xs text-center text-xs text-zinc-500">
                  A obter o URL do ativo do EZOffice…
                </p>
              )}
              {qrState !== "loading" && qrNote && (
                <p role="status" className={cn("max-w-xs text-center text-xs", qrNote.tone)}>
                  {qrNote.text}
                </p>
              )}
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
          <Button
            ref={printRef}
            onClick={doPrint}
            disabled={!render.ok || busy || unavailable || qrState === "loading"}
          >
            <Printer size={14} />
            {busy ? "A imprimir…" : qrState === "loading" ? "A obter URL…" : "Imprimir"}
          </Button>
        </div>
      </div>
    </div>
  );
}
