// Label printing (SUPVAN E11) — renderer-side contract + graceful degradation.
//
// The label RASTER is composed by the pure, dependency-free core under
// src/main/supvan (`renderLabel`), which is isomorphic: it runs unchanged in the
// renderer preview, in `node --test`, and in the Electron main process. So the
// in-app preview draws the exact bytes that will be printed — no divergence.
//
// The actual PRINT (bytes → Bluetooth → E11) lives in the main process because it
// owns the transport. This module only defines the IPC contract and a wrapper
// that no-ops cleanly when the bridge is absent (browser preview, or before the
// transport lands), mirroring lib/updates.ts. Nothing here needs the hardware.
import type { PSResult } from "../../../shared/types";
import type { LabelModel, LabelStyle } from "../../../main/supvan/label.ts";
import { labelToJob, fitLabelStyle } from "../../../main/supvan/label.ts";
import { E11_GEOMETRY, DEFAULT_GEOMETRY, type Geometry } from "../../../main/supvan/job.ts";
import { SupvanClient, type PrintEvent, type PrintJob } from "../../../main/supvan/pipeline.ts";
import type { LzmaAloneEncoder } from "../../../main/supvan/compress.ts";
import {
  CANDIDATE_TRANSPORT_CONFIGS,
  resolveTransportConfig,
  type TransportConfig,
} from "../../../main/supvan/transport/config.ts";
import { connectWebBtPrinter } from "./supvan-webbt";
import type { ConsolidatedDevice } from "./devices";

/** A printer the main process discovered (Bluetooth / serial). */
export interface PrintDeviceInfo {
  /** Stable, machine-local identifier used to select the printer. */
  id: string;
  /** Human-readable name for the picker. */
  name: string;
  /** Transport hint ("bluetooth" | "serial" | …), for display only. */
  kind?: string;
}

/**
 * A print job as the renderer hands it to main. We send the human-readable model
 * (+ optional style) rather than a packed bitmap: `renderLabel` is deterministic
 * and shared, so main re-renders identical bytes. `meta` is for logging/receipts.
 */
export interface LabelPrintRequest {
  model: LabelModel;
  style?: LabelStyle;
  meta?: { assetId?: string; serial?: string; name?: string };
}

/** What a successful print reports back (frame count / duration are filled later). */
export interface LabelPrintResult {
  deviceId?: string;
  frames?: number;
  compressedLen?: number;
}

declare global {
  interface Window {
    // Electron-only bridge; optional so the browser-mock build type-checks. When
    // absent, the wrapper below degrades to a clear "unavailable" PSResult.
    printAPI?: {
      listDevices(): Promise<PSResult<PrintDeviceInfo[]>>;
      printLabel(req: LabelPrintRequest): Promise<PSResult<LabelPrintResult>>;
    };
  }
}

const UNAVAILABLE = "Impressão de etiquetas indisponível neste ambiente.";

/**
 * Safe wrapper over `window.printAPI`. In the browser preview — or before the
 * Bluetooth transport is wired (Phase 3) — `window.printAPI` is undefined and
 * every call resolves to `{ ok: false, error }` instead of throwing.
 */
export const printAPI = {
  listDevices: (): Promise<PSResult<PrintDeviceInfo[]>> =>
    window.printAPI?.listDevices() ?? Promise.resolve({ ok: false, error: UNAVAILABLE }),
  printLabel: (req: LabelPrintRequest): Promise<PSResult<LabelPrintResult>> =>
    window.printAPI?.printLabel(req) ?? Promise.resolve({ ok: false, error: UNAVAILABLE }),
};

/** True when the main-process print bridge is present (i.e. running in Electron). */
export const isPrintingAvailable = (): boolean => typeof window.printAPI !== "undefined";

