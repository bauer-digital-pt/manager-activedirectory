/**
 * Label composition: turn an EZOffice asset into a 1bpp raster (QR + text) and
 * bridge that raster into the print pipeline.
 *
 * `renderLabel` composes in **natural reading orientation** — a landscape image
 * laid out left-to-right as: the Bauer "B" logo, then the QR, then the text lines
 * (stacked and vertically centered). This is what the in-app preview shows and
 * what a human expects an asset label to look like. When the model carries no QR
 * payload (no resolved asset URL) the QR is omitted and the label degrades to
 * logo + text — a blank/placeholder code is never drawn.
 * It is pure and deterministic (no DOM, no deps): the same bytes render in the
 * main process, in `node --test`, and in the renderer preview.
 *
 * Mapping that image onto the printer is a separate step (`labelToColumnMajor` /
 * `labelToJob`) because the physical orientation of the E11 tape is a hardware
 * detail the plan defers to a device spike (§7, risk #2). The mapping exposes a
 * single `quarterTurns` knob: the natural label is wide, so it is rotated so its
 * long axis runs along the (unbounded) feed and its short axis fits across the
 * printhead. The feed-axis margins are added as blank columns here so that
 * `buildJobFromColumnMajor`'s margin clip removes exactly the blanks and never
 * eats label content (which would clip a QR corner and break scanning).
 */
import { encodeQr, type Ecc, type QrCode } from "./qr.ts";
import { MonoCanvas, type MonoBitmap } from "./mono.ts";
import { drawText, measureText, GLYPH_H } from "./font.ts";
import { BAUER_B_MARK } from "./logo.ts";
import { repackToCanvas, buildJobFromColumnMajor, type Geometry, type ColumnMajorImage } from "./job.ts";
import type { LzmaAloneEncoder } from "./compress.ts";
import type { PrintJob } from "./pipeline.ts";

/** The label's content: a QR payload and human-readable text lines. */
export interface LabelModel {
  /**
   * Encoded into the QR — the resolved EZOffice asset URL. Empty ⇒ no QR is
   * drawn (the label degrades to logo + text), never a blank/placeholder code.
   */
  qr: string;
  /** Text lines, top to bottom (e.g. assetId, name, serial). Empty ⇒ QR only. */
  lines: string[];
}

/** Visual style. All sizes are in image dots; every field has a sane default. */
export interface LabelStyle {
  /** QR error-correction level (default "M"). */
  qrEcc?: Ecc;
  /** Pixels per QR module (default 3). */
  qrScale?: number;
  /** Quiet-zone modules baked around the QR — 4 is the ISO minimum (default 4). */
  qrQuiet?: number;
  /** Text scale passed to the bitmap font (default 2). */
  textScale?: number;
  /** Letter spacing in unscaled glyph pixels (default 1). */
  letterSpacing?: number;
  /** Blank dots between text lines (default 2). */
  lineGap?: number;
  /** Dots between the QR block and the text block (default 6). */
  gap?: number;
  /** Whitespace around the whole label, in dots (default 2). */
  padding?: number;
  /**
   * Draw the Bauer Media "B" mark at the START of the label, before the QR
   * (default true). Layout is logo → QR → text; set false for a bare label.
   */
  showBrand?: boolean;
}

/** The result of composing a label. */
export interface LabelRender {
  /** The drawing surface (exposes `toAsciiArt()` for preview/debug). */
  canvas: MonoCanvas;
  /** Row-major, MSB-first, 1bpp packed pixels (dark = 1). */
  bitmap: MonoBitmap;
  /** Image dimensions in dots. */
  width: number;
  height: number;
  /** The QR symbol that was embedded, or null when the payload was empty. */
  qr: QrCode | null;
  /** QR block geometry within the image (includes the quiet zone), or null when no QR. */
  qrBlock: { x: number; y: number; size: number; scale: number; quiet: number } | null;
  /** Brand-mark geometry within the image, or null when not drawn. */
  brandBlock: { x: number; y: number; width: number; height: number } | null;
}

