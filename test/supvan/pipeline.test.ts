/**
 * Print state-machine tests. Drives `SupvanClient.runPrintJob` against a
 * scripted mock `SppPipe` (no hardware), asserting the exact wire sequence and
 * the polling behaviour ported from test_print.py::do_test_print.
 *
 *     node --test test/supvan/pipeline.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  SupvanClient,
  SupvanPrintError,
  type PrintJob,
} from "../../src/main/supvan/pipeline.ts";
import {
  MAGIC1,
  MAGIC2,
  PROTO_ID,
  CMD_CHECK_DEVICE,
  CMD_INQUIRY_STA,
  CMD_START_PRINT,
  CMD_NEXT_ZIPPEDBULK,
  CMD_BUF_FULL,
  DATA_TYPE,
} from "../../src/main/supvan/constants.ts";
import type { SppPipe } from "../../src/main/supvan/transport/pipe.ts";

/** Build a minimal valid ack frame echoing `cmd` at [7]. */
function ack(cmd: number): Uint8Array {
  const f = new Uint8Array(8);
  f[0] = MAGIC1;
  f[1] = MAGIC2;
  f[4] = PROTO_ID;
  f[7] = cmd;
  return f;
}

/** Build a 20-byte INQUIRY_STA response with the given register bytes. */
function statusFrame(b14: number, b15: number, b16: number, b17: number, count = 0): Uint8Array {
  const f = new Uint8Array(20);
  f[0] = MAGIC1;
  f[1] = MAGIC2;
  f[7] = CMD_INQUIRY_STA;
  f[14] = b14;
  f[15] = b15;
  f[16] = b16;
  f[17] = b17;
  f[18] = count & 0xff;
  f[19] = (count >> 8) & 0xff;
  return f;
}

// Named register values for readability.
const BUSY = statusFrame(0, 0x04, 0, 0); // deviceBusy
const READY = statusFrame(0, 0, 0, 0); // idle
const PRINTING_NOT_YET = statusFrame(0, 0, 0, 0); // printing bit clear
const PRINTING = statusFrame(0, 0, 0x40, 0); // FSTA printing
const BUF_FULL_ON = statusFrame(0x01, 0, 0x40, 0); // bufFull + printing
const BUF_READY = statusFrame(0, 0, 0x40, 0); // !bufFull, printing
const COMPLETE = statusFrame(0, 0, 0, 0); // !printing, !busy
// All-zero frame: bad magic -> parseStatus returns null (a transient garbage
// read, common over flaky RFCOMM/BLE).
const NULL_STATUS = new Uint8Array(20);

const isCmd = (f: Uint8Array): boolean => f.length === 16 && f[5] === 0x01;
const isData = (f: Uint8Array): boolean => f.length === 512 && f[5] === DATA_TYPE;

interface Written {
  kind: "cmd" | "data";
  cmd?: number;
  frame: Uint8Array;
}

/**
 * Mock pipe with a scripted status queue. Command frames get canned acks;
 * INQUIRY_STA pulls the next status from `statuses` in order.
 */
class MockPrinter implements SppPipe {
  readonly written: Written[] = [];
  private statusIdx = 0;
  private lastRead: Uint8Array | null = null;
  private readonly statuses: Uint8Array[];

  constructor(statuses: Uint8Array[]) {
    this.statuses = statuses;
  }

  async write(data: Uint8Array): Promise<void> {
    const frame = data.slice();
    if (isCmd(frame)) {
      const cmd = frame[7];
      this.written.push({ kind: "cmd", cmd, frame });
      this.lastRead = this.responseFor(cmd);
    } else if (isData(frame)) {
      this.written.push({ kind: "data", frame });
      this.lastRead = ack(0x00); // per-packet ack
    } else {
      throw new Error(`unexpected frame length ${frame.length}`);
    }
  }

  async read(): Promise<Uint8Array | null> {
    const r = this.lastRead;
    this.lastRead = null;
    return r;
  }

