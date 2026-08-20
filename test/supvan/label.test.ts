/**
 * Label-composition tests. Verifies the QR embeds back module-for-module, the
 * layout geometry follows the documented formula, text lines land where the
 * font would place them, and the render → rotate → column-major → job bridge is
 * structurally sound (feed margins are blank, content survives, the printhead
 * width is enforced).
 *
 *     node --test test/supvan/label.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  renderLabel,
  rotateBitmap90,
  labelToColumnMajor,
  labelToJob,
  type LabelRender,
} from "../../src/main/supvan/label.ts";
import { encodeQr } from "../../src/main/supvan/qr.ts";
import { measureText, drawText, GLYPH_H } from "../../src/main/supvan/font.ts";
import { MonoCanvas } from "../../src/main/supvan/mono.ts";
import { DEFAULT_GEOMETRY, type Geometry } from "../../src/main/supvan/job.ts";
import { expectedAloneHeaderPrefix, LZMA_ALONE_HEADER_LEN } from "../../src/main/supvan/compress.ts";

/** Read a pixel from a row-major MSB-first bitmap (dark = 1). */
const bitAt = (bmp: { data: Uint8Array; bytesPerLine: number }, x: number, y: number): boolean =>
  ((bmp.data[y * bmp.bytesPerLine + (x >> 3)] >> (7 - (x & 7))) & 1) !== 0;

test("renderLabel embeds the QR readable module-for-module", () => {
  const model = { qr: "https://pt.ezofficeinventory.com/assets/12345", lines: ["PT-LPT-TI-0007"] };
  const scale = 3;
  const quiet = 4;
  const r = renderLabel(model, { qrScale: scale, qrQuiet: quiet });

  const ref = encodeQr(model.qr, { ecc: "M" });
  assert.equal(r.qr.version, ref.version);
  assert.equal(r.qr.size, ref.size);
  assert.equal(r.qr.mask, ref.mask); // auto-selection is deterministic

  const originX = r.qrBlock.x + quiet * scale;
  const originY = r.qrBlock.y + quiet * scale;
  for (let row = 0; row < ref.size; row++) {
    for (let col = 0; col < ref.size; col++) {
      const cx = originX + col * scale + (scale >> 1);
      const cy = originY + row * scale + (scale >> 1);
      assert.equal(r.canvas.get(cx, cy), ref.modules[row][col], `module ${row},${col}`);
    }
  }
  // The baked quiet zone stays light at the block's top-left corner.
  assert.equal(r.canvas.get(r.qrBlock.x, r.qrBlock.y), false);
});

test("renderLabel dimensions follow the layout formula", () => {
  const model = { qr: "EZ/999", lines: ["ABC", "LONGER LINE 12345"] };
  const style = { qrScale: 2, qrQuiet: 4, textScale: 2, letterSpacing: 1, lineGap: 2, gap: 6, padding: 2 };
  const r = renderLabel(model, style);

  const ref = encodeQr(model.qr, { ecc: "M" });
  const qrBlock = (ref.size + 2 * style.qrQuiet) * style.qrScale;
  const lineHeight = GLYPH_H * style.textScale;
  const textWidth = Math.max(
    ...model.lines.map((l) => measureText(l, { scale: style.textScale, letterSpacing: style.letterSpacing }).width),
  );
  const textHeight = model.lines.length * lineHeight + (model.lines.length - 1) * style.lineGap;
  const contentHeight = Math.max(qrBlock, textHeight);

  assert.equal(r.width, style.padding + qrBlock + style.gap + textWidth + style.padding);
  assert.equal(r.height, style.padding * 2 + contentHeight);
  assert.equal(r.qrBlock.size, qrBlock);
  // Bitmap dims agree with the reported image dims.
  assert.equal(r.bitmap.width, r.width);
  assert.equal(r.bitmap.height, r.height);
});

test("all-blank text lines collapse to QR-only geometry", () => {
  // Regression: height was derived from lines.length unconditionally, so a list
  // of empty strings (nothing drawn, width omitted) still inflated the feed axis.
  const qrOnly = renderLabel({ qr: "X", lines: [] }, { qrScale: 2 });
  const blank = renderLabel({ qr: "X", lines: Array(12).fill("") }, { qrScale: 2 });
  assert.equal(blank.width, qrOnly.width);
  assert.equal(blank.height, qrOnly.height);
  // No text pixels were drawn: the packed bitmaps are byte-identical.
  assert.deepEqual([...blank.bitmap.data], [...qrOnly.bitmap.data]);
});

