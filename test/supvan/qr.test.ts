/**
 * QR encoder golden-vector suite. Compares our pure-TS byte-mode encoder
 * against `segno` (conformant reference) BYTE-FOR-BYTE across many inputs,
 * versions and ECC levels.
 *
 *     node --test test/supvan/qr.test.ts
 *
 * Regenerate qr-golden.json with test/supvan/gen_qr_golden.py (needs segno).
 *
 * Two record kinds:
 *  - "fixed": mask pinned in both -> validates data placement, RS ECC,
 *    interleaving, format bits, and function patterns independent of masking.
 *  - "auto": mask omitted -> additionally validates OUR penalty-based mask
 *    selection matches segno's chosen mask.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { encodeQr, type Ecc } from "../../src/main/supvan/qr.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(HERE, "qr-golden.json"), "utf8")) as {
  segno: string;
  vectors: Array<{
    text: string;
    ecc: string;
    version: number;
    mask: number;
    kind: "fixed" | "auto";
    size: number;
    rows: string[];
  }>;
};

const rowsToStrings = (modules: boolean[][]): string[] =>
  modules.map((row) => row.map((d) => (d ? "1" : "0")).join(""));

test(`QR encoder matches segno ${golden.segno} across all vectors`, () => {
  assert.ok(golden.vectors.length >= 100, "expected a broad vector set");
  for (const v of golden.vectors) {
    const qr = encodeQr(v.text, {
      ecc: v.ecc as Ecc,
      mask: v.kind === "fixed" ? v.mask : undefined,
    });
    const label = `text=${JSON.stringify(v.text.slice(0, 24))} ecc=${v.ecc} ${v.kind}`;
    assert.equal(qr.version, v.version, `${label}: version`);
    assert.equal(qr.size, v.size, `${label}: size`);
    if (v.kind === "auto") {
      assert.equal(qr.mask, v.mask, `${label}: auto-selected mask`);
    } else {
      assert.equal(qr.mask, v.mask, `${label}: pinned mask`);
    }
    const got = rowsToStrings(qr.modules);
    assert.equal(got.length, v.rows.length, `${label}: row count`);
    for (let y = 0; y < v.rows.length; y++) {
      assert.equal(got[y], v.rows[y], `${label}: row ${y}`);
    }
  }
});

test("QR encoder handles empty input (byte mode, version 1)", () => {
  // segno rejects empty content; verify our encoder still produces a valid
  // smallest symbol (mode indicator + zero length + padding).
  const qr = encodeQr("", { ecc: "M" });
  assert.equal(qr.version, 1);
  assert.equal(qr.size, 21);
  assert.equal(qr.modules.length, 21);
});

test("QR encoder selects the smallest fitting version", () => {
  // Byte-mode capacity at version 1 / ECC L is 17 data bytes; 18 forces v2.
  const at1 = encodeQr("x".repeat(17), { ecc: "L" });
  assert.equal(at1.version, 1, "17 bytes fits version 1");
  const at2 = encodeQr("x".repeat(18), { ecc: "L" });
  assert.equal(at2.version, 2, "18 bytes needs version 2");
});

test("QR encoder rejects content beyond version 40 / ECC H", () => {
  assert.throws(() => encodeQr("x".repeat(5000), { ecc: "H" }), /too long/);
});

test("QR encoder rejects invalid mask / version bounds", () => {
  assert.throws(() => encodeQr("hi", { mask: 8 }), /mask/);
  assert.throws(
    () => encodeQr("hi", { minVersion: 5, maxVersion: 2 }),
    /minVersion/,
  );
});