/**
 * Which transport a print would take right now.
 *  - "webbt": Web Bluetooth is usable — a secure context, navigator.bluetooth is
 *    present, AND the main-process device-picker bridge (window.bleAPI) is wired.
 *    This is the real E11 path (renderer opens GATT; main runs the chooser).
 *  - "rfcomm": no Web Bluetooth, but the legacy main-process print bridge exists
 *    (window.printAPI) — reserved for a future Classic-BT/serial transport.
 *  - "none": neither (browser mock / pre-transport) — the UI shows an honest note.
 */
export type TransportMode = "webbt" | "rfcomm" | "none";

export function transportMode(): TransportMode {
  const hasWebBt =
    typeof navigator !== "undefined" &&
    typeof (navigator as { bluetooth?: unknown }).bluetooth !== "undefined" &&
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof window.bleAPI !== "undefined";
  if (hasWebBt) return "webbt";
  if (isPrintingAvailable()) return "rfcomm";
  return "none";
}

/**
 * The printhead geometry a print would ACTUALLY use right now — so the preview can
 * fit the label to it and show the exact bytes that will print (no divergence).
 *  - "rfcomm": the legacy main-process bridge re-renders on the wide DEFAULT_GEOMETRY.
 *  - "webbt"/"none": the narrow E11 head (the real target) — preview it there even
 *    when no transport is wired, since that is the hardware the label is made for.
 */
export function activePrintGeometry(): Geometry {
  return transportMode() === "rfcomm" ? DEFAULT_GEOMETRY : E11_GEOMETRY;
}

/**
 * Shown (preview + print) when a label cannot fit across the tape even with the QR
 * shrunk to its minimum scale — e.g. a very long asset URL on the 12 mm head.
 * Portuguese, actionable: the print path would otherwise surface the core's raw
 * English "reduce the scale or change quarterTurns" guard error to the operator.
 */
export const LABEL_TOO_WIDE =
  "A etiqueta é demasiado larga para a fita, mesmo com o QR no tamanho mínimo. Use uma fita mais larga ou reduza o conteúdo.";

/**
 * Shown when requestDevice() ends without a device. Chromium raises the same
 * NotFoundError whether the operator cancelled the chooser OR no printer was
 * offered, so this covers both with an actionable PT message instead of the raw
 * English "User cancelled the requestDevice() chooser." the operator was seeing.
 */
export const PRINTER_SELECTION_CANCELLED =
  "Nenhuma impressora Bluetooth foi selecionada. Certifique-se de que a impressora SUPVAN está ligada e por perto, e tente imprimir novamente.";

/** True when a requestDevice() rejection means "no device chosen" (user cancel or
 * nothing offered) rather than a real transport error — Chromium uses NotFoundError
 * for both; some builds only carry the cancellation text. */
function isDeviceSelectionCancelled(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  const message = (e as Error)?.message ?? "";
  return name === "NotFoundError" || /cancel/i.test(message);
}

/**
 * The injected LZMA-alone encoder backend. The SUPVAN core keeps compression
 * pluggable and bundles NO backend (Phase 2 = pick the backend once the transport
 * is settled). The app now picks the pure-TS backend and registers it at startup
 * (src/renderer/src/main.tsx → setLabelEncoder(lzmaAloneEncode)): no native deps,
 * so it ships in the unsigned two-flavor build unchanged. It is round-trip
 * validated against Python's canonical FORMAT_ALONE decoder in
 * test/supvan/lzma-encode.test.ts. If a backend is somehow NOT registered, the Web
 * Bluetooth path declines with an honest message instead of printing.
 */
let labelEncoder: LzmaAloneEncoder | null = null;
export function setLabelEncoder(encode: LzmaAloneEncoder | null): void {
  labelEncoder = encode;
}
export function getLabelEncoder(): LzmaAloneEncoder | null {
  return labelEncoder;
}