test("renderLabel validates every size input, not just qrScale", () => {
  const ok = { qr: "X", lines: ["A"] };
  assert.throws(() => renderLabel(ok, { qrScale: 0 }), /qrScale/);
  assert.throws(() => renderLabel(ok, { qrQuiet: -1 }), /qrQuiet/);
  assert.throws(() => renderLabel(ok, { textScale: -2 }), /textScale/);
  assert.throws(() => renderLabel(ok, { padding: -1 }), /padding/);
  assert.throws(() => renderLabel(ok, { qrScale: 1.5 }), /qrScale/); // non-integer
});

test("labelToColumnMajor guards the PLACEABLE width on a non-byte-aligned canvas", () => {
  // 385-dot label into a 386-dot canvas: only floor(386/8)*8 = 384 dots are
  // placeable, so the rightmost dot would bleed into the next column. The old
  // check (rotated.width > canvasWidthDots ⇒ 385 > 386) missed this.
  const c = new MonoCanvas(385, 3);
  c.set(384, 1, true);
  const fake = { bitmap: c.toBitmap() } as unknown as LabelRender;
  const geom: Geometry = { ...DEFAULT_GEOMETRY, canvasWidthDots: 386, marginTop: 1, marginBottom: 1 };
  assert.throws(() => labelToColumnMajor(fake, geom, { quarterTurns: 0 }), /can place only/);
});

test("a QR-only label omits the text region", () => {
  const scale = 2;
  const quiet = 4;
  const padding = 2;
  const r = renderLabel({ qr: "X", lines: [] }, { qrScale: scale, qrQuiet: quiet, padding });
  const ref = encodeQr("X", { ecc: "M" });
  const block = (ref.size + 2 * quiet) * scale;
  assert.equal(r.width, padding * 2 + block);
  assert.equal(r.height, padding * 2 + block);
});

test("text lines render where the font would place them", () => {
  const model = { qr: "EZ/1", lines: ["PT-01", "SERIAL9"] };
  const style = { qrScale: 2, qrQuiet: 4, textScale: 2, letterSpacing: 1, lineGap: 2, gap: 6, padding: 2 };
  const r = renderLabel(model, style);

  const ref = encodeQr(model.qr, { ecc: "M" });
  const qrBlock = (ref.size + 2 * style.qrQuiet) * style.qrScale;
  const lineHeight = GLYPH_H * style.textScale;
  const textHeight = model.lines.length * lineHeight + (model.lines.length - 1) * style.lineGap;
  const contentHeight = Math.max(qrBlock, textHeight);
  const textX = style.padding + qrBlock + style.gap;
  const textTop = style.padding + Math.floor((contentHeight - textHeight) / 2);

  for (let i = 0; i < model.lines.length; i++) {
    const line = model.lines[i];
    const m = measureText(line, { scale: style.textScale, letterSpacing: style.letterSpacing });
    const y0 = textTop + i * (lineHeight + style.lineGap);
    // Render the same line standalone and compare pixel-for-pixel at the offset.
    // measureText.height === lineHeight here, so the standalone render aligns.
    const ref2 = new MonoCanvas(m.width, m.height);
    drawText(ref2, line, 0, 0, { scale: style.textScale, letterSpacing: style.letterSpacing });
    for (let yy = 0; yy < m.height; yy++) {
      for (let xx = 0; xx < m.width; xx++) {
        assert.equal(
          r.canvas.get(textX + xx, y0 + yy),
          ref2.get(xx, yy),
          `line ${i} pixel ${xx},${yy}`,
        );
      }
    }
  }
});

