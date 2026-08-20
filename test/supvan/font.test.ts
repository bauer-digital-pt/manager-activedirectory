/**
 * Bitmap-font tests. Verifies the glyph data is well-formed, that each glyph
 * renders back exactly as authored (packGlyph → blitGlyph round-trip), that
 * character normalisation folds accents/lower-case as documented, and that
 * measureText / drawText agree on advance width and pixel placement.
 *
 *     node --test test/supvan/font.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MonoCanvas } from "../../src/main/supvan/mono.ts";
import {
  GLYPH_W,
  GLYPH_H,
  GLYPH_ROWS,
  glyphKeys,
  hasGlyph,
  normalizeChar,
  measureText,
  drawText,
} from "../../src/main/supvan/font.ts";

test("every glyph is exactly GLYPH_W × GLYPH_H of '0'/'1'", () => {
  for (const [ch, rows] of Object.entries(GLYPH_ROWS)) {
    assert.equal(rows.length, GLYPH_H, `${JSON.stringify(ch)} row count`);
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      assert.equal(row.length, GLYPH_W, `${JSON.stringify(ch)} row ${y} width`);
      assert.match(row, /^[01]+$/, `${JSON.stringify(ch)} row ${y} chars`);
    }
  }
});

test("glyphKeys() matches the authored data and covers the label set", () => {
  const keys = glyphKeys();
  assert.deepEqual(keys.slice().sort(), Object.keys(GLYPH_ROWS).slice().sort());
  // Must have space, all digits, and all upper-case letters.
  const required = [" ", ..."0123456789", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  for (const ch of required) assert.ok(hasGlyph(ch), `missing glyph ${JSON.stringify(ch)}`);
});

test("each glyph renders back exactly as authored (scale 1)", () => {
  for (const [ch, rows] of Object.entries(GLYPH_ROWS)) {
    const c = new MonoCanvas(GLYPH_W, GLYPH_H);
    drawText(c, ch, 0, 0, { scale: 1, letterSpacing: 0 });
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) {
        const want = rows[y][x] === "1";
        assert.equal(c.get(x, y), want, `${JSON.stringify(ch)} pixel ${x},${y}`);
      }
    }
  }
});

test("hasGlyph is exact (no normalisation)", () => {
  assert.ok(hasGlyph("A"));
  assert.ok(hasGlyph("7"));
  assert.ok(hasGlyph("-"));
  assert.ok(!hasGlyph("a")); // lower-case needs folding
  assert.ok(!hasGlyph("á")); // accent needs stripping
  assert.ok(!hasGlyph("~")); // not in the set
});

test("normalizeChar folds lower-case, strips accents, falls back to '?'", () => {
  // Identity for glyphs already present.
  assert.equal(normalizeChar("A"), "A");
  assert.equal(normalizeChar("0"), "0");
  assert.equal(normalizeChar(" "), " ");
  // Lower-case folds to caps.
  assert.equal(normalizeChar("a"), "A");
  assert.equal(normalizeChar("z"), "Z");
  // Accents strip then fold (precomposed and combining forms alike).
  assert.equal(normalizeChar("á"), "A");
  assert.equal(normalizeChar("ç"), "C");
  assert.equal(normalizeChar("ã"), "A");
  assert.equal(normalizeChar("õ"), "O");
  assert.equal(normalizeChar("É"), "E");
  assert.equal(normalizeChar("á"), "A"); // 'a' + combining acute
  // Unknown characters fall back to '?'.
  assert.equal(normalizeChar("~"), "?");
  assert.equal(normalizeChar("€"), "?");
  assert.equal(normalizeChar("好"), "?");
});

test("drawText/measureText handle decomposed (NFD) accented input", () => {
  const opts = { scale: 1, letterSpacing: 0 };
  // Reconstructed from code points so this stays valid even if the file is ever
  // re-saved in NFC: 'a' + U+0301 combining acute must still fold to a single "A".
  const escapedNfd = String.fromCodePoint(0x61, 0x301);
  assert.equal(escapedNfd.length, 2, "guard: escaped NFD really is two code points");
  assert.equal(measureText(escapedNfd, opts).width, GLYPH_W, "escaped NFD á width == one glyph");
  // NFD "á" = 'a' + U+0301 combining acute (how macOS emits it). It must measure
  // and render as a single "A", NOT "A" + a spurious "?" from the orphaned mark.
  const nfdA = "á";
  assert.equal(measureText(nfdA, opts).width, GLYPH_W, "NFD á width == one glyph");
  assert.equal(measureText("á", opts).width, GLYPH_W, "precomposed á width == one glyph");

  const ref = new MonoCanvas(GLYPH_W, GLYPH_H);
  drawText(ref, "A", 0, 0, opts);
  const got = new MonoCanvas(GLYPH_W, GLYPH_H);
  drawText(got, nfdA, 0, 0, opts);
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < GLYPH_W; x++) {
      assert.equal(got.get(x, y), ref.get(x, y), `NFD á pixel ${x},${y}`);
    }
  }

  // A whole decomposed word ("São"/"João" as macOS emits) folds cleanly.
  const nfdSao = "São"; // S + (a + U+0303 combining tilde) + o
  assert.equal(measureText(nfdSao, opts).width, measureText("SAO", opts).width, "NFD São width == SAO");
});

test("measureText: width formula and empty string", () => {
  assert.deepEqual(measureText("", { scale: 2 }), { width: 0, height: GLYPH_H * 2 });
  // 1 glyph: width = GLYPH_W * scale (no trailing spacing).
  assert.deepEqual(measureText("A", { scale: 3, letterSpacing: 1 }), {
    width: GLYPH_W * 3,
    height: GLYPH_H * 3,
  });
  // 3 glyphs: 3*W + 2*spacing, all scaled.
  const scale = 2;
  const spacing = 1;
  assert.deepEqual(measureText("ABC", { scale, letterSpacing: spacing }), {
    width: (3 * GLYPH_W + 2 * spacing) * scale,
    height: GLYPH_H * scale,
  });
  // Defaults: scale 2, spacing 1.
  assert.deepEqual(measureText("ABC"), { width: (3 * GLYPH_W + 2) * 2, height: GLYPH_H * 2 });
});

test("drawText advance width equals measureText width", () => {
  for (const s of ["", "A", "PT-LPT-TI-0007", "EZ #12345"]) {
    for (const opts of [{ scale: 1, letterSpacing: 0 }, { scale: 2, letterSpacing: 1 }, { scale: 3, letterSpacing: 2 }]) {
      const m = measureText(s, opts);
      const c = new MonoCanvas(Math.max(1, m.width), m.height);
      const adv = drawText(c, s, 0, 0, opts);
      assert.equal(adv, m.width, `advance for ${JSON.stringify(s)} @ ${JSON.stringify(opts)}`);
    }
  }
});

test("drawText places glyphs left-to-right at the right stride", () => {
  const scale = 2;
  const spacing = 1;
  const stride = (GLYPH_W + spacing) * scale;
  const text = "AB";
  const m = measureText(text, { scale, letterSpacing: spacing });
  const c = new MonoCanvas(m.width, m.height);
  drawText(c, text, 0, 0, { scale, letterSpacing: spacing });

  // Compare each glyph's region against the authored rows at the expected origin.
  const chars = ["A", "B"];
  for (let i = 0; i < chars.length; i++) {
    const rows = GLYPH_ROWS[chars[i]];
    const ox = i * stride;
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        const want = rows[gy][gx] === "1";
        // Sample the centre of the scaled block.
        const px = ox + gx * scale + (scale >> 1);
        const py = gy * scale + (scale >> 1);
        assert.equal(c.get(px, py), want, `${chars[i]} block ${gx},${gy}`);
      }
    }
  }
  // The inter-glyph spacing column stays light across the whole height.
  const gapX = GLYPH_W * scale; // first blank column after glyph 0
  for (let y = 0; y < m.height; y++) assert.equal(c.get(gapX, y), false, `gap col row ${y}`);
});

test("unknown characters render as the '?' glyph", () => {
  const scale = 1;
  const q = new MonoCanvas(GLYPH_W, GLYPH_H);
  drawText(q, "?", 0, 0, { scale, letterSpacing: 0 });
  const unknown = new MonoCanvas(GLYPH_W, GLYPH_H);
  drawText(unknown, "~", 0, 0, { scale, letterSpacing: 0 });
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < GLYPH_W; x++) {
      assert.equal(unknown.get(x, y), q.get(x, y), `pixel ${x},${y}`);
    }
  }
});
