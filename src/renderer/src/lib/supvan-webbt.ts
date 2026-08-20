/**
 * Web Bluetooth transport for the SUPVAN E11 — the SINGLE file in the codebase
 * that touches `navigator.bluetooth`. Everything else in the SUPVAN stack is pure,
 * dependency-free, node-testable core (src/main/supvan) or a config table; this is
 * the thin, deliberately-isolated platform slice that adapts a GATT link to the
 * core's SppPipe contract.
 *
 * WHY the renderer, not main: `navigator.bluetooth` is a renderer-only API in
 * Electron/Chromium — the main process cannot open GATT. Electron has no built-in
 * device chooser, so requestDevice()'s picker is delegated to main via the
 * `select-bluetooth-device` handler (see src/main/ble/picker.ts) and this side
 * only opens/uses the GATT connection.
 *
 * HARD CONSTRAINTS baked in below (all from the Web Bluetooth / Electron model):
 *   - requestDevice() MUST run synchronously inside a user gesture — callers (see
 *     lib/printing.ts `printLabelViaBle`) must not await anything before invoking
 *     connectWebBtPrinter(); this function calls requestDevice() before its own
 *     first await for the same reason.
 *   - GATT operations must be SERIALIZED — a second concurrent op throws "GATT
 *     operation already in progress". All writes go through one promise queue.
 *   - MTU is neither settable nor readable from Web Bluetooth; large writes must be
 *     sub-chunked (a single write > 512 B throws InvalidModificationError). We chunk
 *     by TransportConfig.chunkBytes.
 *   - A disconnect invalidates every service/characteristic handle — a reconnect
 *     must re-fetch them (reconnectWithBackoff does).
 *
 * TODO(bring-up, 13:00 hardware): confirm the real service/char UUIDs, the workable
 * chunk size, the command→ack notification timing, and whether a pairing PIN is
 * required. All of those are config (transport/config.ts), not code, so bring-up is
 * data edits + this file's probe order — no structural change expected.
 */
import type { SppPipe } from "../../../main/supvan/transport/pipe.ts";
import {
  CANDIDATE_TRANSPORT_CONFIGS,
  candidateServiceUuids,
  type TransportConfig,
  type WriteMode,
} from "../../../main/supvan/transport/config.ts";
import { createFrameReassembler } from "../../../main/supvan/transport/reassembler.ts";

// --- Minimal Web Bluetooth surface -----------------------------------------
// Declared locally so the codebase carries no @types/web-bluetooth dependency
// (these types are NOT in the standard lib.dom.d.ts). Only the members we use.

type BtUuid = number | string;

interface BluetoothLE {
  requestDevice(options: {
    filters?: Array<{ namePrefix?: string; services?: BtUuid[] }>;
    optionalServices?: BtUuid[];
    acceptAllDevices?: boolean;
  }): Promise<BluetoothDeviceLike>;
}

interface BluetoothDeviceLike {
  readonly id?: string;
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServerLike;
  addEventListener(type: "gattserverdisconnected", cb: () => void): void;
  removeEventListener(type: "gattserverdisconnected", cb: () => void): void;
}

interface BluetoothRemoteGATTServerLike {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServerLike>;
  disconnect(): void;
  getPrimaryService(uuid: BtUuid): Promise<BluetoothRemoteGATTServiceLike>;
}

interface BluetoothRemoteGATTServiceLike {
  getCharacteristic(uuid: BtUuid): Promise<BluetoothRemoteGATTCharacteristicLike>;
}

interface BluetoothRemoteGATTCharacteristicLike {
  readonly value?: DataView;
  writeValueWithResponse(value: BufferSource): Promise<void>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike>;
  addEventListener(type: "characteristicvaluechanged", cb: (e: Event) => void): void;
  removeEventListener(type: "characteristicvaluechanged", cb: (e: Event) => void): void;
}

function getBluetooth(): BluetoothLE {
  const bt = (navigator as unknown as { bluetooth?: BluetoothLE }).bluetooth;
  if (!bt) throw new Error("Web Bluetooth indisponível neste ambiente.");
  return bt;
}

// --- Frame-length → write-mode mapping -------------------------------------
// Command frames are 16 bytes (see constants CMD_* framing); data frames are 512.
// A 16-byte frame → command write mode; anything else → data write mode. This
// keeps the pipe transport-agnostic: it inspects only the frame length the core
// already produces, never the opcode.
const COMMAND_FRAME_LEN = 16;

// ---------------------------------------------------------------------------

/** A live connection: the pipe the core drives, plus lifecycle handles. */
export interface WebBtConnection {
  pipe: SppPipe;
  device: BluetoothDeviceLike;
  /** The candidate config that matched this device. */
  config: TransportConfig;
  /** Tear down notifications + drop the GATT link. Idempotent, never throws. */
  disconnect(): Promise<void>;
}

