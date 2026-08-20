/**
 * Transport-agnostic print state machine. Drives an `SppPipe` through the
 * vendor print sequence (T50PlusPrint.doPrint → test_print.py::do_test_print,
 * NORMAL mode). No hardware, no framing assumptions beyond the `SppPipe`
 * contract — unit-testable against a mock pipe.
 */
import {
  CMD_CHECK_DEVICE,
  CMD_INQUIRY_STA,
  CMD_START_PRINT,
  CMD_STOP_PRINT,
  CMD_BUF_FULL,
  CMD_NEXT_ZIPPEDBULK,
  DATA_FRAME_SIZE,
} from "./constants.ts";
import { makeCmd, makeCmdStartTrans } from "./frame.ts";
import { dataPacketCount } from "./data.ts";
import {
  parseStatus,
  hasError,
  errorDescription,
  validateResponse,
  type PrinterStatus,
} from "./status.ts";
import type { SppPipe } from "./transport/pipe.ts";

/** A ready-to-send job: 512-byte data frames + the size/speed for BUF_FULL. */
export interface PrintJob {
  /** 512-byte transfer frames from `buildDataFrames(compressed)`. */
  frames: Uint8Array[];
  /** Length of the compressed stream (BUF_FULL block_size). */
  compressedLen: number;
  /** Print speed from `calcSpeed(avgPerBuffer)` (BUF_FULL block_count). */
  speed: number;
}

/** Tunable timing (all defaults match the Python reference). */
export interface PrintTimings {
  /** Per-command response wait (ms). */
  cmdTimeoutMs: number;
  /** wait-ready poll: attempts × interval (60 × 100 ms). */
  readyAttempts: number;
  readyIntervalMs: number;
  /** wait-printing poll (60 × 100 ms). */
  printingAttempts: number;
  printingIntervalMs: number;
  /** wait-buffer-available poll (200 × 20 ms). */
  bufAttempts: number;
  bufIntervalMs: number;
  /** wait-completion poll (300 × 100 ms). */
  completeAttempts: number;
  completeIntervalMs: number;
  /** Delay after the last data packet, before BUF_FULL (20 ms). */
  postDataDelayMs: number;
}

export const DEFAULT_TIMINGS: PrintTimings = {
  cmdTimeoutMs: 2000,
  readyAttempts: 60,
  readyIntervalMs: 100,
  printingAttempts: 60,
  printingIntervalMs: 100,
  bufAttempts: 200,
  bufIntervalMs: 20,
  completeAttempts: 300,
  completeIntervalMs: 100,
  postDataDelayMs: 20,
};

export interface PrintOptions {
  timings?: Partial<PrintTimings>;
  /** Injectable sleep (defaults to setTimeout); tests pass an instant stub. */
  sleep?: (ms: number) => Promise<void>;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  /** Progress / diagnostics callback. */
  onEvent?: (event: PrintEvent) => void;
}

export type PrintEvent =
  | { phase: "check-device" }
  | { phase: "wait-ready" }
  | { phase: "start-print" }
  | { phase: "wait-printing" }
  | { phase: "wait-buffer" }
  | { phase: "transfer"; packet: number; total: number }
  | { phase: "buf-full" }
  | { phase: "wait-complete" }
  | { phase: "done" }
  | { phase: "status"; status: PrinterStatus };

export type SupvanPrintErrorCode =
  | "check-device"
  | "timeout-ready"
  | "device-error"
  | "start-print"
  | "timeout-printing"
  | "timeout-buffer"
  | "aborted"
  | "no-status";

export class SupvanPrintError extends Error {
  readonly code: SupvanPrintErrorCode;