const DEF = {
  qrEcc: "M" as Ecc,
  qrScale: 3,
  qrQuiet: 4,
  textScale: 2,
  letterSpacing: 1,
  lineGap: 2,
  gap: 6,
  padding: 2,
};

/**
 * Compose an EZOffice label into a 1bpp raster in natural reading orientation
 * (logo, then QR, then the text lines stacked and vertically centered). An empty
 * `model.qr` omits the QR region entirely, degrading to a logo + text label.
 */
export function renderLabel(model: LabelModel, style: LabelStyle = {}): LabelRender {
  const qrEcc = style.qrEcc ?? DEF.qrEcc;
  const qrScale = style.qrScale ?? DEF.qrScale;
  const quiet = style.qrQuiet ?? DEF.qrQuiet;
  const textScale = style.textScale ?? DEF.textScale;
  const letterSpacing = style.letterSpacing ?? DEF.letterSpacing;
  const lineGap = style.lineGap ?? DEF.lineGap;
  const gap = style.gap ?? DEF.gap;
  const padding = style.padding ?? DEF.padding;

  // Validate every size input, not just qrScale: a negative qrQuiet would push
  // the QR's origin off-canvas (silently clipping its left column → unscannable)
  // and a negative textScale would collapse the text width to 0 (silently
  // dropping all text). Scales must be >= 1; offsets/spacings may be 0.
  const requireSize = (nameOf: string, v: number, min: number): void => {
    if (!Number.isInteger(v) || v < min) {
      throw new Error(`renderLabel: ${nameOf} must be an integer >= ${min} (got ${v})`);
    }
  };
  requireSize("qrScale", qrScale, 1);
  requireSize("qrQuiet", quiet, 0);
  requireSize("textScale", textScale, 1);
  requireSize("letterSpacing", letterSpacing, 0);
  requireSize("lineGap", lineGap, 0);
  requireSize("gap", gap, 0);
  requireSize("padding", padding, 0);

  // No payload ⇒ no QR: the label degrades to logo + text rather than throwing.
  // `encodeQr` keeps its strict empty-input invariant (an empty QR scans to
  // nothing); the decision to omit the QR region is made here instead.
  const hasQr = model.qr.length > 0;
  const qr = hasQr ? encodeQr(model.qr, { ecc: qrEcc }) : null;
  const qrBlockPx = qr ? (qr.size + 2 * quiet) * qrScale : 0;

  const lines = model.lines ?? [];
  const lineHeight = GLYPH_H * textScale;
  const textBlockWidth = lines.reduce(
    (w, ln) => Math.max(w, measureText(ln, { scale: textScale, letterSpacing }).width),
    0,
  );
  // `hasText` gates drawing AND width reservation, so it must also gate height:
  // otherwise a list of all-blank lines (width 0 ⇒ hasText false, nothing drawn)
  // would still reserve vertical feed space, producing an oversized blank label.
  const hasText = lines.length > 0 && textBlockWidth > 0;
  const textBlockHeight = hasText
    ? lines.length * lineHeight + (lines.length - 1) * lineGap
    : 0;

  // Brand mark (logo) at the START of the label, before the QR. It never touches
  // QR data: the QR is separated from it by a `gap` PLUS the QR's own quiet zone.
  // It only lengthens the feed axis (natural width) — its height (64 dots) fits
  // comfortably across every E11 head — so it can never break the across-head fit
  // (fitLabelStyle only shrinks the QR).
  const brand = (style.showBrand ?? true) ? BAUER_B_MARK : null;
  const brandBlockWidth = brand ? brand.width : 0;
  const brandBlockHeight = brand ? brand.height : 0;

  const contentHeight = Math.max(qrBlockPx, textBlockHeight, brandBlockHeight);

  // Layout is left-to-right: [padding] logo [gap] QR [gap] text [padding]. Only
  // PRESENT segments reserve width and a separating gap, so a device with no
  // asset URL (no QR) collapses cleanly to logo → text with a single gap between
  // them — not a phantom double gap where the QR would have been.
  const segWidths: number[] = [];
  if (brand) segWidths.push(brandBlockWidth);
  if (qr) segWidths.push(qrBlockPx);
  if (hasText) segWidths.push(textBlockWidth);
  const contentWidth =
    segWidths.reduce((a, b) => a + b, 0) + Math.max(0, segWidths.length - 1) * gap;
  const width = padding + contentWidth + padding;
  const height = padding + contentHeight + padding;

  const canvas = new MonoCanvas(width, height);

  // Place each present segment left-to-right: `advance` returns the segment's
  // left x and moves the cursor past it plus one gap.
  let cursorX = padding;
  const advance = (segWidth: number): number => {
    const x = cursorX;
    cursorX += segWidth + gap;
    return x;
  };

  // Logo first (vertically centered in the content band).
  let brandBlock: LabelRender["brandBlock"] = null;
  if (brand) {
    const brandX = advance(brandBlockWidth);
    const brandY = padding + Math.floor((contentHeight - brandBlockHeight) / 2);
    canvas.blitGlyph(brand.data, brand.width, brand.height, brandX, brandY, 1);
    brandBlock = { x: brandX, y: brandY, width: brandBlockWidth, height: brandBlockHeight };
  }

  // QR after the logo (vertically centered). The quiet zone stays light. Omitted
  // entirely when there is no payload — the label is then logo + text only.
  let qrBlock: LabelRender["qrBlock"] = null;
  if (qr) {
    const qrX = advance(qrBlockPx);
    const qrY = padding + Math.floor((contentHeight - qrBlockPx) / 2);
    canvas.blitMatrix(qr.modules, qrX + quiet * qrScale, qrY + quiet * qrScale, qrScale);
    qrBlock = { x: qrX, y: qrY, size: qrBlockPx, scale: qrScale, quiet };
  }

  // Text block last (vertically centered against the content band).
  if (hasText) {
    const textX = advance(textBlockWidth);
    const textTop = padding + Math.floor((contentHeight - textBlockHeight) / 2);
    for (let i = 0; i < lines.length; i++) {
      const y = textTop + i * (lineHeight + lineGap);
      drawText(canvas, lines[i], textX, y, { scale: textScale, letterSpacing });
    }
  }

  return {
    canvas,
    bitmap: canvas.toBitmap(),
    width,
    height,
    qr,
    qrBlock,
    brandBlock,
  };
}