  private responseFor(cmd: number): Uint8Array {
    switch (cmd) {
      case CMD_INQUIRY_STA: {
        const s = this.statuses[Math.min(this.statusIdx, this.statuses.length - 1)];
        this.statusIdx++;
        return s;
      }
      default:
        return ack(cmd);
    }
  }

  cmds(): number[] {
    return this.written.filter((w) => w.kind === "cmd").map((w) => w.cmd!);
  }
  dataFrames(): Written[] {
    return this.written.filter((w) => w.kind === "data");
  }
}

const instantSleep = async (): Promise<void> => {};

function tinyJob(frameCount: number): PrintJob {
  const frames = Array.from({ length: frameCount }, () => {
    const f = new Uint8Array(512);
    f[0] = MAGIC1;
    f[1] = MAGIC2;
    f[5] = DATA_TYPE;
    return f;
  });
  return { frames, compressedLen: frameCount * 500 - 100, speed: 55 };
}

test("runPrintJob: happy path issues the full command sequence in order", async () => {
  // wait-ready: BUSY then READY; wait-printing: NOT_YET then PRINTING;
  // wait-buffer (sleepFirst): BUF_FULL_ON then BUF_READY; complete: COMPLETE.
  const mock = new MockPrinter([
    BUSY,
    READY,
    PRINTING_NOT_YET,
    PRINTING,
    BUF_FULL_ON,
    BUF_READY,
    COMPLETE,
  ]);
  const client = new SupvanClient(mock, { sleep: instantSleep });
  const events: string[] = [];

  await client.runPrintJob(tinyJob(2), {
    sleep: instantSleep,
    onEvent: (e) => events.push(e.phase),
  });

  const cmds = mock.cmds();
  // First command is CHECK_DEVICE.
  assert.equal(cmds[0], CMD_CHECK_DEVICE);
  // START_PRINT precedes NEXT_ZIPPEDBULK precedes BUF_FULL, all present once.
  const iStart = cmds.indexOf(CMD_START_PRINT);
  const iNext = cmds.indexOf(CMD_NEXT_ZIPPEDBULK);
  const iBuf = cmds.indexOf(CMD_BUF_FULL);
  assert.ok(iStart >= 0 && iNext >= 0 && iBuf >= 0, "all transfer cmds present");
  assert.ok(iStart < iNext && iNext < iBuf, "START < NEXT_ZIPPEDBULK < BUF_FULL");
  // Exactly one START_PRINT / NEXT_ZIPPEDBULK / BUF_FULL.
  assert.equal(cmds.filter((c) => c === CMD_BUF_FULL).length, 1);
  // Two data frames sent.
  assert.equal(mock.dataFrames().length, 2);
  // Terminal event.
  assert.equal(events.at(-1), "done");
});

test("runPrintJob: BUF_FULL carries compressedLen (block_size) and speed (block_count)", async () => {
  const mock = new MockPrinter([READY, PRINTING, BUF_READY, COMPLETE]);
  const client = new SupvanClient(mock, { sleep: instantSleep });
  const job = tinyJob(1);
  await client.runPrintJob(job, { sleep: instantSleep });

  const bufFull = mock.written.find((w) => w.kind === "cmd" && w.cmd === CMD_BUF_FULL)!;
  const f = bufFull.frame;
  const blockSize = f[12] | (f[13] << 8);
  const blockCount = f[14] | (f[15] << 8);
  assert.equal(blockSize, job.compressedLen, "BUF_FULL block_size = compressedLen");
  assert.equal(blockCount, job.speed, "BUF_FULL block_count = speed");

  // NEXT_ZIPPEDBULK block_size = 512, block_count = packet count = frames.
  const next = mock.written.find((w) => w.kind === "cmd" && w.cmd === CMD_NEXT_ZIPPEDBULK)!;
  assert.equal(next.frame[12] | (next.frame[13] << 8), 512, "NEXT block_size 512");
  assert.equal(next.frame[14] | (next.frame[15] << 8), 1, "NEXT block_count = packets");
});

