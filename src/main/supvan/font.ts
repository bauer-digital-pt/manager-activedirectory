/**
 * Embedded 5×7 bitmap font for label text — zero dependencies, no font files.
 *
 * Glyphs are authored as row-strings (`"1"` = dark) so the source doubles as the
 * visual spec. The set covers digits, `A–Z`, and the punctuation that appears on
 * asset labels (codes, dates, short URLs). Characters outside the set are
 * normalised before lookup:
 *   1. exact match,
 *   2. Unicode NFD decompose + strip combining marks (á→a, ç→c, ã→a, …) — the
 *      common, legible behaviour for a monochrome thermal label,
 *   3. upper-case fold (lower-case renders as caps),
 *   4. fall back to `?`.
 * Real lower-case / precomposed accented glyphs can be added later as pure data
 * without touching the layout code.
 *
 * `drawText` renders through `MonoCanvas.blitGlyph`, so the same output appears
 * in the print path, in tests, and in the renderer preview.
 */
import { MonoCanvas } from "./mono.ts";

export const GLYPH_W = 5;
export const GLYPH_H = 7;

// The authored glyph data. Exported so the renderer preview and tests can read
// the spec directly (each entry is GLYPH_H row-strings of GLYPH_W chars).
// prettier-ignore
export const GLYPH_ROWS: Readonly<Record<string, readonly string[]>> = {
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
  "0": ["01110","10001","10011","10101","11001","10001","01110"],
  "1": ["00100","01100","00100","00100","00100","00100","01110"],
  "2": ["01110","10001","00001","00010","00100","01000","11111"],
  "3": ["11111","00010","00100","00010","00001","10001","01110"],
  "4": ["00010","00110","01010","10010","11111","00010","00010"],
  "5": ["11111","10000","11110","00001","00001","10001","01110"],
  "6": ["00110","01000","10000","11110","10001","10001","01110"],
  "7": ["11111","00001","00010","00100","01000","01000","01000"],
  "8": ["01110","10001","10001","01110","10001","10001","01110"],
  "9": ["01110","10001","10001","01111","00001","00010","01100"],
  "A": ["01110","10001","10001","11111","10001","10001","10001"],
  "B": ["11110","10001","10001","11110","10001","10001","11110"],
  "C": ["01110","10001","10000","10000","10000","10001","01110"],
  "D": ["11110","10001","10001","10001","10001","10001","11110"],
  "E": ["11111","10000","10000","11110","10000","10000","11111"],
  "F": ["11111","10000","10000","11110","10000","10000","10000"],
  "G": ["01110","10001","10000","10111","10001","10001","01111"],
  "H": ["10001","10001","10001","11111","10001","10001","10001"],
  "I": ["01110","00100","00100","00100","00100","00100","01110"],
  "J": ["00111","00010","00010","00010","00010","10010","01100"],
  "K": ["10001","10010","10100","11000","10100","10010","10001"],
  "L": ["10000","10000","10000","10000","10000","10000","11111"],
  "M": ["10001","11011","10101","10101","10001","10001","10001"],
  "N": ["10001","10001","11001","10101","10011","10001","10001"],
  "O": ["01110","10001","10001","10001","10001","10001","01110"],
  "P": ["11110","10001","10001","11110","10000","10000","10000"],
  "Q": ["01110","10001","10001","10001","10101","10010","01101"],
  "R": ["11110","10001","10001","11110","10100","10010","10001"],
  "S": ["01111","10000","10000","01110","00001","00001","11110"],
  "T": ["11111","00100","00100","00100","00100","00100","00100"],
  "U": ["10001","10001","10001","10001","10001","10001","01110"],
  "V": ["10001","10001","10001","10001","10001","01010","00100"],
  "W": ["10001","10001","10001","10101","10101","11011","10001"],
  "X": ["10001","10001","01010","00100","01010","10001","10001"],
  "Y": ["10001","10001","01010","00100","00100","00100","00100"],
  "Z": ["11111","00001","00010","00100","01000","10000","11111"],
  "!": ["00100","00100","00100","00100","00100","00000","00100"],
  "\"": ["01010","01010","01010","00000","00000","00000","00000"],
  "#": ["01010","01010","11111","01010","11111","01010","01010"],
  "$": ["00100","01111","10100","01110","00101","11110","00100"],
  "%": ["11000","11001","00010","00100","01000","10011","00011"],
  "&": ["01100","10010","10100","01000","10101","10010","01101"],
  "'": ["00100","00100","00100","00000","00000","00000","00000"],
  "(": ["00010","00100","01000","01000","01000","00100","00010"],
  ")": ["01000","00100","00010","00010","00010","00100","01000"],
  "*": ["00000","00100","10101","01110","10101","00100","00000"],
  "+": ["00000","00100","00100","11111","00100","00100","00000"],
  ",": ["00000","00000","00000","00000","00100","00100","01000"],
  "-": ["00000","00000","00000","11111","00000","00000","00000"],
  ".": ["00000","00000","00000","00000","00000","01100","01100"],
  "/": ["00001","00010","00100","00100","00100","01000","10000"],
  ":": ["00000","01100","01100","00000","01100","01100","00000"],
  ";": ["00000","01100","01100","00000","01100","00100","01000"],
  "=": ["00000","00000","11111","00000","11111","00000","00000"],
  "?": ["01110","10001","00001","00010","00100","00000","00100"],
  "@": ["01110","10001","10111","10101","10111","10000","01110"],
  "_": ["00000","00000","00000","00000","00000","00000","11111"],
  "·": ["00000","00000","00000","00100","00000","00000","00000"], // U+00B7 middot separator
};

