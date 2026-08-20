/**
 * Golden-vector suite for the SUPVAN core. Run with Node 24+ (type-stripping):
 *
 *     node --test test/supvan/golden.test.ts
 *
 * Ground truth:
 *  - Framing, data packets, page/print buffers, calc_speed, parse_status,
 *    parse_material, test patterns, and the LZMA alone header/size patch are
 *    checked byte-for-byte against golden-vectors.json, generated from the
 *    runnable reference client (heeen/supvan-cups, test_print.py). Regenerate
 *    with `test/supvan/gen_golden.py` if the reference changes.
 *  - dither, raster_to_column_major, and center_in_printhead have no Python
 *    equivalent; they are checked against values transcribed from the Rust
 *    reference's #[test] anchors (bitmap.rs / dither.rs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { makeCmd, makeCmdStartTrans } from "../../src/main/supvan/frame.ts";
import {
  makeDataPacket,
  wrapDataFrame,
  buildDataFrames,
  buildFirmwareFrames,
  dataPacketCount,
} from "../../src/main/supvan/data.ts";
import { DATA_MAGIC1, DATA_MAGIC2, FIRMWARE_MAGIC2 } from "../../src/main/supvan/constants.ts";
import {
  buildPageRegBits,
  buildPrintBuffer,
  splitIntoBuffers,
  createTestPattern,
  ditherLine,
  rasterToColumnMajor,
  centerInPrinthead,
} from "../../src/main/supvan/raster.ts";
import { calcSpeed } from "../../src/main/supvan/speed.ts";
import { parseStatus, parseMaterial } from "../../src/main/supvan/status.ts";
import {
  expectedAloneHeaderPrefix,
  patchUncompressedSize,
  compressAlone,
  concatBuffers,
  LZMA_ALONE_PROPS_BYTE,
} from "../../src/main/supvan/compress.ts";
import { buildJobFromColumnMajor } from "../../src/main/supvan/job.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(join(HERE, "golden-vectors.json"), "utf8"),
) as Record<string, any>;

const hexToBytes = (hex: string): Uint8Array => {
  const n = hex.length / 2;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// --- command frames ---------------------------------------------------------
test("make_cmd matches reference", () => {
  for (const v of golden.cmds) {
    assert.equal(bytesToHex(makeCmd(v.cmd, v.param)), v.hex, v.name);
  }
});

test("make_cmd_start_trans matches reference", () => {
  for (const v of golden.startTrans) {
    assert.equal(
      bytesToHex(makeCmdStartTrans(v.cmd, v.blockSize, v.blockCount)),
      v.hex,
      `cmd 0x${v.cmd.toString(16)} bs=${v.blockSize} bc=${v.blockCount}`,
    );
  }
});

// --- data framing -----------------------------------------------------------
test("make_data_packet matches reference", () => {
  for (const v of golden.dataPackets) {
    assert.equal(
      bytesToHex(makeDataPacket(hexToBytes(v.chunkHex), v.idx, v.total)),
      v.hex,
    );
  }
});

test("wrap_data_frame matches reference", () => {
  for (const v of golden.wrapFrames) {
    assert.equal(bytesToHex(wrapDataFrame(hexToBytes(v.payloadHex))), v.hex);
  }
});

test("build_data_frames matches reference", () => {
  for (const v of golden.buildDataFrames) {
    const comp = hexToBytes(v.compressedHex);
    assert.equal(dataPacketCount(comp.length), v.count, "packet count");
    const frames = buildDataFrames(comp);
    assert.equal(frames.length, v.framesHex.length, "frame count");
    frames.forEach((f, i) => assert.equal(bytesToHex(f), v.framesHex[i], `frame ${i}`));
  }
});

// --- div_ceil packet count (reference: len.div_ceil(500), NOT max(1,…)) ------
test("dataPacketCount matches div_ceil with no max(1,…) floor", () => {
  // Boundaries the golden vectors skip. Empty input MUST be 0 (Rust div_ceil,
  // Python (0+499)//500) — a max(1,…) floor would emit a spurious empty packet.
  assert.equal(dataPacketCount(0), 0, "empty -> 0 packets");
  assert.equal(dataPacketCount(1), 1);
  assert.equal(dataPacketCount(499), 1);
  assert.equal(dataPacketCount(500), 1);
  assert.equal(dataPacketCount(501), 2);
  assert.equal(dataPacketCount(1000), 2);
  assert.equal(dataPacketCount(1001), 3);
  assert.equal(dataPacketCount(1100), 3);
});

test("buildDataFrames([]) / buildFirmwareFrames([]) return zero frames", () => {
  assert.equal(buildDataFrames(new Uint8Array(0)).length, 0);
  assert.equal(buildFirmwareFrames(new Uint8Array(0)).length, 0);
});

// --- firmware frames (Rust anchor: test_build_firmware_frames_layout) --------
test("buildFirmwareFrames: 1100 bytes -> 3 frames, 0xAA 0xC7 marker", () => {
  const fw = new Uint8Array(1100).fill(0x42);
  const frames = buildFirmwareFrames(fw);
  assert.equal(frames.length, 3);
  frames.forEach((frame, i) => {
    assert.equal(frame.length, 512, `frame ${i} length`);
    assert.equal(frame[6], DATA_MAGIC1, "packet magic1 0xAA");
    assert.equal(frame[7], FIRMWARE_MAGIC2, "packet marker 0xC7 (not 0xBB)");
    // pkt_idx at frame[6+4], pkt_total at frame[6+5]
    assert.equal(frame[6 + 4], i, "pkt idx");
    assert.equal(frame[6 + 5], 3, "pkt total");
  });
});

test("firmware frames == data frames with only the 0xBB->0xC7 marker changed", () => {
  // The marker sits outside the checksum range [4..506], so a firmware frame is
  // byte-identical to the data frame except at the wrapped packet's byte 1
  // (frame offset 7): 0xBB -> 0xC7. Locks in the "no recompute" invariant.
  const payload = Uint8Array.from({ length: 1234 }, (_, i) => (i * 7 + 3) & 0xff);
  const data = buildDataFrames(payload);
  const fw = buildFirmwareFrames(payload);
  assert.equal(fw.length, data.length);
  fw.forEach((ff, i) => {
    const df = data[i];
    assert.equal(df[7], DATA_MAGIC2, "data frame marker 0xBB");
    assert.equal(ff[7], FIRMWARE_MAGIC2, "firmware frame marker 0xC7");
    for (let b = 0; b < 512; b++) {
      if (b === 7) continue;
      assert.equal(ff[b], df[b], `frame ${i} byte ${b} must match`);
    }
  });
});

// --- page reg bits + print buffers ------------------------------------------
test("build_page_reg_bits matches reference", () => {
  for (const v of golden.pageRegBits) {
    const a = v.args;
    const bits = buildPageRegBits({
      pageSt: !!a.page_st,
      pageEnd: !!a.page_end,
      prtEnd: !!a.prt_end,
      cut: a.cut ?? 0,
      savepaper: !!a.savepaper,
      firstCut: a.first_cut ?? 0,
      nodu: a.nodu ?? 4,
      mat: a.mat ?? 1,
    });
    assert.equal(bytesToHex(bits), v.hex, JSON.stringify(a));
  }
});

test("build_print_buffer matches reference (4096 bytes, checksum)", () => {
  for (const v of golden.printBuffers) {
    const p = v.params;
    const buf = buildPrintBuffer({
      imageData: hexToBytes(v.imageDataHex),
      perLineByte: p.per_line_byte,
      colsInBuf: p.cols_in_buf,
      pageSt: p.page_st,
      pageEnd: p.page_end,
      prtEnd: p.prt_end,
      marginTop: p.margin_top,
      marginBottom: p.margin_bottom,
      density: p.density,
    });
    assert.equal(buf.length, 4096);
    assert.equal(bytesToHex(buf), v.hex, JSON.stringify(p));
  }
});

// --- speed ------------------------------------------------------------------
test("calc_speed thresholds match reference", () => {
  for (const v of golden.calcSpeed) {
    assert.equal(calcSpeed(v.size), v.speed, `size ${v.size}`);
  }
});

// --- status parsing ---------------------------------------------------------
const STATUS_KEY_MAP: Record<string, string> = {
  buf_full: "bufFull",
  label_rw_error: "labelRwError",
  label_end: "labelEnd",
  label_mode_error: "labelModeError",
  ribbon_rw_error: "ribbonRwError",
  ribbon_end: "ribbonEnd",
  low_battery: "lowBattery",
  device_busy: "deviceBusy",
  head_temp_high: "headTempHigh",
  cover_open: "coverOpen",
  insert_usb: "insertUsb",
  printing: "printing",
  label_not_installed: "labelNotInstalled",
  print_count: "printCount",
};

test("parse_status matches reference", () => {
  for (const v of golden.parseStatus) {
    const got = parseStatus(hexToBytes(v.inputHex));
    assert.ok(got, "should parse");
    for (const [pyKey, expected] of Object.entries(v.expected)) {
      const tsKey = STATUS_KEY_MAP[pyKey] as keyof typeof got;
      assert.equal(got[tsKey], expected, pyKey);
    }
  }
});

test("parse_status rejects invalid frames", () => {
  for (const hex of golden.parseStatusNull) {
    assert.equal(parseStatus(hexToBytes(hex)), null);
  }
});

test("parse_material matches reference", () => {
  for (const v of golden.parseMaterial) {
    const got = parseMaterial(hexToBytes(v.inputHex));
    assert.ok(got, "should parse");
    const e = v.expected;
    assert.equal(got.uuid, e.uuid, "uuid");
    assert.equal(got.code, e.code, "code");
    assert.equal(got.sn, e.sn, "sn");
    assert.equal(got.labelType, e.type, "labelType");
    assert.equal(got.widthMm, e.width, "width");
    assert.equal(got.heightMm, e.height, "height");
    assert.equal(got.gapMm, e.gap, "gap");
    // Python omits 'remind' when the frame is too short; we return null.
    assert.equal(got.remaining, "remind" in e ? e.remind : null, "remaining");
  }
});

// --- test patterns (byte-exact reference image) -----------------------------
test("create_test_pattern matches reference bytes", () => {
  for (const v of golden.testPatterns) {
    const p = createTestPattern(v.labelWidthMm, v.heightMm, v.dpi);
    assert.equal(p.canvasWidthDots, v.canvasWidthDots, "canvas width");
    assert.equal(p.heightDots, v.heightDots, "height dots");
    assert.equal(p.bytesPerLine, v.bytesPerLine, "bytes/line");
    assert.equal(
      bytesToHex(p.data),
      v.dataHex,
      `pattern ${v.labelWidthMm}x${v.heightMm}`,
    );
  }
});

// --- LZMA alone header + size patch -----------------------------------------
test("expected alone header prefix (props 0x5D, dict 8192)", () => {
  assert.equal(LZMA_ALONE_PROPS_BYTE, 0x5d);
  const prefix = expectedAloneHeaderPrefix();
  for (const v of golden.lzma) {
    const patched = hexToBytes(v.patchedHex);
    assert.deepEqual(prefix, patched.subarray(0, 5), "header prefix");
  }
});

test("patchUncompressedSize reproduces reference patch byte-for-byte", () => {
  for (const v of golden.lzma) {
    const raw = hexToBytes(v.rawHex);
    const patched = patchUncompressedSize(raw.slice(), v.inputLen);
    assert.equal(bytesToHex(patched), v.patchedHex, `len ${v.inputLen}`);
  }
});

test("compressAlone (with injected reference stream) matches reference", () => {
  for (const v of golden.lzma) {
    const raw = hexToBytes(v.rawHex);
    // Inject the reference raw stream as the encoder output; compressAlone
    // validates the header and applies the size patch — the byte-exact part
    // we own. (Patch is idempotent, so injecting the patched stream is also OK.)
    const input = new Uint8Array(v.inputLen); // content irrelevant to our logic
    const out = compressAlone(input, () => raw);
    assert.equal(bytesToHex(out), v.patchedHex, `len ${v.inputLen}`);
  }
});

// --- end-to-end job assembly (buffers + frames + speed) ---------------------
test("job40x30: split_into_buffers + concat match reference", () => {
  const j = golden.job40x30;
  const pat = createTestPattern(j.labelWidthMm, j.heightMm, golden.testPatterns[0].dpi);
  const buffers = splitIntoBuffers(
    pat.data,
    j.bytesPerLine,
    j.totalCols,
    j.marginTop,
    j.marginBottom,
    j.density,
  );
  assert.equal(buffers.length, j.bufferCount, "buffer count");
  buffers.forEach((b, i) => assert.equal(bytesToHex(b), j.buffersHex[i], `buffer ${i}`));
  assert.equal(bytesToHex(concatBuffers(buffers)), j.concatHex, "concat");
});

test("job40x30: buildJobFromColumnMajor derives frames + speed from reference stream", () => {
  const j = golden.job40x30;
  const pat = createTestPattern(j.labelWidthMm, j.heightMm, golden.testPatterns[0].dpi);
  const compressed = hexToBytes(j.compressedHex);
  const job = buildJobFromColumnMajor(
    { data: pat.data, bytesPerLine: j.bytesPerLine, totalCols: j.totalCols },
    {
      canvasWidthDots: j.canvasWidthDots,
      marginTop: j.marginTop,
      marginBottom: j.marginBottom,
      density: j.density,
    },
    // inject the reference-produced compressed stream (patch idempotent)
    () => compressed,
  );
  assert.equal(job.compressedLen, j.compressedLen, "compressed len");
  assert.equal(job.speed, j.speed, "speed");
  assert.equal(job.frames.length, dataPacketCount(j.compressedLen), "frame count");
  // frames must equal buildDataFrames(compressed)
  const ref = buildDataFrames(compressed);
  job.frames.forEach((f, i) => assert.equal(bytesToHex(f), bytesToHex(ref[i]), `frame ${i}`));
});

// --- Rust-only anchors (bitmap.rs / dither.rs #[test]) ----------------------
test("dither_line: all-black -> 0xFF, all-white -> 0x00 (Rust anchor)", () => {
  const black = new Uint8Array(8).fill(0x00);
  let mono = new Uint8Array(1);
  ditherLine(black, 8, 0, mono);
  assert.equal(mono[0], 0xff, "all black");

  const white = new Uint8Array(8).fill(0xff);
  mono = new Uint8Array(1);
  ditherLine(white, 8, 0, mono);
  assert.equal(mono[0], 0x00, "all white");
});

test("dither_line: sRGB 0x80 midtone lands ~25% coverage (Rust anchor)", () => {
  const line = new Uint8Array(32).fill(0x80);
  let bits = 0;
  for (let y = 0; y < 4; y++) {
    const mono = new Uint8Array(4);
    ditherLine(line, 32, y, mono);
    for (const b of mono) bits += popcount(b);
  }
  assert.ok(bits > 16 && bits < 64, `expected ~25% bits, got ${bits}/128`);
});

test("raster_to_column_major: 8x2 [0xFF,0x00] -> [0xFF,0x00] (Rust anchor)", () => {
  const { data, cols, bytesPerLine } = rasterToColumnMajor(
    new Uint8Array([0xff, 0x00]),
    8,
    2,
  );
  assert.equal(cols, 2);
  assert.equal(bytesPerLine, 1);
  assert.equal(data[0], 0xff);
  assert.equal(data[1], 0x00);
});

test("center_in_printhead: 8-dot input centered in 24 (Rust anchor)", () => {
  const { data, bytesPerLine } = centerInPrinthead(
    new Uint8Array([0xff, 0xff]),
    2,
    8,
    24,
  );
  assert.equal(bytesPerLine, 3);
  // col 0: [0x00, 0xFF, 0x00]; col 1: [0x00, 0xFF, 0x00]
  assert.deepEqual(Array.from(data), [0x00, 0xff, 0x00, 0x00, 0xff, 0x00]);
});

function popcount(b: number): number {
  let c = 0;
  while (b) {
    b &= b - 1;
    c++;
  }
  return c;
}
