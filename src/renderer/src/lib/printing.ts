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
import { renderLabel, labelToJob } from "../../../main/supvan/label.ts";
import { DEFAULT_GEOMETRY, type Geometry } from "../../../main/supvan/job.ts";
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
 * The injected LZMA-alone encoder backend. The SUPVAN core keeps compression
 * pluggable and bundles NO backend (that choice — pure-JS vs WASM for the renderer
 * — is deliberately deferred to Phase 2/5). Until a backend is registered here,
 * the Web Bluetooth path declines with an honest message instead of printing.
 *
 * TODO(bring-up, 13:00 hardware): register a verified LZMA-alone encoder via
 * setLabelEncoder() (props byte 0x5d, 8 KiB dict — see compress.ts).
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
  /** Printhead geometry (defaults to the T50 reference; E11 override at bring-up). */
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
    const render = renderLabel(req.model, req.style ?? {});
    const geom = opts.geometry ?? DEFAULT_GEOMETRY;
    job = labelToJob(render, geom, encode, { quarterTurns: opts.quarterTurns });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // requestDevice() fires here — still no prior await on the happy path.
  let conn: Awaited<ReturnType<typeof connectWebBtPrinter>>;
  try {
    conn = await connectWebBtPrinter(bleCandidates(opts));
  } catch (e) {
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