/** Options for a direct Web Bluetooth print. */
export interface BlePrintOptions {
  /** Printhead geometry (defaults to E11_GEOMETRY — 12 mm × 22 mm / 3 mm-gap media; ⚠ verify dpi at bring-up). */
  geometry?: Geometry;
  /** Physical-orientation knob passed to labelToJob (default 1 quarter-turn). */
  quarterTurns?: number;
  /** Force a single concrete transport config (skips candidate auto-probe). */
  transport?: Partial<TransportConfig>;
  /** Override the full candidate probe list. */
  candidates?: readonly TransportConfig[];
  /** Progress / diagnostics callback from the print state machine. */
  onEvent?: (event: PrintEvent) => void;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
}

/** Candidate probe list for a Web BT print, honoring any override. */
function bleCandidates(opts: BlePrintOptions): readonly TransportConfig[] {
  if (opts.candidates) return opts.candidates;
  if (opts.transport) return [resolveTransportConfig(opts.transport)];
  return CANDIDATE_TRANSPORT_CONFIGS;
}

/**
 * Print a label over Web Bluetooth, straight from the renderer.
 *
 * The label raster + LZMA job are built with the SHARED pure core (identical bytes
 * to the preview), then streamed to the E11 through the tested runPrintJob state
 * machine over a GATT-backed SppPipe.
 *
 * GESTURE CONSTRAINT: connectWebBtPrinter() calls requestDevice(), which must run
 * inside the user gesture. Everything before it here (renderLabel + labelToJob) is
 * SYNCHRONOUS, so callers must invoke this with NO await between the click and this
 * call. `encode` must be supplied by the caller (see getLabelEncoder) so a missing
 * backend is caught before the picker opens.
 */
export async function printLabelViaBle(
  req: LabelPrintRequest,
  encode: LzmaAloneEncoder,
  opts: BlePrintOptions = {},
): Promise<PSResult<LabelPrintResult>> {
  // --- synchronous prelude (keeps requestDevice inside the gesture) ---
  let job: PrintJob;
  try {
    const geom = opts.geometry ?? E11_GEOMETRY;
    // Fit the QR to the (narrow) E11 head before packing: a scannable asset URL is
    // QR v4+ and overflows the head at the default scale, so shrink it to fit
    // rather than throwing the core's raw English guard error at print time. Same
    // deterministic fit the preview used, so the printed bytes match the preview.
    const fit = fitLabelStyle(req.model, geom, req.style ?? {}, { quarterTurns: opts.quarterTurns });
    if (!fit) return { ok: false, error: LABEL_TOO_WIDE };
    job = labelToJob(fit.render, geom, encode, { quarterTurns: opts.quarterTurns });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // requestDevice() fires here — still no prior await on the happy path.
  let conn: Awaited<ReturnType<typeof connectWebBtPrinter>>;
  try {
    conn = await connectWebBtPrinter(bleCandidates(opts));
  } catch (e) {
    if (isDeviceSelectionCancelled(e)) return { ok: false, error: PRINTER_SELECTION_CANCELLED };
    return { ok: false, error: (e as Error).message };
  }

  try {
    const client = new SupvanClient(conn.pipe);
    await client.runPrintJob(job, { onEvent: opts.onEvent, signal: opts.signal });
    return {
      ok: true,
      data: {
        deviceId: conn.device.id ?? conn.device.name,
        frames: job.frames.length,
        compressedLen: job.compressedLen,
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    await conn.disconnect().catch(() => {});
  }
}

/**
 * Map a consolidated device (+ its resolved EZOffice URL) into a label model:
 * the QR encodes the asset URL (scanning it opens the asset), and the text lines
 * carry the name, serial, asset id and department — whichever are present.
 */
export function buildLabelModel(device: ConsolidatedDevice, qrPayload: string): LabelModel {
  const lines: string[] = [];
  const name = device.displayName || device.name;
  if (name) lines.push(name);
  if (device.serialNumber) lines.push(`SN ${device.serialNumber}`);
  if (device.assetId) lines.push(`EZ ${device.assetId}`);
  if (device.department) lines.push(device.department);
  return { qr: qrPayload || device.assetId || name || "", lines };
}