/**
 * Prompt for a SUPVAN printer and open its pipe.
 *
 * MUST be called synchronously from a user gesture — requestDevice() is the first
 * thing this does, before any await, so the gesture is still "active". The real
 * device chooser is handled in the main process (src/main/ble/picker.ts).
 */
export async function connectWebBtPrinter(
  candidates: readonly TransportConfig[] = CANDIDATE_TRANSPORT_CONFIGS,
): Promise<WebBtConnection> {
  const bt = getBluetooth();
  // No await before this line — keep it inside the user gesture.
  //
  // acceptAllDevices, NOT namePrefix filters: a BLE name often resolves LATE (after
  // the first scan emissions), and a namePrefix filter would EXCLUDE the printer
  // from the scan while its name is still blank — it then never reaches main's
  // auto-pick (picker.ts) nor the manual chooser, and requestDevice() rejects with
  // NotFoundError ("User cancelled the requestDevice() chooser."). Accepting all
  // devices guarantees the E11 is offered; main still auto-picks it BY NAME once
  // resolved, and the chooser sorts SUPVAN-likely devices first. optionalServices is
  // REQUIRED to later getPrimaryService() these UUIDs (acceptAllDevices forbids none).
  const device = await bt.requestDevice({
    acceptAllDevices: true,
    optionalServices: candidateServiceUuids(candidates),
  });

  const gatt = device.gatt;
  if (!gatt) throw new Error("Dispositivo Bluetooth selecionado não expõe GATT.");
  return openConnection(device, gatt, candidates);
}

/**
 * Connect a GATT server handle and bind the pipe, GUARANTEEING the link is dropped
 * if binding fails. Without this, gatt.connect() opens the radio link and a later
 * bindPipe throw (the normal outcome while candidate UUIDs are unverified, or any
 * transient discovery error) would leave the connection open with no handle to
 * close it — a resource leak reclaimed only by GC. Shared by connectWebBtPrinter
 * and reconnectWithBackoff so both failure paths clean up identically.
 */
async function openConnection(
  device: BluetoothDeviceLike,
  gatt: BluetoothRemoteGATTServerLike,
  candidates: readonly TransportConfig[],
): Promise<WebBtConnection> {
  const server = await gatt.connect();
  let bound: { pipe: SppPipe; teardown: () => Promise<void>; config: TransportConfig };
  try {
    bound = await bindPipe(server, candidates);
  } catch (e) {
    try {
      gatt.disconnect();
    } catch {
      /* already down */
    }
    throw e;
  }
  let closed = false;
  const disconnect = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await bound.teardown().catch(() => {});
    try {
      gatt.disconnect();
    } catch {
      /* already down */
    }
  };
  return { pipe: bound.pipe, device, config: bound.config, disconnect };
}

/**
 * Reconnect to a device we already hold a handle to (e.g. after a
 * `gattserverdisconnected`), with capped exponential backoff. Returns a FRESH
 * pipe/config bound to freshly re-fetched characteristics — the old handles are
 * invalid after a disconnect.
 *
 * NOTE: this only re-establishes the transport. Resuming a print job that was
 * mid-transfer is a separate concern (the E11 buffer state after a drop is a
 * hardware question) — TODO(bring-up): decide whether to restart the job or abort.
 */
