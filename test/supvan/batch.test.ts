/**
 * Batch print orchestrator (lib/printing.ts → runBatchOnRunner). This is the pure
 * heart of "connect once, print many": it drives a sequence of pre-built jobs on a
 * single already-connected runner, so it can be tested WITHOUT a BLE connection
 * (the connect step needs a user gesture + navigator.bluetooth and is untested,
 * exactly as printLabelViaBle's connect is).
 *
 * Policy under test:
 *   - happy path: every job runs, results carry the caller's original indices;
 *   - skip-and-continue: a job that throws is recorded failed and the loop moves on;
 *   - abort (pre-check): signal already aborted → nothing runs, all cancelled;
 *   - abort (mid-loop): signal trips between jobs → remainder cancelled;
 *   - abort (in-flight): runPrintJob throws code "aborted" → that job + the rest
 *     are cancelled and the loop stops (the pipe is being torn down);
 *   - onItemEvent/onItemSettled callbacks fire correctly.
 *
 *     node --test test/supvan/batch.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  runBatchOnRunner,
  BATCH_CANCELLED,
  type BuiltLabelJob,
  type PrintJobRunner,
  type BatchLabelItemResult,
} from "../../src/renderer/src/lib/printing.ts";
import type { PrintJob, PrintEvent } from "../../src/main/supvan/pipeline.ts";

// A job the runner can identify by its position without caring about real bytes:
// runBatchOnRunner passes the job straight through, so a tagged stub is enough.
function tagJob(tag: number): PrintJob {
  return { __tag: tag } as unknown as PrintJob;
}
function built(indices: number[]): BuiltLabelJob[] {
  return indices.map((index) => ({ index, job: tagJob(index) }));
}
function tagOf(job: PrintJob): number {
  return (job as unknown as { __tag: number }).__tag;
}

/** Per-job scripted behaviour keyed by the job's tag (= its input index). */
type Behavior =
  | { kind: "ok" }
  | { kind: "throw"; message: string }
  | { kind: "aborted" } // rejects like runPrintJob does on AbortSignal
  | { kind: "emit"; event: PrintEvent } // emit one event, then resolve ok
  | { kind: "abortThen"; ctrl: AbortController }; // abort the signal, then resolve ok

// A fake runner that records the order of jobs it was asked to run and reacts per
// the script. Structurally satisfies PrintJobRunner, so runBatchOnRunner accepts it.
function fakeRunner(script: Record<number, Behavior>): PrintJobRunner & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async runPrintJob(job: PrintJob, opts?: { signal?: AbortSignal; onEvent?: (e: PrintEvent) => void }) {
      const tag = tagOf(job);
      calls.push(tag);
      const b = script[tag] ?? { kind: "ok" };
      switch (b.kind) {
        case "ok":
          return;
        case "throw":
          throw new Error(b.message);
        case "aborted": {
          const e = new Error("cancelado") as Error & { code: string };
          e.code = "aborted";
          throw e;
        }
        case "emit":
          opts?.onEvent?.(b.event);
          return;
        case "abortThen":
          b.ctrl.abort();
          return;
      }
    },
  };
}

// Collapse a result list to a compact [index, "ok" | "fail" | "cancel"] shape.
function shape(items: BatchLabelItemResult[]): [number, string][] {
  return items.map((r) => [
    r.index,
    r.ok ? "ok" : r.error === BATCH_CANCELLED ? "cancel" : "fail",
  ]);
}

test("all jobs succeed → results carry input indices, settled once each", async () => {
  const settled: BatchLabelItemResult[] = [];
  const runner = fakeRunner({});
  const items = await runBatchOnRunner(runner, built([0, 1, 2]), {
    onItemSettled: (r) => settled.push(r),
  });

  assert.deepEqual(shape(items), [[0, "ok"], [1, "ok"], [2, "ok"]]);
  assert.deepEqual(runner.calls, [0, 1, 2], "ran every job in order");
  assert.equal(settled.length, 3, "onItemSettled fired once per job");
  assert.deepEqual(shape(settled), shape(items));
});

test("preserves the caller's original (sparse) indices", async () => {
  // Compose-skipped items leave gaps: only indices 2 and 5 were buildable.
  const runner = fakeRunner({});
  const items = await runBatchOnRunner(runner, built([2, 5]));
  assert.deepEqual(shape(items), [[2, "ok"], [5, "ok"]]);
  assert.deepEqual(runner.calls, [2, 5]);
});

test("skip-and-continue: a throwing job is recorded failed, the batch continues", async () => {
  const runner = fakeRunner({ 1: { kind: "throw", message: "impressora sem papel" } });
  const items = await runBatchOnRunner(runner, built([0, 1, 2]));

  assert.deepEqual(shape(items), [[0, "ok"], [1, "fail"], [2, "ok"]]);
  assert.equal(items[1].error, "impressora sem papel", "surfaces the job's own error");
  assert.deepEqual(runner.calls, [0, 1, 2], "kept going past the failure");
});

test("abort pre-check: signal already aborted → nothing runs, all cancelled", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const runner = fakeRunner({});
  const items = await runBatchOnRunner(runner, built([0, 1, 2]), { signal: ctrl.signal });

  assert.deepEqual(shape(items), [[0, "cancel"], [1, "cancel"], [2, "cancel"]]);
  assert.deepEqual(runner.calls, [], "never touched the runner");
});

test("abort mid-loop: signal trips between jobs → remainder cancelled", async () => {
  const ctrl = new AbortController();
  // Job 0 aborts the controller while running, then resolves ok. The loop's
  // pre-job signal check then cancels 1 and 2 before running them.
  const runner = fakeRunner({ 0: { kind: "abortThen", ctrl } });
  const items = await runBatchOnRunner(runner, built([0, 1, 2]), { signal: ctrl.signal });

  assert.deepEqual(shape(items), [[0, "ok"], [1, "cancel"], [2, "cancel"]]);
  assert.deepEqual(runner.calls, [0], "stopped before the next job");
});

test("abort in-flight: runPrintJob throws code 'aborted' → that job + rest cancelled, loop stops", async () => {
  const runner = fakeRunner({ 1: { kind: "aborted" } });
  const items = await runBatchOnRunner(runner, built([0, 1, 2]));

  assert.deepEqual(shape(items), [[0, "ok"], [1, "cancel"], [2, "cancel"]]);
  assert.deepEqual(runner.calls, [0, 1], "did not attempt job 2 after the abort");
});

test("onItemEvent is forwarded tagged with the item index", async () => {
  const event = { phase: "transfer", packet: 1, total: 4 } as PrintEvent;
  const runner = fakeRunner({ 1: { kind: "emit", event } });
  const seen: [number, PrintEvent][] = [];
  await runBatchOnRunner(runner, built([0, 1]), {
    onItemEvent: (index, e) => seen.push([index, e]),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 1, "event tagged with the running job's index");
  assert.deepEqual(seen[0][1], event);
});

test("empty batch → empty results, runner untouched", async () => {
  const runner = fakeRunner({});
  const items = await runBatchOnRunner(runner, built([]));
  assert.deepEqual(items, []);
  assert.deepEqual(runner.calls, []);
});
