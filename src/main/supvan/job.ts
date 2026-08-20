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