export async function reconnectWithBackoff(
  device: BluetoothDeviceLike,
  candidates: readonly TransportConfig[] = CANDIDATE_TRANSPORT_CONFIGS,
  opts: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<WebBtConnection> {
  const attempts = opts.attempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 4000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
    try {
      const gatt = device.gatt;
      if (!gatt) throw new Error("Dispositivo sem GATT ao reconectar.");
      return await openConnection(device, gatt, candidates);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Reconexão Bluetooth falhou após ${attempts} tentativas: ${(lastErr as Error)?.message ?? lastErr}`);
}

/**
 * Probe candidate services on a connected server; the first that yields a
 * notify + write characteristic pair wins. Subscribes to notifications and returns
 * the SppPipe plus a teardown. Mirrors the reference's chars_for_service auto-detect.
 */
async function bindPipe(
  server: BluetoothRemoteGATTServerLike,
  candidates: readonly TransportConfig[],
): Promise<{ pipe: SppPipe; teardown: () => Promise<void>; config: TransportConfig }> {
  const errors: string[] = [];
  for (const cfg of candidates) {
    try {
      const service = await server.getPrimaryService(cfg.serviceUuid);
      const notifyChar = await service.getCharacteristic(cfg.notifyCharUuid);
      const writeChar =
        cfg.writeCharUuid === cfg.notifyCharUuid ? notifyChar : await service.getCharacteristic(cfg.writeCharUuid);
      const { pipe, teardown } = createWebBtPipe(writeChar, notifyChar, cfg);
      // createWebBtPipe has already attached the notification listener. If enabling
      // notifications fails (e.g. a resolved-but-non-notify characteristic while
      // probing unverified candidates), tear down so we don't leak that listener on
      // the discarded pipe before trying the next candidate.
      try {
        await notifyChar.startNotifications();
      } catch (e) {
        await teardown().catch(() => {});
        throw e;
      }
      return { pipe, teardown, config: cfg };
    } catch (e) {
      errors.push(`${cfg.label}: ${(e as Error).message}`);
    }
  }
  throw new Error(
    `Nenhum serviço GATT compatível encontrado (${errors.join("; ")}). ` +
      `TODO(bring-up): capturar os UUIDs reais do E11 e fixá-los em transport/config.ts.`,
  );
}

/**
 * Adapt a GATT write+notify characteristic pair to the core's SppPipe.
 *
 * - write(): chunked by cfg.chunkBytes; command frames (16 B) use cfg.commandWrite,
 *   everything else (512 B data frames) uses cfg.dataWrite. All writes serialize
 *   through one promise queue (concurrent GATT ops are illegal).
 * - read(): resolves with the next reassembled response frame, or null on timeout.
 *   Notifications feed a delimiter-based reassembler; a trailing single-notification
 *   frame is released after cfg.settleMs of quiet (there is no trailing delimiter to
 *   close it — see reassembler.ts).
 * - drain(): clears any buffered/partial input before a fresh command.
 * - close(): tears down notifications + listeners.
 *
 * Exported for unit-style wiring/tests; production code goes through connectWebBtPrinter.
 */
export function createWebBtPipe(
  writeChar: BluetoothRemoteGATTCharacteristicLike,
  notifyChar: BluetoothRemoteGATTCharacteristicLike,
  cfg: TransportConfig,
): { pipe: SppPipe; teardown: () => Promise<void> } {
  const reasm = createFrameReassembler();
  const inbox: Uint8Array[] = [];
  let waiter: { resolve: (f: Uint8Array | null) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const deliver = (frame: Uint8Array): void => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      clearTimeout(w.timer);
      w.resolve(frame);
    } else {
      inbox.push(frame);
    }
  };

  const onValue = (e: Event): void => {
    const dv = (e.target as unknown as { value?: DataView }).value;
    if (!dv) return;
    const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
    for (const frame of reasm.push(bytes)) deliver(frame);
    // Release a trailing single-notification frame once the link goes quiet.
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      const frame = reasm.flush();
      if (frame) deliver(frame);
    }, cfg.settleMs);
  };
  notifyChar.addEventListener("characteristicvaluechanged", onValue);

  // Single GATT-op queue. A second concurrent characteristic op throws
  // "GATT operation already in progress", so every write chains off the previous.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const run = chain.then(op, op);
    // Keep the chain alive even if this op rejects; the rejection still surfaces
    // to the caller via the returned promise.
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const writeChunked = async (data: Uint8Array, mode: WriteMode): Promise<void> => {
    for (let off = 0; off < data.length; off += cfg.chunkBytes) {
      const end = Math.min(off + cfg.chunkBytes, data.length);
      // .slice() detaches a standalone ArrayBuffer — some stacks reject a view
      // that shares a larger buffer.
      const buf = data.slice(off, end);
      if (mode === "with-response") await writeChar.writeValueWithResponse(buf);
      else await writeChar.writeValueWithoutResponse(buf);
    }
  };

  const teardown = async (): Promise<void> => {
    notifyChar.removeEventListener("characteristicvaluechanged", onValue);
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    if (waiter) {
      const w = waiter;
      waiter = null;
      clearTimeout(w.timer);
      w.resolve(null);
    }
    try {
      await notifyChar.stopNotifications();
    } catch {
      /* characteristic already gone on disconnect */
    }
  };

  const pipe: SppPipe = {
    write: (data: Uint8Array): Promise<void> =>
      enqueue(() => writeChunked(data, data.length === COMMAND_FRAME_LEN ? cfg.commandWrite : cfg.dataWrite)),

    read: (timeoutMs: number): Promise<Uint8Array | null> => {
      const queued = inbox.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<Uint8Array | null>((resolve) => {
        const timer = setTimeout(() => {
          if (waiter?.timer === timer) waiter = null;
          resolve(null);
        }, timeoutMs);
        waiter = { resolve, timer };
      });
    },

    drain: async (): Promise<void> => {
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      reasm.reset();
      inbox.length = 0;
    },

    close: async (): Promise<void> => {
      await teardown();
    },
  };

  return { pipe, teardown };
}