const FALLBACK = "?";

/** Packed 1bpp glyphs (row-major, MSB-first), built once from GLYPHS. */
const PACKED: Map<string, Uint8Array> = new Map();
function packGlyph(rows: readonly string[]): Uint8Array {
  const bpl = Math.ceil(GLYPH_W / 8); // 1 for width 5
  const out = new Uint8Array(bpl * GLYPH_H);
  for (let y = 0; y < GLYPH_H; y++) {
    const row = rows[y];
    for (let x = 0; x < GLYPH_W; x++) {
      if (row[x] === "1") out[y * bpl + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}
for (const [ch, rows] of Object.entries(GLYPH_ROWS)) PACKED.set(ch, packGlyph(rows));

/** Resolve a character to a glyph key present in the font (see file header). */
export function normalizeChar(ch: string): string {
  if (PACKED.has(ch)) return ch;
  const stripped = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (PACKED.has(stripped)) return stripped;
  const upper = stripped.toUpperCase();
  if (PACKED.has(upper)) return upper;
  return FALLBACK;
}

/** True if the font has a glyph for `ch` without any normalisation. */
export function hasGlyph(ch: string): boolean {
  return PACKED.has(ch);
}

export interface TextOptions {
  /** Integer pixel scale per glyph dot (default 2). */
  scale?: number;
  /** Blank columns between glyphs, in unscaled glyph pixels (default 1). */
  letterSpacing?: number;
}

const DEFAULT_SCALE = 2;
const DEFAULT_SPACING = 1;

/**
 * Split `text` into the units the font renders one glyph for.
 *
 * The input is first NFC-normalised so a decomposed accented grapheme (base +
 * combining mark, e.g. NFD "a"+U+0301, which is how macOS emits "á") is
 * recomposed into a single code point BEFORE `normalizeChar` sees it — otherwise
 * the base would resolve fine but the orphaned combining mark would fall through
 * to the "?" fallback, printing a spurious glyph and inflating the measured
 * width. Any residual combining mark with no precomposed form is then dropped
 * (the "strip combining marks" half of the font's normalisation contract), so a
 * lone mark never renders as "?". Surrogate pairs still count as one char.
 */
function chars(text: string): string[] {
  return Array.from(text.normalize("NFC")).filter((c) => !/[̀-ͯ]/.test(c));
}

export interface TextMetrics {
  width: number;
  height: number;
}

/** Pixel size of `text` as it would be drawn (no trailing letter-spacing). */
export function measureText(text: string, opts: TextOptions = {}): TextMetrics {
  const scale = opts.scale ?? DEFAULT_SCALE;
  const spacing = opts.letterSpacing ?? DEFAULT_SPACING;
  const n = chars(text).length;
  if (n === 0) return { width: 0, height: GLYPH_H * scale };
  const width = (n * GLYPH_W + (n - 1) * spacing) * scale;
  return { width, height: GLYPH_H * scale };
}

/**
 * Draw `text` at (x, y) top-left on `canvas`. Returns the advance width so the
 * caller can chain / right-align. Unknown characters normalise per the file
 * header; dark glyph pixels draw, light ones are transparent.
 */
export function drawText(
  canvas: MonoCanvas,
  text: string,
  x: number,
  y: number,
  opts: TextOptions = {},
): number {
  const scale = opts.scale ?? DEFAULT_SCALE;
  const spacing = opts.letterSpacing ?? DEFAULT_SPACING;
  let cursor = x;
  for (const ch of chars(text)) {
    const glyph = PACKED.get(normalizeChar(ch))!;
    canvas.blitGlyph(glyph, GLYPH_W, GLYPH_H, cursor, y, scale);
    cursor += (GLYPH_W + spacing) * scale;
  }
  // Advance width excludes the final letter-spacing gap.
  const n = chars(text).length;
  return n === 0 ? 0 : cursor - x - spacing * scale;
}

/** The set of characters with a dedicated glyph (for tests / tooling). */
export function glyphKeys(): string[] {
  return Array.from(PACKED.keys());
}