/** Read a single pixel out of a row-major MSB-first bitmap (dark = 1). */
function bitAt(bmp: MonoBitmap, x: number, y: number): boolean {
  return ((bmp.data[y * bmp.bytesPerLine + (x >> 3)] >> (7 - (x & 7))) & 1) !== 0;
}

/**
 * Rotate a row-major MSB-first 1bpp bitmap by `quarterTurns` × 90° clockwise.
 * Dimensions swap on odd turns. `quarterTurns` is taken mod 4 (negatives ok).
 */
export function rotateBitmap90(bmp: MonoBitmap, quarterTurns: number = 1): MonoBitmap {
  const k = ((Math.trunc(quarterTurns) % 4) + 4) % 4;
  if (k === 0) return bmp;
  const { width: w, height: h } = bmp;
  const nw = k === 2 ? w : h;
  const nh = k === 2 ? h : w;
  const out = new MonoCanvas(nw, nh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bitAt(bmp, x, y)) continue;
      let nx: number;
      let ny: number;
      if (k === 1) {
        nx = h - 1 - y; // 90° CW
        ny = x;
      } else if (k === 2) {
        nx = w - 1 - x; // 180°
        ny = h - 1 - y;
      } else {
        nx = y; // 270° CW
        ny = w - 1 - x;
      }
      out.set(nx, ny, true);
    }
  }
  return out.toBitmap();
}