test("runPrintJob: only the last data frame is acked (read)", async () => {
  const mock = new MockPrinter([READY, PRINTING, BUF_READY, COMPLETE]);
  // Count read() calls to prove the intermediate frames skip the ack read.
  const reads: string[] = [];
  const orig = mock.read.bind(mock);
  mock.read = async (t?: number) => {
    reads.push("r");
    return orig(t as number);
  };
  const client = new SupvanClient(mock, { sleep: instantSleep });
  await client.runPrintJob(tinyJob(3), { sleep: instantSleep });

  // reads = CHECK_DEVICE(1) + status polls(4) + START_PRINT(1) +
  //         NEXT_ZIPPEDBULK(1) + last-data-frame(1) + BUF_FULL(1) = 9.
  // If every data frame were acked it would be 11.
  assert.equal(reads.length, 9, "intermediate data frames are not acked");
});

test("runPrintJob: aborts when a pre-print error flag is set", async () => {
  // Ready but cover_open (FSTA low bit 0x08 at byte 16).
  const coverOpenReady = statusFrame(0, 0, 0x08, 0);
  const mock = new MockPrinter([coverOpenReady]);
  const client = new SupvanClient(mock, { sleep: instantSleep });
  await assert.rejects(
    () => client.runPrintJob(tinyJob(1), { sleep: instantSleep }),
    (err: unknown) => err instanceof SupvanPrintError && err.code === "device-error",
  );
});

test("runPrintJob: fails fast when CHECK_DEVICE gets no response", async () => {
  const mock = new MockPrinter([READY]);
  // Force CHECK_DEVICE to return null.
  const orig = mock.write.bind(mock);
  mock.write = async (data: Uint8Array) => {
    await orig(data);
    if (data.length === 16 && data[7] === CMD_CHECK_DEVICE) {
      (mock as unknown as { lastRead: Uint8Array | null }).lastRead = null;
    }
  };
  const client = new SupvanClient(mock, { sleep: instantSleep });
  await assert.rejects(
    () => client.runPrintJob(tinyJob(1), { sleep: instantSleep }),
    (err: unknown) => err instanceof SupvanPrintError && err.code === "check-device",
  );
});

test("runPrintJob: wait-printing tolerates a transient null status", async () => {
  // A single garbage frame arrives before the printing bit is first seen.
  // Reference _wait_printing / Rust wait_printing skip the miss and keep
  // polling; the print must still complete (regression: was aborting on it).
  const mock = new MockPrinter([READY, NULL_STATUS, PRINTING, BUF_READY, COMPLETE]);
  const client = new SupvanClient(mock, { sleep: instantSleep });
  const events: string[] = [];
  await client.runPrintJob(tinyJob(1), { sleep: instantSleep, onEvent: (e) => events.push(e.phase) });
  assert.equal(events.at(-1), "done");
  assert.equal(mock.dataFrames().length, 1, "job still transferred");
});

test("runPrintJob: wait-ready still BAILS on a null status (not conflated)", async () => {
  // _wait_ready returns None on the first null — must remain a fatal
  // timeout-ready, distinct from wait-printing's tolerance.
  const mock = new MockPrinter([NULL_STATUS]);
  const client = new SupvanClient(mock, { sleep: instantSleep });
  await assert.rejects(
    () => client.runPrintJob(tinyJob(1), { sleep: instantSleep }),
    (err: unknown) => err instanceof SupvanPrintError && err.code === "timeout-ready",
  );
});

test("runPrintJob: honours an already-aborted signal", async () => {
  const mock = new MockPrinter([READY, PRINTING, BUF_READY, COMPLETE]);
  const client = new SupvanClient(mock, { sleep: instantSleep });
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => client.runPrintJob(tinyJob(1), { sleep: instantSleep, signal: ctrl.signal }),
    (err: unknown) => err instanceof SupvanPrintError && err.code === "aborted",
  );
});
