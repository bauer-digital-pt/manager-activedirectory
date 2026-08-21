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
  flipBitmap,
  labelToColumnMajor,
  labelToJob,
  fitLabelStyle,
  type LabelRender,
} from "../../src/main/supvan/label.ts";
import { encodeQr } from "../../src/main/supvan/qr.ts";
import { measureText, drawText, GLYPH_H } from "../../src/main/supvan/font.ts";
import { MonoCanvas } from "../../src/main/supvan/mono.ts";
import { DEFAULT_GEOMETRY, E11_GEOMETRY, type Geometry } from "../../src/main/supvan/job.ts";
import { expectedAloneHeaderPrefix, LZMA_ALONE_HEADER_LEN } from "../../src/main/supvan/compress.ts";

/** Read a pixel from a row-major MSB-first bitmap (dark = 1). */
const bitAt = (bmp: { data: Uint8Array; bytesPerLine: number }, x: number, y: number): boolean =>
  ((bmp.data[y * bmp.bytesPerLine + (x >> 3)] >> (7 - (x & 7))) & 1) !== 0;

test("renderLabel embeds the QR readable module-for-module", () => {
  const model = { qr: "https://pt.ezofficeinventory.com/assets/12345", lines: ["PT-LPT-TI-0007"] };
  const scale = 3;
  const quiet = 4;
  const r = renderLabel(model, { qrScale: scale, qrQuiet: quiet });
  assert.ok(r.qr, "a URL payload must embed a QR");
  assert.ok(r.qrBlock, "a URL payload must reserve a QR block");

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
  // showBrand:false isolates the QR+text formula — the brand mark's own geometry
  // is covered by its dedicated tests below.
  const style = { qrScale: 2, qrQuiet: 4, textScale: 2, letterSpacing: 1, lineGap: 2, gap: 6, padding: 2, showBrand: false };
  const r = renderLabel(model, style);
  assert.ok(r.qrBlock, "a URL payload must reserve a QR block");

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
  const r = renderLabel({ qr: "X", lines: [] }, { qrScale: scale, qrQuiet: quiet, padding, showBrand: false });
  const ref = encodeQr("X", { ecc: "M" });
  const block = (ref.size + 2 * quiet) * scale;
  assert.equal(r.width, padding * 2 + block);
  assert.equal(r.height, padding * 2 + block);
});

test("no QR payload degrades to a logo + text label (no QR region, single gap)", () => {
  // Regression: an empty payload (AD-only device / unconfigured URL template) used
  // to throw in encodeQr and hard-block the print. It must instead compose a
  // logo + text label with no QR region at all.
  const model = { qr: "", lines: ["PT-LPT-TI-0007", "DELL 5540"] };
  const gap = 6;
  const padding = 2;
  const textScale = 2;
  const letterSpacing = 1;

  let r!: LabelRender;
  assert.doesNotThrow(() => {
    r = renderLabel(model, { qrScale: 2, gap, padding, textScale, letterSpacing });
  }, "an empty QR payload must not throw");

  assert.equal(r.qr, null, "empty payload ⇒ no QR encoded");
  assert.equal(r.qrBlock, null, "empty payload ⇒ no QR block");
  assert.ok(r.brandBlock, "the logo is still drawn");

  // Width is logo + ONE gap + text (+ padding both ends) — never a phantom double
  // gap where the QR would have been.
  const b = r.brandBlock!;
  const textWidth = Math.max(
    ...model.lines.map((l) => measureText(l, { scale: textScale, letterSpacing }).width),
  );
  assert.equal(b.x, padding, "logo sits at the left padding");
  assert.equal(r.width, padding + b.width + gap + textWidth + padding, "logo + one gap + text");
});

test("a QR-less label still fits and maps to the E11 head", () => {
  const model = { qr: "", lines: ["PT-LPT-TI-0007", "DELL 5540", "SN ABC123"] };
  const fit = fitLabelStyle(model, E11_GEOMETRY, {}, { quarterTurns: 3 });
  assert.ok(fit, "a logo + text label must find a fitting style");
  assert.equal(fit!.render.qr, null, "the fitting render carries no QR");
  assert.doesNotThrow(() => labelToColumnMajor(fit!.render, E11_GEOMETRY, { quarterTurns: 3 }));
});