/**
 * Reverse a row-major MSB-first 1bpp bitmap along X (across) and/or Y (feed).
 * A reflection — NOT a rotation: it changes chirality, which is exactly what a
 * rotation (rotateBitmap90) can never do. Used to compensate for the printhead's
 * physical dot order (see LabelMapOptions.mirrorAcross). `x`/`y` default off.
 */
export function flipBitmap(bmp: MonoBitmap, opts: { x?: boolean; y?: boolean } = {}): MonoBitmap {
  if (!opts.x && !opts.y) return bmp;
  const { width: w, height: h } = bmp;
  const out = new MonoCanvas(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bitAt(bmp, x, y)) continue;
      out.set(opts.x ? w - 1 - x : x, opts.y ? h - 1 - y : y, true);
    }
  }
  return out.toBitmap();
}

/** Options for mapping a rendered label onto the printhead raster. */
export interface LabelMapOptions {
  /**
   * Quarter-turns (× 90° CW) applied to the natural-orientation label before it
   * is packed. The natural label is wide, so an odd turn puts its long axis
   * along the feed and its short axis across the printhead. This only rotates —
   * it cannot mirror — so it fixes upside-down/sideways, never a reflection.
   *
   * Default is 3 (270° CW): the empirically-correct rotation on the real E11.
   */
  quarterTurns?: number;
  /**
   * Mirror the ACROSS-tape axis (the printhead dot order) before packing.
   *
   * The E11 printhead fires dot 0 at the FAR edge of the tape, so the raster's
   * across axis is physically reversed. The reference grayscale/dither path
   * already compensates for this — `ditherLine` in raster.ts mirrors the very
   * same axis (`mx = width - 1 - x`) — but the 1bpp label path (renderLabel →
   * rotateBitmap90 → rasterToColumnMajor) never did, so every printed label came
   * out reflected across the tape. After the 270° turn that reflection reads as a
   * vertical (top↔bottom) mirror on the label, which no quarterTurns value can
   * undo (rotation preserves chirality). Default true — the hardware always needs
   * it. Flip to false only if a future head variant proves otherwise.
   */
  mirrorAcross?: boolean;
  /**
   * Mirror the FEED axis (reverse the column/print order). Off by default; the
   * feed direction is already set by quarterTurns. Exposed as an escape hatch in
   * case a head variant reverses the feed as well as the across axis.
   */
  mirrorFeed?: boolean;
}

/**
 * Map a rendered label onto the printhead canvas: rotate → pad the feed axis
 * with the geometry's top/bottom margins (blank columns) → center across the
 * printhead → repack column-major. The returned `totalCols` already includes the
 * margins, so `buildJobFromColumnMajor`'s margin clip removes exactly the blanks.
 *
 * Throws if the label is wider than the printhead after rotation — the caller
 * should reduce the QR/text scale or rotate the other way.
 */
