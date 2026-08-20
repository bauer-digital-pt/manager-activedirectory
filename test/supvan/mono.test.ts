/**
 * MonoCanvas unit + integration tests. Verifies drawing primitives, the
 * row-major MSB-first packing (dark = 1), and that a rendered QR survives the
 * blit → toBitmap → rasterToColumnMajor pipeline bit-for-bit.
 *
 *     node --test test/supvan/mono.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MonoCanvas } from "../../src/main/supvan/mono.ts";
import { rasterToColumnMajor } from "../../src/main/supvan/raster.ts";
import { encodeQr } from "../../src/main/supvan/qr.ts";

test("MonoCanvas rejects non-positive / non-integer sizes", () => {
  assert.throws(() => new MonoCanvas(0, 10), /invalid size/);
  assert.throws(() => new MonoCanvas(10, -1), /invalid size/);
  assert.throws(() => new MonoCanvas(3.5, 10), /invalid size/);
});

test("set/get and out-of-bounds clipping", () => {
  const c = new MonoCanvas(8, 4);
  assert.equal(c.get(2, 1), false);
  c.set(2, 1, true);
  assert.equal(c.get(2, 1), true);
  c.set(2, 1, false);
  assert.equal(c.get(2, 1), false);
  // OOB writes are silent no-ops and OOB reads are false.
  c.set(-1, 0, true);
  c.set(8, 0, true);
  c.set(0, 4, true);
  assert.equal(c.get(-1, 0), false);
  assert.equal(c.get(8, 0), false);
  assert.equal(c.get(0, 4), false);
});

test("fractional coordinates address no pixel (get light, set no-op)", () => {
  const c = new MonoCanvas(8, 4);
  // A never-set fractional read must be light, not a spurious dark from an
  // undefined typed-array slot at a non-integer index.
  assert.equal(c.get(2.5, 1), false);
  // A fractional write is a no-op — neither neighbouring integer pixel darkens.
  c.set(2.5, 1, true);
  assert.equal(c.get(2, 1), false);
  assert.equal(c.get(3, 1), false);
});

test("fillRect clips to the canvas and fills the interior", () => {
  const c = new MonoCanvas(6, 6);
  c.fillRect(-2, -2, 4, 4, true); // top-left, partially off-canvas
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      assert.equal(c.get(x, y), x < 2 && y < 2, `pixel ${x},${y}`);
    }
  }
});

test("strokeRect draws only the border", () => {
  const c = new MonoCanvas(5, 5);
  c.strokeRect(0, 0, 5, 5, true, 1);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const border = x === 0 || x === 4 || y === 0 || y === 4;
      assert.equal(c.get(x, y), border, `pixel ${x},${y}`);
    }
  }
});

test("toBitmap packs row-major MSB-first with dark = 1", () => {
  const c = new MonoCanvas(10, 2);
  // Row 0: set bit 0 (MSB of byte 0) and bit 9 (bit 1 of byte 1).
  c.set(0, 0, true);
  c.set(9, 0, true);
  // Row 1: set bit 7 (LSB of byte 0).
  c.set(7, 1, true);
  const bmp = c.toBitmap();
  assert.equal(bmp.bytesPerLine, 2); // ceil(10/8)
  assert.equal(bmp.data.length, 4);
  assert.equal(bmp.data[0], 0b1000_0000); // row0 byte0: bit x=0
  assert.equal(bmp.data[1], 0b0100_0000); // row0 byte1: bit x=9 -> (9&7)=1 -> 0x80>>1
  assert.equal(bmp.data[2], 0b0000_0001); // row1 byte0: bit x=7 -> 0x80>>7
  assert.equal(bmp.data[3], 0b0000_0000);
});

test("blitMatrix scales modules to square blocks", () => {
  const c = new MonoCanvas(6, 6);
  const m = [
    [true, false],
    [false, true],
  ];
  c.blitMatrix(m, 0, 0, 3);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      const blockDark = (x < 3 && y < 3) || (x >= 3 && y >= 3);
      assert.equal(c.get(x, y), blockDark, `pixel ${x},${y}`);
    }
  }
});

test("blitGlyph draws a packed 1bpp glyph, transparent on light bits", () => {
  const c = new MonoCanvas(5, 3);
  c.fillRect(0, 0, 5, 3, true); // dark background
  // 5x3 glyph, 1 byte/row: only the middle column (x=2) is dark.
  const glyph = new Uint8Array([0b00100_000, 0b00100_000, 0b00100_000]);
  c.blitGlyph(glyph, 5, 3, 0, 0, 1);
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 5; x++) {
      // Light glyph bits are transparent, so the dark background shows through.
      assert.equal(c.get(x, y), true, `pixel ${x},${y}`);
    }
  }
  // On a light background only the glyph's dark column should appear.
  const c2 = new MonoCanvas(5, 3);
  c2.blitGlyph(glyph, 5, 3, 0, 0, 1);
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 5; x++) {
      assert.equal(c2.get(x, y), x === 2, `pixel ${x},${y}`);
    }
  }
});

test("toBitmap output feeds rasterToColumnMajor with dark pixels preserved", () => {
  const c = new MonoCanvas(12, 5);
  c.set(0, 0, true);
  c.set(11, 4, true);
  c.set(5, 2, true);
  const bmp = c.toBitmap();
  const cm = rasterToColumnMajor(bmp.data, bmp.width, bmp.height);
  // rasterToColumnMajor: output column = input row y, LSB-first within a column.
  assert.equal(cm.cols, 5);
  const isSet = (col: number, dot: number): boolean =>
    ((cm.data[col * cm.bytesPerLine + (dot >> 3)] >> (dot & 7)) & 1) !== 0;
  assert.equal(isSet(0, 0), true); // (x=0,y=0)
  assert.equal(isSet(4, 11), true); // (x=11,y=4)
  assert.equal(isSet(2, 5), true); // (x=5,y=2)
  assert.equal(isSet(0, 1), false);
});

test("a rendered QR survives blit → toBitmap and reads back module-for-module", () => {
  const qr = encodeQr("PT-LPT-TI-0007", { ecc: "M" });
  const scale = 4;
  const quiet = 4 * scale; // 4-module quiet zone, scaled
  const dim = qr.size * scale + quiet * 2;
  const c = new MonoCanvas(dim, dim);
  c.blitMatrix(qr.modules, quiet, quiet, scale);
  const bmp = c.toBitmap();

  // Read a bit back out of the packed bitmap at the centre of each module.
  const bitAt = (x: number, y: number): boolean =>
    ((bmp.data[y * bmp.bytesPerLine + (x >> 3)] >> (7 - (x & 7))) & 1) !== 0;
  for (let r = 0; r < qr.size; r++) {
    for (let col = 0; col < qr.size; col++) {
      const cx = quiet + col * scale + (scale >> 1);
      const cy = quiet + r * scale + (scale >> 1);
      assert.equal(bitAt(cx, cy), qr.modules[r][col], `module ${r},${col}`);
    }
  }
  // The quiet zone stays light.
  assert.equal(bitAt(1, 1), false);
});
