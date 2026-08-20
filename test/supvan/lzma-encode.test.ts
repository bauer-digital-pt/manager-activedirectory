/**
 * Correctness proof for the pure-TS LZMA1-alone encoder (src/main/supvan/
 * lzma-encode.ts). We cannot byte-compare against a reference (LZMA output is not
 * canonical), so we prove the stronger property that actually matters: every
 * stream we emit DECODES back to the exact input under a canonical LZMA1-alone
 * decoder — Python's `lzma.decompress(..., FORMAT_ALONE)`, which reads the
 * parameters straight from our header (props 0x5D, dict 8192, definite size).
 *
 * That is the same LZMA1 family the E11 firmware decodes with; a stream that
 * round-trips here is a well-formed alone stream. (Whether the specific firmware
 * accepts it is plan risk R5 — a hardware bring-up item, not testable offline.)
 *
 * Skips gracefully if python3+lzma is unavailable so CI without Python still runs
 * the rest of the suite.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lzmaAloneEncode } from "../../src/main/supvan/lzma-encode.ts";
import {
  compressAlone,
  compressBuffersForPrint,
  LZMA_ALONE_PROPS_BYTE,
  LZMA_DICT_SIZE,
} from "../../src/main/supvan/compress.ts";

/** Decode an LZMA1-alone stream with Python's canonical decoder. */
function pyDecodeAlone(stream: Uint8Array): Uint8Array {
  const out = execFileSync(
    "python3",
    [
      "-c",
      "import sys,lzma;sys.stdout.buffer.write(lzma.decompress(sys.stdin.buffer.read(),format=lzma.FORMAT_ALONE))",
    ],
    { input: Buffer.from(stream), maxBuffer: 64 * 1024 * 1024 },
  );
  return new Uint8Array(out);
}

let pythonOk = false;
before(() => {
  try {
    execFileSync("python3", ["-c", "import lzma"], { stdio: "ignore" });
    pythonOk = true;
  } catch {
    pythonOk = false;
  }
});

/** Assorted inputs: edges, sparse 1-bit-raster-like runs, and pseudo-random. */
function makeInputs(): Array<{ label: string; data: Uint8Array }> {
  const cases: Array<{ label: string; data: Uint8Array }> = [];
  cases.push({ label: "single byte", data: Uint8Array.of(0x00) });
  cases.push({ label: "one nonzero byte", data: Uint8Array.of(0xa5) });
  cases.push({ label: "all zeros 4096", data: new Uint8Array(4096) });
  cases.push({ label: "all ones 4096", data: new Uint8Array(4096).fill(0xff) });

  // Alternating — a stress pattern for the literal model.
  const alt = new Uint8Array(1024);
  for (let i = 0; i < alt.length; i++) alt[i] = i & 1 ? 0xff : 0x00;
  cases.push({ label: "alternating 00/ff", data: alt });

  // Sparse raster: mostly zeros with occasional set bytes (like QR + text).
  const sparse = new Uint8Array(6000);
  for (let i = 0; i < sparse.length; i += 37) sparse[i] = (i * 7) & 0xff;
  cases.push({ label: "sparse raster 6000", data: sparse });

  // Deterministic pseudo-random (worst case for compression, still must round-trip).
  const rnd = new Uint8Array(5000);
  let s = 0x12345678;
  for (let i = 0; i < rnd.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    rnd[i] = (s >>> 16) & 0xff;
  }
  cases.push({ label: "pseudo-random 5000", data: rnd });

  // Larger than the 8 KiB dict — proves literals-only is dict-independent.
  const big = new Uint8Array(20000);
  for (let i = 0; i < big.length; i++) big[i] = (i >>> 3) & 0xff;
  cases.push({ label: "20000 bytes (> dict)", data: big });

  return cases;
}