export function labelToColumnMajor(
  render: LabelRender,
  geom: Geometry,
  opts: LabelMapOptions = {},
): ColumnMajorImage {
  const quarterTurns = opts.quarterTurns ?? 3;
  // Rotate for fit/orientation, THEN mirror the across-tape axis to match the
  // printhead's physical dot order (default on — see LabelMapOptions.mirrorAcross).
  // The flip is applied after the rotation so `mirrorAcross` always means the
  // same physical (across-head) axis regardless of quarterTurns.
  const rotated = flipBitmap(rotateBitmap90(render.bitmap, quarterTurns), {
    x: opts.mirrorAcross ?? true,
    y: opts.mirrorFeed ?? false,
  });

  // centerInPrinthead can only place floor(canvasWidthDots/8)*8 dots per column
  // (it works in whole bytes). Guard against that PLACEABLE width, not the raw
  // canvasWidthDots: a label wider than placeable but not wider than the raw
  // width would otherwise pass and have its rightmost dots bleed into the next
  // column (centering) or be truncated. For the byte-aligned printheads we use
  // (384, 96) the two are equal; this only bites a hand-set odd geometry.
  const placeableDots = Math.floor(geom.canvasWidthDots / 8) * 8;
  if (rotated.width > placeableDots) {
    throw new Error(
      `labelToColumnMajor: label is ${rotated.width} dots across but the printhead ` +
        `can place only ${placeableDots} dots (canvasWidthDots=${geom.canvasWidthDots}); ` +
        `reduce the scale or change quarterTurns`,
    );
  }

  // Pad the feed axis (image height ⇒ column-major columns) with blank margins.
  const marginTop = Math.max(0, Math.trunc(geom.marginTop));
  const marginBottom = Math.max(0, Math.trunc(geom.marginBottom));
  const paddedHeight = rotated.height + marginTop + marginBottom;
  const padded = new MonoCanvas(rotated.width, paddedHeight);
  // A MonoBitmap is exactly the packed-1bpp format blitGlyph consumes.
  padded.blitGlyph(rotated.data, rotated.width, rotated.height, 0, marginTop, 1);
  const paddedBmp = padded.toBitmap();

  return repackToCanvas(paddedBmp.data, paddedBmp.width, paddedBmp.height, geom.canvasWidthDots);
}

/**
 * Choose the largest QR scale (from the requested/default down to 1) at which the
 * composed label still fits ACROSS the printhead after `quarterTurns`, and return
 * that fitting render together with the style that produced it.
 *
 * WHY: the E11 heads are narrow (≈120 dots for 15 mm tape, 96 for 12 mm), while a
 * scannable asset URL needs QR v4+ (33+ modules). At the default qrScale=3 the QR
 * block alone is (33+8)·3 = 123 dots, so the rotated label is wider than the head
 * and `labelToColumnMajor` throws at PRINT time — while the preview still shows a
 * label that "looks fine". Shrinking the QR to fit keeps the primary use (scan the
 * URL to open the asset) working on the real hardware. Preview and print both call
 * this, so the on-screen bytes equal the printed bytes.
 *
 * Returns null when the label overflows even at qrScale=1 (e.g. a very long URL on
 * the 12 mm head): the caller then shows a clear message instead of the raw guard
 * error. NOTE: a QR at qrScale=1 is 1 dot/module (~0.125 mm at 203 dpi) and may be
 * marginal to scan — the acceptable minimum is a bring-up item (plan §7).
 */
export function fitLabelStyle(
  model: LabelModel,
  geom: Geometry,
  style: LabelStyle = {},
  opts: LabelMapOptions = {},
): { style: LabelStyle; render: LabelRender } | null {
  const placeableDots = Math.floor(geom.canvasWidthDots / 8) * 8;
  // Odd quarter-turns put the label's HEIGHT across the head; even turns its width
  // — matching labelToColumnMajor's guard on the rotated width.
  const k = (((Math.trunc(opts.quarterTurns ?? 3) % 4) + 4) % 4);
  const acrossIsHeight = (k & 1) === 1;
  const requested = style.qrScale ?? DEF.qrScale;
  for (let qrScale = requested; qrScale >= 1; qrScale--) {
    const s: LabelStyle = { ...style, qrScale };
    const render = renderLabel(model, s);
    const across = acrossIsHeight ? render.height : render.width;
    if (across <= placeableDots) return { style: s, render };
  }
  return null;
}

/**
 * Full bridge: rendered label → `PrintJob` (buffers → LZMA → data frames + speed).
 * `encode` is the injected LZMA-alone encoder (same as `buildJobFromColumnMajor`).
 */
export function labelToJob(
  render: LabelRender,
  geom: Geometry,
  encode: LzmaAloneEncoder,
  opts: LabelMapOptions = {},
): PrintJob {
  const image = labelToColumnMajor(render, geom, opts);
  return buildJobFromColumnMajor(image, geom, encode);
}
