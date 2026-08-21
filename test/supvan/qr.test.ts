/**
 * QR encoder tests.
 *
 * The encoder delegates to node-qrcode (a conformant library). Rather than pin
 * its output byte-for-byte against another generator, these tests verify the
 * symbols are genuinely SCANNABLE by round-tripping each one through a real QR
 * DECODER (jsQR) — an implementation-agnostic guarantee that survives a future
 * library swap.
 *
 *     node --test test/supvan/qr.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import jsQRImport from "jsqr";

import { encodeQr, type Ecc, type QrCode } from "../../src/main/supvan/qr.ts";

// jsQR is CJS; normalise the callable across default/namespace interop.
const jsQR = ((jsQRImport as unknown as { default?: typeof jsQRImport }).default ??
  jsQRImport) as typeof jsQRImport;

/** Render a QR module matrix to an RGBA buffer jsQR can decode (dark = black). */
function toRGBA(qr: QrCode, scale = 6, quiet = 4): { data: Uint8ClampedArray; width: number; height: number } {
  const W = (qr.size + 2 * quiet) * scale;
  const H = W;
  const data = new Uint8ClampedArray(W * H * 4).fill(255); // opaque white
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.modules[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (quiet + c) * scale + dx;
          const py = (quiet + r) * scale + dy;
          const i = (py * W + px) * 4;
          data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
        }
      }
    }
  }
  return { data, width: W, height: H };
}

function decode(qr: QrCode): string | null {
  const img = toRGBA(qr);
  const res = jsQR(img.data, img.width, img.height);
  return res ? res.data : null;
}

// ASCII payloads spanning the real use (asset URLs) plus short ids and a long
// one that forces a higher version. jsQR decodes byte/alphanumeric segments
// reliably; UTF-8 (multibyte) round-tripping is decoder-dependent, so it is
// checked structurally below instead of by exact-string decode.
const PAYLOADS = [
  "X",
  "PT-LPT-TI-0007",
  "https://ez/42",
  "https://bmap.ezofficeinventory.com/a/611?c=616e",
  "https://bauermedia.ezofficeinventory.com/assets/123456",
  "https://pt.ezofficeinventory.com/assets/1234567890?token=abcDEF",
  "0123456789".repeat(10), // 100 chars → higher version
];
const ECCS: Ecc[] = ["L", "M", "Q", "H"];

test("every payload round-trips through a real QR decoder at each ECC level", () => {
  for (const text of PAYLOADS) {
    for (const ecc of ECCS) {
      const qr = encodeQr(text, { ecc });
      const decoded = decode(qr);
      assert.equal(
        decoded,
        text,
        `payload ${JSON.stringify(text.slice(0, 32))} ecc=${ecc} v${qr.version} should decode`,
      );
    }
  }
});

test("encodeQr reports version, size, mask and ecc consistently", () => {
  const qr = encodeQr("https://bauermedia.ezofficeinventory.com/assets/123456", { ecc: "M" });
  assert.equal(qr.size, qr.version * 4 + 17, "size follows the version formula");
  assert.equal(qr.modules.length, qr.size, "row count == size");
  for (const row of qr.modules) assert.equal(row.length, qr.size, "each row == size");
  assert.ok(qr.mask >= 0 && qr.mask <= 7, "mask in range");
  assert.equal(qr.ecc, "M");
});

test("encodeQr is deterministic for the same input", () => {
  const a = encodeQr("PT-LPT-TI-0007", { ecc: "M" });
  const b = encodeQr("PT-LPT-TI-0007", { ecc: "M" });
  assert.equal(a.version, b.version);
  assert.equal(a.mask, b.mask);
  assert.deepEqual(a.modules, b.modules);
});

test("encodeQr selects the smallest fitting version", () => {
  const short = encodeQr("ABC", { ecc: "M" });
  assert.equal(short.version, 1, "3 chars fit version 1");
  const url = encodeQr("https://bauermedia.ezofficeinventory.com/assets/123456", { ecc: "M" });
  assert.ok(url.version >= 3, "a full URL needs a higher version");
});

test("encodeQr honours a pinned mask and still decodes", () => {
  const qr = encodeQr("https://ez/42", { ecc: "M", mask: 5 });
  assert.equal(qr.mask, 5);
  assert.equal(decode(qr), "https://ez/42");
});

test("encodeQr encodes a UTF-8 payload into a well-formed matrix", () => {
  // Multibyte byte-mode: don't assert the decoded string (decoder-dependent),
  // just that a valid, square, in-range symbol is produced without throwing.
  const qr = encodeQr("Ação — çãõ日本語", { ecc: "M" });
  assert.ok(qr.version >= 1 && qr.version <= 40);
  assert.equal(qr.size, qr.version * 4 + 17);
  assert.equal(qr.modules.length, qr.size);
});

test("encodeQr rejects an empty payload", () => {
  assert.throws(() => encodeQr("", { ecc: "M" }), /empty/);
});

test("encodeQr rejects content too long for any version", () => {
  assert.throws(() => encodeQr("x".repeat(5000), { ecc: "H" }), /too long/);
});

test("encodeQr rejects an out-of-range mask", () => {
  assert.throws(() => encodeQr("hi", { mask: 8 }), /mask/);
  assert.throws(() => encodeQr("hi", { mask: -1 }), /mask/);
});
