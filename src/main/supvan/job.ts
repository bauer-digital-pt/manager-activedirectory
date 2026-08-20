/**
 * High-level job builder: turn a rasterized label into a ready-to-send
 * `PrintJob` (print buffers → single LZMA stream → 512-byte frames + speed).
 * Pure and synchronous apart from the injected LZMA encoder; no transport.
 *
 * Mirrors the buffer/compress/speed ordering in test_print.py::do_test_print.
 */
import {
  splitIntoBuffers,
  rasterToColumnMajor,
  centerInPrinthead,
} from "./raster.ts";
import { compressBuffersForPrint, type LzmaAloneEncoder } from "./compress.ts";
import { buildDataFrames } from "./data.ts";
import { calcSpeed } from "./speed.ts";
import type { PrintJob } from "./pipeline.ts";

/** Printer geometry for a job (config-driven; do NOT assume T50 384-dot). */
export interface Geometry {
  /** Canvas width in dots (= printhead width). Bytes/line = canvasWidthDots/8. */
  canvasWidthDots: number;
  /** Top margin in dots (columns skipped at the image start). */
  marginTop: number;
  /** Bottom margin in dots. */
  marginBottom: number;
  /** Thermal density / red-deepness, 0-15. */
  density: number;
}

export const DEFAULT_GEOMETRY: Geometry = {
  canvasWidthDots: 384,
  marginTop: 8,
  marginBottom: 8,
  density: 4,
};

/**
 * Dots-per-mm assumed for the E11 printhead (8 dots/mm ⇒ 203 dpi, the T50 family).
 * ⚠ UNVERIFIED (plan §7): some SUPVAN heads (SP/TP/G) query DPI live and land at
 * ~11.6–11.8 dots/mm. If the E11 is a DPI-query variant this is wrong — confirm
 * with a RETURN_MAT (0x30) width + a known-width test print at bring-up.
 */
export const E11_DOTS_PER_MM = 8;

/**
 * Derive an E11 geometry for a given tape width. The printhead width is rounded to
 * a whole number of bytes because the raster packs 8 dots/byte and
 * `centerInPrinthead` can only place byte-aligned widths.
 */
export function e11GeometryForTapeMm(tapeWidthMm: number): Geometry {
  const raw = Math.round(tapeWidthMm * E11_DOTS_PER_MM);
  const canvasWidthDots = Math.max(8, Math.round(raw / 8) * 8);
  return { canvasWidthDots, marginTop: 8, marginBottom: 8, density: 4 };
}

/**
 * SUPVAN E11 printhead geometry — BEST GUESS, pending hardware bring-up.
 *
 * ⚠ UNVERIFIED (plan §7, the second-biggest unknown). The reference registry maps
 * e11 → T50 = 384 dots / 48 mm, which is almost certainly WRONG: the E11 takes
 * 12 mm and 15 mm tape, so at 8 dots/mm its printhead is ~96 dots (12 mm) or
 * ~120 dots (15 mm) — a quarter of 384, and centering a 96–120-dot image inside a
 * 384-dot canvas mis-positions/clips every label. We default to the 15 mm
 * continuous roll (120 dots), the least-constrained media. Confirm the real width
 * via a RETURN_MAT (0x30) query before trusting this, and use
 * `e11GeometryForTapeMm()` (or a future config field) to switch to the 12 mm roll.
 */
export const E11_GEOMETRY: Geometry = e11GeometryForTapeMm(15);

/** A raster job: column-major LSB-first canvas image + its dimensions. */
export interface ColumnMajorImage {
  data: Uint8Array;
  /** Bytes per column (= canvasWidthDots / 8). */
  bytesPerLine: number;
  /** Total columns (= label height in dots). */
  totalCols: number;
}

/**
 * Build a `PrintJob` from an already-column-major canvas image.
 *
 * Steps: split into 4096-byte print buffers → concat → LZMA (alone, size
 * patched) → 512-byte data frames; speed derives from the average compressed
 * bytes per buffer.
 */
export function buildJobFromColumnMajor(
  image: ColumnMajorImage,
  geom: Geometry,
  encode: LzmaAloneEncoder,
): PrintJob {
  const buffers = splitIntoBuffers(
    image.data,
    image.bytesPerLine,
    image.totalCols,
    geom.marginTop,
    geom.marginBottom,
    geom.density,
  );
  const { compressed, avgPerBuffer } = compressBuffersForPrint(buffers, encode);
  const frames = buildDataFrames(compressed);
  const speed = calcSpeed(Math.trunc(avgPerBuffer));
  return { frames, compressedLen: compressed.length, speed };
}

/**
 * Repack a row-major MSB-first 1bpp bitmap (label content) into a centered
 * column-major canvas image ready for `buildJobFromColumnMajor`.
 *
 * `bitmapWidthDots` is the rendered content width; it is centered in the
 * `canvasWidthDots` printhead. The resulting `totalCols` equals `heightDots`.
 */
export function repackToCanvas(
  rowMajorBitmap: Uint8Array,
  bitmapWidthDots: number,
  heightDots: number,
  canvasWidthDots: number,
): ColumnMajorImage {
  const cm = rasterToColumnMajor(rowMajorBitmap, bitmapWidthDots, heightDots);
  const centered = centerInPrinthead(
    cm.data,
    cm.cols,
    bitmapWidthDots,
    canvasWidthDots,
  );
  return {
    data: centered.data,
    bytesPerLine: centered.bytesPerLine,
    totalCols: cm.cols,
  };
}