test("lzmaAloneEncode emits the vendor alone header with the unknown-size sentinel", () => {
  const stream = lzmaAloneEncode(Uint8Array.of(1, 2, 3, 4, 5));
  assert.equal(stream[0], LZMA_ALONE_PROPS_BYTE, "props byte must be 0x5D");
  assert.equal(stream[1], LZMA_DICT_SIZE & 0xff);
  assert.equal(stream[2], (LZMA_DICT_SIZE >>> 8) & 0xff);
  assert.equal(stream[3], (LZMA_DICT_SIZE >>> 16) & 0xff);
  assert.equal(stream[4], (LZMA_DICT_SIZE >>> 24) & 0xff);
  // Size field: 0xFFFFFFFFFFFFFFFF ("unknown"; the end marker delimits the stream).
  // compressAlone patches this to the definite size before it reaches the firmware.
  for (let i = 5; i < 13; i++) assert.equal(stream[i], 0xff);
});

test("compressAlone patches the sentinel to the definite little-endian size", () => {
  const out = compressAlone(Uint8Array.of(1, 2, 3, 4, 5), lzmaAloneEncode);
  assert.equal(out[5], 5, "low byte of the u64 size");
  for (let i = 6; i < 13; i++) assert.equal(out[i], 0, "high bytes of the u64 size");
});

test("compressAlone accepts the encoder (header prefix passes)", () => {
  // compressAlone throws if the header prefix is wrong — this asserts params match.
  const out = compressAlone(Uint8Array.of(9, 8, 7, 6), lzmaAloneEncode);
  assert.equal(out[0], LZMA_ALONE_PROPS_BYTE);
  assert.equal(out.length >= 13, true);
});

test("every encoded stream round-trips through Python FORMAT_ALONE", (t) => {
  if (!pythonOk) return t.skip("python3+lzma unavailable");
  for (const { label, data } of makeInputs()) {
    const stream = compressAlone(data, lzmaAloneEncode);
    const decoded = pyDecodeAlone(stream);
    assert.deepEqual(decoded, data, `round-trip mismatch for: ${label}`);
  }
});

test("empty input round-trips", (t) => {
  if (!pythonOk) return t.skip("python3+lzma unavailable");
  const stream = compressAlone(new Uint8Array(0), lzmaAloneEncode);
  const decoded = pyDecodeAlone(stream);
  assert.equal(decoded.length, 0);
});

test("fuzz: random lengths and contents all round-trip", (t) => {
  if (!pythonOk) return t.skip("python3+lzma unavailable");
  // Deterministic LCG so failures reproduce. Exercises the carry/adaptive-model
  // paths that a fixed corpus can miss (this is where a missing prob-update or a
  // shiftLow carry bug hides — it only surfaces on specific bit sequences).
  let s = 0xc0ffee;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) >>> 8);
  for (let iter = 0; iter < 40; iter++) {
    const len = rand() % 800; // 0..799, spanning the posState cycle many times
    const data = new Uint8Array(len);
    // Mix mostly-repetitive bytes with occasional noise — like real 1-bit raster.
    for (let i = 0; i < len; i++) data[i] = rand() % 5 === 0 ? rand() & 0xff : 0xff;
    const decoded = pyDecodeAlone(compressAlone(data, lzmaAloneEncode));
    assert.deepEqual(decoded, data, `fuzz round-trip mismatch (iter ${iter}, len ${len})`);
  }
});

test("compressBuffersForPrint output round-trips (real print-buffer path)", (t) => {
  if (!pythonOk) return t.skip("python3+lzma unavailable");
  // Two 4096-byte print buffers as the job pipeline would concatenate them.
  const b0 = new Uint8Array(4096);
  const b1 = new Uint8Array(4096);
  for (let i = 0; i < 4096; i += 11) b0[i] = 0xff;
  for (let i = 0; i < 4096; i += 5) b1[i] = (i * 3) & 0xff;
  const { compressed } = compressBuffersForPrint([b0, b1], lzmaAloneEncode);
  const decoded = pyDecodeAlone(compressed);
  const expected = new Uint8Array(8192);
  expected.set(b0, 0);
  expected.set(b1, 4096);
  assert.deepEqual(decoded, expected);
});
