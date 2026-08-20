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
 * Media loaded in this fleet's E11: 12 mm × 22 mm die-cut labels with a 3 mm gap
 * between consecutive labels. The 12 mm is ACROSS the printhead (the fixed tape
 * width); the 22 mm runs ALONG the feed (label length); the 3 mm is the blank feed
 * between labels. Confirmed from the physical media; the dots/mm conversion still
 * rides on the E11_DOTS_PER_MM assumption below (verify at bring-up).
 */
export const E11_TAPE_WIDTH_MM = 12;
export const E11_LABEL_LENGTH_MM = 22;
export const E11_LABEL_GAP_MM = 3;

/**
 * Derive an E11 geometry for a given tape width. The printhead width is rounded to
 * a whole number of bytes because the raster packs 8 dots/byte and
 * `centerInPrinthead` can only place byte-aligned widths.
 *
 * `gapMm` is the inter-label gap; half of it becomes each feed margin, so the blank
 * feed between two labels' content (marginBottom of N + marginTop of N+1) equals the
 * full gap. Omit it to keep the generic 8-dot feed padding.
 */
export function e11GeometryForTapeMm(
  tapeWidthMm: number,
  opts: { gapMm?: number } = {},
): Geometry {
  const raw = Math.round(tapeWidthMm * E11_DOTS_PER_MM);
  const canvasWidthDots = Math.max(8, Math.round(raw / 8) * 8);
  const margin =
    opts.gapMm != null ? Math.max(1, Math.round((opts.gapMm / 2) * E11_DOTS_PER_MM)) : 8;
  return { canvasWidthDots, marginTop: margin, marginBottom: margin, density: 4 };
}

/**
 * SUPVAN E11 printhead geometry for the fleet's 12 mm × 22 mm / 3 mm-gap media.
 *
 * Across-head width = 12 mm ⇒ round(12 × 8 / 8) × 8 = 96 dots. Feed margins encode
 * the 3 mm inter-label gap (1.5 mm ⇒ 12 dots each). The 22 mm label LENGTH is not a
 * hard printhead constraint (the feed axis is content-driven + the die-cut gap
 * sensor advances it), so it is documented (E11_LABEL_LENGTH_MM) rather than baked
 * into canvasWidthDots.
 *
 * ⚠ Still assumes E11_DOTS_PER_MM = 8 (203 dpi). If the E11 is a DPI-query variant
 * (~11.6 dots/mm) the dot counts are off — confirm with a RETURN_MAT (0x30) width
 * query + a known-width test print at bring-up. If the E11 auto-advances the
 * die-cut gap itself, the 3 mm feed margins here would double the spacing and
 * should drop toward 0 — verify against a real print.
 */
export const E11_GEOMETRY: Geometry = e11GeometryForTapeMm(E11_TAPE_WIDTH_MM, {
  gapMm: E11_LABEL_GAP_MM,
});

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