test("rotateBitmap90: 4 turns is identity, odd turns swap dims", () => {
  const c = new MonoCanvas(6, 3);
  c.set(0, 0, true); // top-left, asymmetric
  c.set(5, 2, true); // bottom-right
  c.set(1, 0, true);
  const bmp = c.toBitmap();

  const back = rotateBitmap90(rotateBitmap90(rotateBitmap90(rotateBitmap90(bmp, 1), 1), 1), 1);
  assert.equal(back.width, bmp.width);
  assert.equal(back.height, bmp.height);
  assert.deepEqual([...back.data], [...bmp.data]);

  const r1 = rotateBitmap90(bmp, 1);
  assert.equal(r1.width, bmp.height); // dims swap
  assert.equal(r1.height, bmp.width);
  // 90° CW: (0,0) -> (h-1, 0); with h=3 that's (2,0).
  assert.equal(bitAt(r1, 2, 0), true);
  // (5,2) -> (h-1-2, 5) = (0,5).
  assert.equal(bitAt(r1, 0, 5), true);

  // Two single turns equal one double turn.
  const r2a = rotateBitmap90(bmp, 2);
  const r2b = rotateBitmap90(rotateBitmap90(bmp, 1), 1);
  assert.equal(r2a.width, r2b.width);
  assert.equal(r2a.height, r2b.height);
  assert.deepEqual([...r2a.data], [...r2b.data]);

  // Negative turns normalise (−1 ≡ 3).
  const rn = rotateBitmap90(bmp, -1);
  const r3 = rotateBitmap90(bmp, 3);
  assert.deepEqual([...rn.data], [...r3.data]);
});

test("labelToColumnMajor pads the feed with blank margins and centers content", () => {
  const r = renderLabel({ qr: "EZ/1", lines: ["PT-01"] }, { qrScale: 3, qrQuiet: 4 });
  const geom: Geometry = { ...DEFAULT_GEOMETRY, canvasWidthDots: 384, marginTop: 8, marginBottom: 8 };
  const img = labelToColumnMajor(r, geom, { quarterTurns: 1 });

  const rotated = rotateBitmap90(r.bitmap, 1);
  assert.equal(img.bytesPerLine, geom.canvasWidthDots / 8);
  assert.equal(img.totalCols, rotated.height + geom.marginTop + geom.marginBottom);

  const columnBlank = (col: number): boolean => {
    const start = col * img.bytesPerLine;
    for (let i = 0; i < img.bytesPerLine; i++) if (img.data[start + i] !== 0) return false;
    return true;
  };
  // The added feed margins are blank.
  for (let c = 0; c < geom.marginTop; c++) assert.ok(columnBlank(c), `top margin col ${c}`);
  for (let c = img.totalCols - geom.marginBottom; c < img.totalCols; c++) {
    assert.ok(columnBlank(c), `bottom margin col ${c}`);
  }
  // At least one interior column carries content.
  let anyContent = false;
  for (let c = geom.marginTop; c < img.totalCols - geom.marginBottom; c++) {
    if (!columnBlank(c)) {
      anyContent = true;
      break;
    }
  }
  assert.ok(anyContent, "content columns are all blank");
});

test("labelToColumnMajor rejects a label wider than the printhead", () => {
  const r = renderLabel({ qr: "EZ/1", lines: ["X"] }, { qrScale: 3 });
  const geom: Geometry = { ...DEFAULT_GEOMETRY, canvasWidthDots: 8 };
  assert.throws(() => labelToColumnMajor(r, geom, { quarterTurns: 1 }), /across but the printhead/);
});

test("labelToJob produces a well-formed PrintJob", () => {
  const r = renderLabel({ qr: "https://ez/42", lines: ["PT-LPT-TI-0007", "DELL 5440"] }, { qrScale: 3 });
  const geom: Geometry = { ...DEFAULT_GEOMETRY, canvasWidthDots: 384 };
  // Stub "LZMA": emits the vendor alone header (size field patched by
  // compressAlone) + the raw data — enough to exercise framing + speed.
  const stubEncode = (data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(LZMA_ALONE_HEADER_LEN + data.length);
    out.set(expectedAloneHeaderPrefix(), 0);
    out.set(data, LZMA_ALONE_HEADER_LEN);
    return out;
  };
  const job = labelToJob(r, geom, stubEncode, { quarterTurns: 1 });

  assert.ok(job.frames.length > 0, "no frames");
  for (const f of job.frames) assert.equal(f.length, 512, "frame not 512 bytes");
  assert.ok(job.compressedLen > 0, "empty compressed stream");
  assert.equal(typeof job.speed, "number");
  assert.ok(job.speed >= 0);
});