  constructor(message: string, code: SupvanPrintErrorCode) {
    super(message);
    this.name = "SupvanPrintError";
    this.code = code;
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Errors checked before committing a job (do_test_print step 2). */
const PRE_PRINT_ERROR_KEYS: Array<keyof PrinterStatus> = [
  "labelRwError",
  "labelModeError",
  "labelEnd",
  "coverOpen",
  "headTempHigh",
  "labelNotInstalled",
];

/** Errors checked right before the buffer transfer (do_test_print step 5). */
const PRE_TRANSFER_ERROR_KEYS: Array<keyof PrinterStatus> = [
  "labelRwError",
  "coverOpen",
  "headTempHigh",
  "labelNotInstalled",
];

/**
 * Client wrapper over an `SppPipe` implementing the command/status/transfer
 * helpers and the full NORMAL-mode print flow.
 */
export class SupvanClient {
  private readonly pipe: SppPipe;
  private readonly timings: PrintTimings;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    pipe: SppPipe,
    opts: { timings?: Partial<PrintTimings>; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.pipe = pipe;
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.sleep = opts.sleep ?? realSleep;
  }

  /**
   * Send a command frame and read its response (null on no reply).
   *
   * drain() runs BEFORE the write (matching the reference), clearing any frame
   * buffered up to this point. It cannot clear a frame that arrives DURING the
   * write→read window — see the stale-response note on pollStatus. That window is
   * only exploitable by a reply that lands later than cmdTimeoutMs, i.e. a genuine
   * protocol race the wire format cannot disambiguate; it is not moved/"fixed" here
   * because every alternative ordering risks dropping a fast legitimate reply.
   */
  async sendCmd(cmd: number, param = 0): Promise<Uint8Array | null> {
    if (this.pipe.drain) await this.pipe.drain();
    await this.pipe.write(makeCmd(cmd, param));
    return this.pipe.read(this.timings.cmdTimeoutMs);
  }

  /** Send a start-transfer command frame and read its response. */
  async sendCmdStartTrans(
    cmd: number,
    blockSize: number,
    blockCount: number,
    readResponse = true,
  ): Promise<Uint8Array | null> {
    if (this.pipe.drain) await this.pipe.drain();
    await this.pipe.write(makeCmdStartTrans(cmd, blockSize, blockCount));
    return readResponse ? this.pipe.read(this.timings.cmdTimeoutMs) : null;
  }

  /** Send a 512-byte data frame; optionally wait for the per-packet ack. */
  async sendDataFrame(
    frame: Uint8Array,
    readResponse: boolean,
  ): Promise<Uint8Array | null> {
    if (frame.length !== DATA_FRAME_SIZE) {
      throw new Error(`data frame must be ${DATA_FRAME_SIZE} bytes, got ${frame.length}`);
    }
    await this.pipe.write(frame);
    return readResponse ? this.pipe.read(this.timings.cmdTimeoutMs) : null;
  }

  /** Query INQUIRY_STA and parse it (null if no/invalid response). */
  async queryStatus(): Promise<PrinterStatus | null> {
    const resp = await this.sendCmd(CMD_INQUIRY_STA);
    return resp ? parseStatus(resp) : null;
  }

  /** CHECK_DEVICE liveness probe. */
  async checkDevice(): Promise<boolean> {
    const resp = await this.sendCmd(CMD_CHECK_DEVICE);
    return resp != null && validateResponse(resp, CMD_CHECK_DEVICE);
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new SupvanPrintError("print aborted", "aborted");
  }

  /**
   * Run a full print job. Throws `SupvanPrintError` on any failure; resolves
   * when the printer reports completion (or the completion poll times out,
   * which — matching the reference — is treated as "probably done").
   */
  async runPrintJob(job: PrintJob, opts: PrintOptions = {}): Promise<void> {
    const t: PrintTimings = { ...this.timings, ...opts.timings };
    const sleep = opts.sleep ?? this.sleep;
    const emit = opts.onEvent ?? (() => {});
    const { signal } = opts;

    // Step 1: CHECK_DEVICE
    this.throwIfAborted(signal);
    emit({ phase: "check-device" });
    if (!(await this.checkDevice())) {
      throw new SupvanPrintError("CHECK_DEVICE failed", "check-device");
    }

    // Step 2: wait for device ready (!busy && !printing).
    // Reference `_wait_ready` BAILS immediately on a null/invalid status.
    emit({ phase: "wait-ready" });
    let status = await this.pollStatus(
      t.readyAttempts,
      t.readyIntervalMs,
      (s) => !s.deviceBusy && !s.printing,
      sleep,
      signal,
      { sleepFirst: false, bailOnNull: true },
    );
    if (!status) throw new SupvanPrintError("timeout waiting for device ready", "timeout-ready");
    emit({ phase: "status", status });
    this.assertNoError(status, PRE_PRINT_ERROR_KEYS);

    // Step 3: START_PRINT
    this.throwIfAborted(signal);
    emit({ phase: "start-print" });
    const startResp = await this.sendCmd(CMD_START_PRINT);
    if (!startResp) throw new SupvanPrintError("START_PRINT failed", "start-print");

    // Step 4: wait for the printing station to activate.
    // Reference `_wait_printing` / Rust `wait_printing` TOLERATE a transient
    // null status (common over flaky RFCOMM/BLE) — they skip the miss and keep
    // polling rather than aborting the whole print.
    emit({ phase: "wait-printing" });
    status = await this.pollStatus(
      t.printingAttempts,
      t.printingIntervalMs,
      (s) => s.printing,
      sleep,
      signal,
      { sleepFirst: false, bailOnNull: false },
    );
    if (!status) {
      throw new SupvanPrintError("timeout waiting for printing station", "timeout-printing");
    }

    // Step 5: wait for buffer space (!buf_full), then transfer.
    // Reference polls with the sleep FIRST, then queries.
    emit({ phase: "wait-buffer" });
    status = await this.pollStatus(
      t.bufAttempts,
      t.bufIntervalMs,
      (s) => !s.bufFull,
      sleep,
      signal,
      { sleepFirst: true, bailOnNull: false },
    );
    if (!status) throw new SupvanPrintError("timeout waiting for buffer space", "timeout-buffer");

    // Errors here are recoverable via STOP_PRINT before aborting.
    const transferErr = PRE_TRANSFER_ERROR_KEYS.find((k) => status![k] === true);
    if (transferErr) {
      await this.sendCmd(CMD_STOP_PRINT).catch(() => {});
      throw new SupvanPrintError(`device error before transfer: ${transferErr}`, "device-error");
    }

    await this.transferJob(job, emit, signal);

    // Step 6: wait for completion (!printing && !busy).
    emit({ phase: "wait-complete" });
    await this.pollStatus(
      t.completeAttempts,
      t.completeIntervalMs,
      (s) => !s.printing && !s.deviceBusy,
      sleep,
      signal,
      { sleepFirst: true, bailOnNull: false },
    );
    // A completion timeout is non-fatal (matches the reference): the job has
    // almost certainly finished; the poll just never observed the idle edge.
    emit({ phase: "done" });
  }

  /** NEXT_ZIPPEDBULK start → data frames (ack only on last) → BUF_FULL. */
  private async transferJob(
    job: PrintJob,
    emit: (e: PrintEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const numPackets = dataPacketCount(job.compressedLen);
    // frames were built from the same compressed stream, so this should hold.
    const total = job.frames.length;

    this.throwIfAborted(signal);
    await this.sendCmdStartTrans(CMD_NEXT_ZIPPEDBULK, DATA_FRAME_SIZE, numPackets);

    for (let i = 0; i < total; i++) {
      this.throwIfAborted(signal);
      const isLast = i === total - 1;
      emit({ phase: "transfer", packet: i + 1, total });
      await this.sendDataFrame(job.frames[i], isLast);
    }

    await this.sleep(this.timings.postDataDelayMs);

    this.throwIfAborted(signal);
    emit({ phase: "buf-full" });
    await this.sendCmdStartTrans(CMD_BUF_FULL, job.compressedLen, job.speed);
  }

  /**
   * Poll INQUIRY_STA until `predicate` holds. Returns the matching status, or
   * null on timeout / lost status.
   *
   * The two behaviours are independent axes, matching the reference loops:
   *  - `sleepFirst`: sleep BEFORE the first query (buffer/completion loops) vs.
   *    query first then sleep between attempts (ready/printing loops).
   *  - `bailOnNull`: `_wait_ready` returns None on the first null/invalid status;
   *    `_wait_printing`, wait-buffer and wait-complete tolerate a transient miss
   *    and keep polling. These must NOT be conflated — `_wait_printing` also
   *    queries-first (sleepFirst=false) yet does NOT bail on null.
   *
   * KNOWN RACE (stale status; confirmed medium, protocol-inherent). The wire
   * format has NO request/response correlation, so a reply cannot be matched to
   * the query that provoked it. In a bailOnNull=false loop a query can time out
   * (queryStatus → null) and be re-issued; if the FIRST query's reply then arrives
   * later than cmdTimeoutMs (after read() already resolved null), that late frame
   * lands in the pipe's inbox and the NEXT read() consumes it as the current
   * query's answer — one stale PrinterStatus. Impact is bounded: bailOnNull loops
   * are self-correcting (a later poll observes the true edge), wait-ready is immune
   * (bailOnNull=true never re-issues after a null), and wait-complete is non-fatal.
   * No pipe-layer fix is fully correct without correlation: drain-after-write or
   * dropping unwaited frames would, in the fast-reply case, discard a LEGITIMATE
   * response — so the tested ordering is kept deliberately.
   * TODO(bring-up, 13:00 hardware): MEASURE the real INQUIRY_STA command→reply
   * latency. If worst-case ≪ cmdTimeoutMs (2000 ms) — the expected case — the race
   * is unreachable in practice and needs nothing further. Only if the device can
   * legitimately reply >2 s late should we add request/response correlation (e.g.
   * an app-level tag) rather than a timing heuristic.
   */
  private async pollStatus(
    attempts: number,
    intervalMs: number,
    predicate: (s: PrinterStatus) => boolean,
    sleep: (ms: number) => Promise<void>,
    signal: AbortSignal | undefined,
    opts: { sleepFirst: boolean; bailOnNull: boolean },
  ): Promise<PrinterStatus | null> {
    const { sleepFirst, bailOnNull } = opts;
    for (let i = 0; i < attempts; i++) {
      this.throwIfAborted(signal);
      if (sleepFirst) await sleep(intervalMs);
      const status = await this.queryStatus();
      if (status) {
        if (predicate(status)) return status;
      } else if (bailOnNull) {
        return null;
      }
      if (!sleepFirst) await sleep(intervalMs);
    }
    return null;
  }

  private assertNoError(status: PrinterStatus, keys: Array<keyof PrinterStatus>): void {
    const bad = keys.find((k) => status[k] === true);
    if (bad) {
      throw new SupvanPrintError(
        errorDescription(status) ?? `device error: ${bad}`,
        "device-error",
      );
    }
  }
}

export { hasError, errorDescription };
