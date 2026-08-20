/**
 * Frame-reassembler tests. Feeds byte vectors that mimic the ways a transport can
 * chop up SUPVAN response frames (whole, split, coalesced, garbage) and asserts
 * the delimiter-based re-framing, including flush() of the trailing frame.
 *
 *     node --test test/supvan/reassembler.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  createFrameReassembler,
  MAX_FRAME_BYTES,
} from "../../src/main/supvan/transport/reassembler.ts";
import { MAGIC1, MAGIC2 } from "../../src/main/supvan/constants.ts";

/** A frame that starts with the magic and carries `body` after it. */
function frame(...body: number[]): Uint8Array {
  return Uint8Array.from([MAGIC1, MAGIC2, ...body]);
}

/** Compare arrays of Uint8Array by contents. */
function eq(actual: Uint8Array[], expected: number[][]): void {
  assert.deepEqual(
    actual.map((f) => [...f]),
    expected,
  );
}

test("emits nothing until a following delimiter closes the first frame", () => {
  const r = createFrameReassembler();
  // A single whole frame with no successor is NOT emitted by push — it has no
  // trailing delimiter yet; it belongs to flush().
  eq(r.push(frame(0x10, 0x00, 0x01)), []);
  assert.equal(r.buffered, 5);
  eq([r.flush()!], [[MAGIC1, MAGIC2, 0x10, 0x00, 0x01]]);
  assert.equal(r.buffered, 0);
  assert.equal(r.flush(), null);
});

test("splits two coalesced frames on the interior delimiter", () => {
  const r = createFrameReassembler();
  const buf = Uint8Array.from([...frame(0x11, 0x22), ...frame(0x33)]);
  // First frame closes at the second delimiter; second frame stays pending.
  eq(r.push(buf), [[MAGIC1, MAGIC2, 0x11, 0x22]]);
  eq([r.flush()!], [[MAGIC1, MAGIC2, 0x33]]);
});

test("reassembles a frame delivered in two chunks", () => {
  const r = createFrameReassembler();
  eq(r.push(Uint8Array.from([MAGIC1, MAGIC2, 0xaa])), []);
  eq(r.push(Uint8Array.from([0xbb, 0xcc])), []);
  eq([r.flush()!], [[MAGIC1, MAGIC2, 0xaa, 0xbb, 0xcc]]);
});

test("handles a delimiter split across the chunk boundary", () => {
  const r = createFrameReassembler();
  // First frame body, then a lone 0x7E ending the chunk (possible split magic).
  eq(r.push(Uint8Array.from([MAGIC1, MAGIC2, 0x01, MAGIC1])), []);
  assert.equal(r.buffered, 4);
  // The 0x5A arrives next: the lone 0x7E was the start of the second delimiter.
  eq(r.push(Uint8Array.from([MAGIC2, 0x02])), [[MAGIC1, MAGIC2, 0x01]]);
  eq([r.flush()!], [[MAGIC1, MAGIC2, 0x02]]);
});

test("does not treat a lone 0x7E (not followed by 0x5A) as a delimiter", () => {
  const r = createFrameReassembler();
  // 0x7E inside the payload, followed by a non-0x5A byte — stays in the frame.
  eq(r.push(Uint8Array.from([MAGIC1, MAGIC2, MAGIC1, 0x99])), []);
  eq([r.flush()!], [[MAGIC1, MAGIC2, MAGIC1, 0x99]]);
});

test("resyncs past leading garbage to the first real delimiter", () => {
  const r = createFrameReassembler();
  const buf = Uint8Array.from([0x00, 0xff, 0x13, ...frame(0x42), ...frame(0x43)]);
  eq(r.push(buf), [[MAGIC1, MAGIC2, 0x42]]);
  eq([r.flush()!], [[MAGIC1, MAGIC2, 0x43]]);
});

test("drops garbage with no delimiter but keeps a trailing lone 0x7E", () => {
  const r = createFrameReassembler();
  eq(r.push(Uint8Array.from([0x00, 0x01, 0x02, MAGIC1])), []);
  assert.equal(r.buffered, 1); // only the trailing 0x7E survives
  eq(r.push(Uint8Array.from([MAGIC2, 0x77])), []); // completes the delimiter
  eq([r.flush()!], [[MAGIC1, MAGIC2, 0x77]]);
});

test("reset() discards buffered bytes", () => {
  const r = createFrameReassembler();
  r.push(frame(0x01, 0x02));
  assert.ok(r.buffered > 0);
  r.reset();
  assert.equal(r.buffered, 0);
  assert.equal(r.flush(), null);
});

test("flush() returns null when the buffer holds no frame start", () => {
  const r = createFrameReassembler();
  r.push(Uint8Array.from([0x01, 0x02, 0x03])); // pure garbage, no magic
  assert.equal(r.flush(), null);
});

test("empty push is a no-op", () => {
  const r = createFrameReassembler();
  eq(r.push(new Uint8Array(0)), []);
  assert.equal(r.buffered, 0);
});

test("emits multiple closed frames from one push", () => {
  const r = createFrameReassembler();
  const buf = Uint8Array.from([...frame(0x01), ...frame(0x02), ...frame(0x03)]);
  // Two frames close (each delimited by the next); the third stays pending.
  eq(r.push(buf), [
    [MAGIC1, MAGIC2, 0x01],
    [MAGIC1, MAGIC2, 0x02],
  ]);
  eq([r.flush()!], [[MAGIC1, MAGIC2, 0x03]]);
});

test("runaway undelimited stream is capped at MAX_FRAME_BYTES", () => {
  const r = createFrameReassembler();
  // Feed more than the cap of non-delimiter bytes; buffer must not exceed the cap.
  const junk = new Uint8Array(MAX_FRAME_BYTES + 5000).fill(0x00);
  r.push(junk);
  assert.ok(r.buffered <= MAX_FRAME_BYTES);
  // A real frame after the flood is still recoverable.
  eq(r.push(Uint8Array.from([...frame(0x55), ...frame(0x56)])), [[MAGIC1, MAGIC2, 0x55]]);
});

test("frames are copies, not views onto shared internal memory", () => {
  const r = createFrameReassembler();
  const [f] = r.push(Uint8Array.from([...frame(0xa1), ...frame(0xa2)]));
  const before = f[2];
  // Subsequent activity must not retroactively mutate an already-emitted frame.
  r.push(frame(0xff, 0xff, 0xff));
  r.reset();
  assert.equal(f[2], before);
});
