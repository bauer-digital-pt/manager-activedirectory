/**
 * Regenerate the baked Bauer Media "B" mark used on asset labels.
 *
 *   node tools/gen-brand-mark.mjs
 *
 * Reads the sidebar logo (src/renderer/src/assets/logo_1.png), isolates the
 * purple play-mark (the teal triangle field is light and drops out at the
 * threshold — exactly what we want on a 1bpp thermal label), area-downscales it
 * to TARGET_H dots keeping aspect, and writes src/main/supvan/logo.ts.
 *
 * Zero deps beyond Node core (hand-rolled PNG decode). If the source logo
 * changes, re-run this and commit the regenerated logo.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src/renderer/src/assets/logo_1.png");
const OUT = join(ROOT, "src/main/supvan/logo.ts");

const TARGET_H = 64; // baked mark height in label dots
const LEFT_FRACTION = 0.5; // the mark lives in the left half; excludes the wordmark
const LUM_THRESHOLD = 130; // luminance-over-white below which a pixel is "purple ink"
const COVERAGE = 0.42; // a downscaled cell is ink if >= this fraction of its source area is ink

// --- minimal PNG reader (8-bit, non-interlaced, colour types 0/2/6) ---
function readPng(path) {
  const buf = readFileSync(path);
  let p = 8, w = 0, h = 0, ctype = 0, bitd = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitd = data[8]; ctype = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (bitd !== 8) throw new Error("only 8-bit PNGs supported, got " + bitd);
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 0 ? 1 : (() => { throw new Error("colour type " + ctype); })();
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8Array(h * stride);
  const paeth = (a, b, c) => {
    const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++];
    for (let i = 0; i < stride; i++) {
      const x = raw[q++];
      const a = i >= ch ? out[y * stride + i - ch] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= ch && y > 0 ? out[(y - 1) * stride + i - ch] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1); else v = x + paeth(a, b, c);
      out[y * stride + i] = v & 0xff;
    }
  }
  return { w, h, ch, data: out };
}

const { w, h, ch, data } = readPng(SRC);
const left = Math.floor(w * LEFT_FRACTION);

// 1) full-res binary ink mask (purple over white), restricted to the left half.
const mask = new Uint8Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < left; x++) {
  const o = (y * w + x) * ch;
  let r, g, b, al;
  if (ch === 1) { r = g = b = data[o]; al = 255; }
  else { r = data[o]; g = data[o + 1]; b = data[o + 2]; al = ch === 4 ? data[o + 3] : 255; }
  const a = al / 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) * a + 255 * (1 - a);
  if (lum < LUM_THRESHOLD) mask[y * w + x] = 1;
}

// 2) tight bounding box of the mark.
let x0 = left, y0 = h, x1 = 0, y1 = 0;
for (let y = 0; y < h; y++) for (let x = 0; x < left; x++) if (mask[y * w + x]) {
  if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
}
const cw = x1 - x0 + 1, chh = y1 - y0 + 1;

// 3) area-downscale the mask to TARGET_H, keep aspect, threshold coverage.
const outH = TARGET_H;
const outW = Math.round(cw * (TARGET_H / chh));
const bits = new Uint8Array(outW * outH);
for (let oy = 0; oy < outH; oy++) for (let ox = 0; ox < outW; ox++) {
  const sx0 = x0 + (ox / outW) * cw, sx1 = x0 + ((ox + 1) / outW) * cw;
  const sy0 = y0 + (oy / outH) * chh, sy1 = y0 + ((oy + 1) / outH) * chh;
  let sum = 0, cnt = 0;
  for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    sum += mask[sy * w + sx]; cnt++;
  }
  if (cnt && sum / cnt >= COVERAGE) bits[oy * outW + ox] = 1;
}

// 4) pack MSB-first, bytesPerLine = ceil(outW/8).
const bpl = Math.ceil(outW / 8);
const packed = new Uint8Array(bpl * outH);
for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) if (bits[y * outW + x]) packed[y * bpl + (x >> 3)] |= 0x80 >> (x & 7);
const hex = Buffer.from(packed).toString("hex");

const ts = `/**
 * Baked brand mark for asset labels — the Bauer Media "B" play-mark, the same
 * symbol shown in the app sidebar (assets/logo_1.png), reduced to 1bpp.
 *
 * WHY baked, not decoded at runtime: renderLabel must stay pure and dependency-
 * free so the exact same bytes render in the Electron main process, in
 * \`node --test\`, and in the renderer preview. Node has no built-in PNG decoder
 * and the browser's is DOM-coupled, so the mark is pre-rasterised here as a
 * packed 1bpp bitmap. Only the purple play-mark survives the threshold — the
 * teal triangle field is light and drops out, which is exactly what we want on
 * a monochrome thermal label. Regenerate with tools/gen-brand-mark.mjs if the
 * source logo changes (target height ${TARGET_H} dots, keeps aspect).
 *
 * Format matches MonoBitmap: row-major, MSB-first, 1bpp packed (dark = 1).
 */
import type { MonoBitmap } from "./mono.ts";

const WIDTH = ${outW};
const HEIGHT = ${outH};
const BYTES_PER_LINE = ${bpl}; // ceil(${outW} / 8)

// Packed pixels (hex). Decoded portably (no Buffer/atob) so it loads anywhere.
const HEX =
  "${hex}";

function decodeHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** The Bauer Media "B" play-mark as a 1bpp bitmap (${outW}×${outH} dots, dark = 1). */
export const BAUER_B_MARK: MonoBitmap = {
  data: decodeHex(HEX),
  width: WIDTH,
  height: HEIGHT,
  bytesPerLine: BYTES_PER_LINE,
};
`;

writeFileSync(OUT, ts);
console.log(`mark ${outW}x${outH} (from ${cw}x${chh} bbox), ${packed.length} bytes -> ${OUT}`);
