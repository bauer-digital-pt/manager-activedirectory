/**
 * QR Code encoding for label rendering.
 *
 * Delegates to `qrcode` (node-qrcode) — a widely-used, spec-conformant
 * implementation — rather than a hand-rolled encoder. `QRCode.create()` is pure
 * (no DOM, no Node built-ins, no I/O), so the same symbol is produced in the
 * Electron main process, in `node --test`, and in the Vite renderer preview. It
 * returns a module bit-matrix, which this wrapper reshapes into the row-major
 * `boolean[][]` that `MonoCanvas.blitMatrix` (and `renderLabel`) consume.
 *
 * Only the matrix is used here; the library's PNG/SVG/canvas renderers are not
 * touched, so nothing pulls in `fs`/`canvas` on the renderer side.
 */
import * as QRCode from "qrcode";
import type { QRCodeMaskPattern } from "qrcode";

// --- Public types -----------------------------------------------------------

/** Error-correction level (recovery capacity: L≈7%, M≈15%, Q≈25%, H≈30%). */
export type Ecc = "L" | "M" | "Q" | "H";

export interface QrCode {
  /** QR version 1..40 (symbol size = version*4 + 17 modules per side). */
  version: number;
  /** Modules per side. */
  size: number;
  ecc: Ecc;
  /** Applied data mask 0..7. */
  mask: number;
  /** Row-major module grid; `true` = dark module. */
  modules: boolean[][];
}

export interface QrOptions {
  /** Error-correction level (default "M"). */
  ecc?: Ecc;
  /** Pin a mask 0..7; omit for the library's automatic (penalty-based) choice. */
  mask?: number;
}

/**
 * Encode `text` into a QR symbol (auto-selecting the smallest fitting version and
 * lowest-penalty mask unless one is pinned). Returns the module matrix plus the
 * version / size / mask the library chose.
 *
 * Throws on an empty payload — an empty QR "scans" to nothing and is useless on a
 * label; surfacing it lets the preview show a clear error instead of a blank code
 * that looks fine but opens nothing.
 */
export function encodeQr(text: string, opts: QrOptions = {}): QrCode {
  const ecc = opts.ecc ?? "M";

  if (text.length === 0) {
    throw new Error("QR payload is empty (no asset URL to encode)");
  }
  if (
    opts.mask !== undefined &&
    (!Number.isInteger(opts.mask) || opts.mask < 0 || opts.mask > 7)
  ) {
    throw new Error(`QR mask must be an integer 0..7 (got ${opts.mask})`);
  }

  let qr: ReturnType<typeof QRCode.create>;
  try {
    qr = QRCode.create(text, {
      errorCorrectionLevel: ecc,
      ...(opts.mask !== undefined
        ? { maskPattern: opts.mask as QRCodeMaskPattern }
        : {}),
    });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    // node-qrcode: "The amount of data is too big to be stored in a QR Code".
    // Re-throw with the stable "too long" wording the callers/tests expect.
    if (/too big|overflow/i.test(msg)) {
      throw new Error(
        `QR payload too long: ${text.length} chars exceeds version 40 / ecc ${ecc} (${msg})`,
      );
    }
    throw e;
  }

  const size = qr.modules.size;
  const data = qr.modules.data; // row-major flat Uint8Array of 0/1
  const modules: boolean[][] = new Array<boolean[]>(size);
  for (let r = 0; r < size; r++) {
    const row = new Array<boolean>(size);
    const base = r * size;
    for (let c = 0; c < size; c++) row[c] = data[base + c] !== 0;
    modules[r] = row;
  }

  return {
    version: qr.version,
    size,
    ecc,
    mask: qr.maskPattern ?? 0,
    modules,
  };
}