test("text lines render where the font would place them", () => {
  const model = { qr: "EZ/1", lines: ["PT-01", "SERIAL9"] };
  // showBrand:false keeps contentHeight = max(qrBlock, textHeight); the brand
  // mark (64 dots tall) would otherwise raise it and shift the vertical centering.
  const style = { qrScale: 2, qrQuiet: 4, textScale: 2, letterSpacing: 1, lineGap: 2, gap: 6, padding: 2, showBrand: false };
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

test("the brand mark is drawn by default at the start, before the QR", () => {
  const model = { qr: "https://bmap.ezofficeinventory.com/a/611?c=616e", lines: ["PT-LPT-TI-1"] };
  const withBrand = renderLabel(model, { qrScale: 2 });
  const bare = renderLabel(model, { qrScale: 2, showBrand: false });

  // Present by default, absent when opted out.
  assert.ok(withBrand.brandBlock, "brand block should be present by default");
  assert.ok(withBrand.qrBlock, "a URL payload must reserve a QR block");
  assert.equal(bare.brandBlock, null, "showBrand:false omits the brand");

  const b = withBrand.brandBlock!;
  // Layout is logo → QR → text: the logo sits at the left padding, and its right
  // edge is before the QR block, separated by a gap (so it never touches QR data).
  assert.equal(b.x, /*padding*/ 2, "brand starts at the left padding");
  assert.ok(b.x + b.width <= withBrand.qrBlock.x, "brand ends before the QR block");
  assert.ok(withBrand.qrBlock.x - (b.x + b.width) >= /*gap*/ 6, "a gap separates the logo from the QR");
  // Only the feed axis grew: the brand lengthens the natural width, not the across
  // axis for this URL QR (QR block ≥ mark 64 dots).
  assert.equal(withBrand.height, bare.height, "brand must not change the across axis here");
  assert.equal(withBrand.width, bare.width + /*gap*/ 6 + b.width, "brand adds gap + its width");
  // The mark carries ink and lands fully inside the canvas.
  assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= withBrand.width && b.y + b.height <= withBrand.height);
  let anyInk = false;
  for (let y = b.y; y < b.y + b.height && !anyInk; y++)
    for (let x = b.x; x < b.x + b.width; x++) if (withBrand.canvas.get(x, y)) { anyInk = true; break; }
  assert.ok(anyInk, "brand mark should have drawn some dots");
});

test("the brand mark never breaks the E11 across-head fit", () => {
  // A branded URL label must still fit the 96-dot 12 mm head after the 270° turn.
  const model = { qr: "https://bmap.ezofficeinventory.com/a/611?c=616e", lines: ["PT-LPT-TI-1", "DELL 5540"] };
  const fit = fitLabelStyle(model, E11_GEOMETRY, {}, { quarterTurns: 3 });
  assert.ok(fit, "branded label should still find a fitting scale");
  assert.ok(fit!.render.brandBlock, "the fitting render keeps the brand");
  assert.doesNotThrow(() => labelToColumnMajor(fit!.render, E11_GEOMETRY, { quarterTurns: 3 }));
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

// Read a dot from a column-major LSB-first ColumnMajorImage:
// byte = data[col*bytesPerLine + (dot>>3)], bit = dot&7.
const cmBit = (img: { data: Uint8Array; bytesPerLine: number }, col: number, dot: number): boolean =>
  ((img.data[col * img.bytesPerLine + (dot >> 3)] >> (dot & 7)) & 1) !== 0;

test("flipBitmap is a reflection: identity with no axis, reverses the chosen axis", () => {
  const c = new MonoCanvas(4, 2);
  c.set(0, 0, true); // top-left
  const bmp = c.toBitmap();
  assert.deepEqual([...flipBitmap(bmp).data], [...bmp.data], "no axis ⇒ identity");
  const fx = flipBitmap(bmp, { x: true });
  assert.ok(bitAt(fx, 3, 0) && !bitAt(fx, 0, 0), "x flip: (0,0) → (w-1,0)");
  const fy = flipBitmap(bmp, { y: true });
  assert.ok(bitAt(fy, 0, 1) && !bitAt(fy, 0, 0), "y flip: (0,0) → (0,h-1)");
});

test("labelToColumnMajor mirrors the across-tape axis by default (printhead dot order)", () => {
  // One dot at the natural top-left. With quarterTurns=0 the mapping is direct:
  // feed column = source row y (+ marginTop), across dot = source x (+ centering).
  const c = new MonoCanvas(8, 3);
  c.set(0, 0, true);
  const fake = { bitmap: c.toBitmap() } as unknown as LabelRender;
  const geom: Geometry = { ...DEFAULT_GEOMETRY, canvasWidthDots: 24, marginTop: 1, marginBottom: 1 };
  const xOffset = Math.floor((24 - 8) / 2); // centerInPrinthead offset = 8
  const col = geom.marginTop + 0; // the dot's feed column (source y=0)

  const noMirror = labelToColumnMajor(fake, geom, { quarterTurns: 0, mirrorAcross: false });
  const mirrored = labelToColumnMajor(fake, geom, { quarterTurns: 0, mirrorAcross: true });
  const dflt = labelToColumnMajor(fake, geom, { quarterTurns: 0 });

  // Unmirrored: source x=0 → across dot xOffset+0. Mirrored: x=0 → x=w-1=7.
  assert.ok(cmBit(noMirror, col, xOffset + 0) && !cmBit(noMirror, col, xOffset + 7), "unmirrored dot at left");
  assert.ok(cmBit(mirrored, col, xOffset + 7) && !cmBit(mirrored, col, xOffset + 0), "mirrored dot at right");
  // The mirror is across-tape only: the feed column is unchanged either way.
  assert.deepEqual([...dflt.data], [...mirrored.data], "default ⇒ mirrorAcross:true (the hardware default)");
});

test("mirrorFeed reverses the print/column order, leaving the across axis alone", () => {
  const c = new MonoCanvas(8, 3);
  c.set(0, 0, true); // source top row (y=0)
  const fake = { bitmap: c.toBitmap() } as unknown as LabelRender;
  const geom: Geometry = { ...DEFAULT_GEOMETRY, canvasWidthDots: 24, marginTop: 1, marginBottom: 1 };
  const xOffset = Math.floor((24 - 8) / 2);

  // Hold mirrorAcross off so only the feed axis varies between the two.
  const noFeed = labelToColumnMajor(fake, geom, { quarterTurns: 0, mirrorAcross: false, mirrorFeed: false });
  const feed = labelToColumnMajor(fake, geom, { quarterTurns: 0, mirrorAcross: false, mirrorFeed: true });

  // y=0 → first content column (marginTop) without the feed mirror,
  // → last content column (marginTop + h-1) with it — same across dot.
  assert.ok(cmBit(noFeed, geom.marginTop + 0, xOffset + 0), "no feed mirror: content in first content column");
  assert.ok(cmBit(feed, geom.marginTop + (3 - 1), xOffset + 0), "feed mirror: content in last content column");
  assert.ok(!cmBit(feed, geom.marginTop + 0, xOffset + 0), "feed mirror: first content column now clear");
});

test("labelToColumnMajor rejects a label wider than the printhead", () => {
  const r = renderLabel({ qr: "EZ/1", lines: ["X"] }, { qrScale: 3 });
  const geom: Geometry = { ...DEFAULT_GEOMETRY, canvasWidthDots: 8 };
  assert.throws(() => labelToColumnMajor(r, geom, { quarterTurns: 1 }), /across but the printhead/);
});

test("E11_GEOMETRY reflects the fleet's 12 mm × 22 mm / 3 mm-gap media", () => {
  // Across-head = 12 mm at 8 dots/mm ⇒ 96 dots (byte-aligned). Feed margins encode
  // the 3 mm inter-label gap: 1.5 mm each ⇒ 12 dots. Pin it so a stray edit to the
  // tape width or gap can't silently mis-size every label.
  assert.equal(E11_GEOMETRY.canvasWidthDots, 96);
  assert.equal(E11_GEOMETRY.marginTop, 12);
  assert.equal(E11_GEOMETRY.marginBottom, 12);
  assert.equal(E11_GEOMETRY.canvasWidthDots % 8, 0, "printhead width must be byte-aligned");
});

test("fitLabelStyle shrinks a URL QR to fit the narrow E11 head", () => {
  // The intended use: the QR encodes the full asset URL (scanning opens the asset).
  const model = { qr: "https://bauermedia.ezofficeinventory.com/assets/123456", lines: ["PT-LPT-TI-0007"] };

  // At the default scale the rotated label overflows the 120-dot E11 head, so
  // printing would throw the raw core guard — the exact bug fitLabelStyle prevents.
  const big = renderLabel(model, { qrScale: 3 });
  assert.throws(() => labelToColumnMajor(big, E11_GEOMETRY, { quarterTurns: 1 }), /across but the printhead/);

  const fit = fitLabelStyle(model, E11_GEOMETRY, {}, { quarterTurns: 1 });
  assert.ok(fit, "expected a fitting scale");
  assert.ok(fit!.style.qrScale! < 3, "should shrink below the default scale");
  // The chosen render actually fits: mapping it no longer throws.
  assert.doesNotThrow(() => labelToColumnMajor(fit!.render, E11_GEOMETRY, { quarterTurns: 1 }));
  // And it is the LARGEST fitting scale: one step up overflows the head (across =
  // height for the default single quarter-turn).
  const placeable = Math.floor(E11_GEOMETRY.canvasWidthDots / 8) * 8;
  const bigger = renderLabel(model, { qrScale: fit!.style.qrScale! + 1 });
  assert.ok(bigger.height > placeable, "a larger scale should overflow the head");
});

test("fitLabelStyle returns null when the label cannot fit at any scale", () => {
  // An 8-dot head can't hold even a QR v1 (21 modules + quiet) at scale 1.
  const geom: Geometry = { ...DEFAULT_GEOMETRY, canvasWidthDots: 8 };
  const fit = fitLabelStyle({ qr: "https://ez/42", lines: ["X"] }, geom, {}, { quarterTurns: 1 });
  assert.equal(fit, null);
});

test("fitLabelStyle checks the correct axis for the quarter-turn", () => {
  const model = { qr: "https://bauermedia.ezofficeinventory.com/assets/123456", lines: ["PT-LPT-TI-0007", "DELL 5440"] };
  // Unrotated, the WIDE natural label (QR + text side by side) is across the head,
  // so even the minimum-scale QR label is far wider than 120 dots → no fit.
  assert.equal(fitLabelStyle(model, E11_GEOMETRY, {}, { quarterTurns: 0 }), null);
  // The print default (1 quarter-turn) puts the short axis across the head → fits.
  assert.ok(fitLabelStyle(model, E11_GEOMETRY, {}, { quarterTurns: 1 }));
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
