/**
 * Pure, dependency-free response-frame reassembler for the SUPVAN wire protocol.
 *
 * The printer replies with variable-length `0x7E 0x5A`-led frames. How those bytes
 * reach us depends on the transport:
 *   - RFCOMM / SPP: a continuous byte stream — a single OS read can hand back part
 *     of a frame, one whole frame, or several frames concatenated.
 *   - BLE GATT notifications: usually one whole frame per notification, but a long
 *     frame (e.g. a RETURN_MAT material block) can span two notifications, and the
 *     stack may in principle split any notification.
 *
 * Re-framing is therefore the transport's responsibility (see SppPipe), and it is
 * the ONE part of that job that is pure logic — so it lives here in the core, unit-
 * tested against byte vectors, rather than buried in the platform (navigator.
 * bluetooth) file where it could not be exercised under `node --test`.
 *
 * Framing strategy — DELIMITER, not length-prefix. The reference response frames
 * (see test/supvan/pipeline.test.ts `ack`/`statusFrame`, and status.ts's absolute
 * offsets) do NOT carry a trustworthy payload length in bytes [2..3]: ack and
 * status frames leave that field zero. The only reliable boundary is the
 * `0x7E 0x5A` start delimiter. So a frame runs from one delimiter up to (but not
 * including) the next; the final frame — which has no trailing delimiter — is
 * released by flush(), which the transport calls once the read window has settled.
 *
 * TODO(bring-up, 13:00 hardware): confirm from a real E11 capture whether responses
 * populate a length field we could switch to (that would be more robust than
 * delimiter framing IF a response payload can legitimately contain 0x7E 0x5A).
 * Until then, delimiter framing + settle-flush is the honest choice. A mis-split
 * frame simply fails the consumer's magic/echo check (validateResponse / parseStatus)
 * and is treated as a transient null status, which the poll loops already tolerate.
 */
import { MAGIC1, MAGIC2 } from "../constants.ts";

/**
 * Hard cap on the in-progress buffer. A transport that only ever feeds garbage
 * (never a delimiter) must not grow memory without bound; past this size we keep
 * only the most recent window so a later real frame-start is still recoverable.
 * Sized well above the largest expected response (RETURN_MAT ≈ 512 B).
 */
export const MAX_FRAME_BYTES = 8192;

export interface FrameReassembler {
  /** Feed raw bytes; returns every COMPLETE (delimiter-bounded) frame unlocked. */
  push(chunk: Uint8Array): Uint8Array[];
  /**
   * Release the trailing in-progress frame — one that starts with the magic but
   * has no following delimiter yet. Returns null if no whole-looking frame is
   * pending. The transport calls this after the link goes idle (settle window).
   */
  flush(): Uint8Array | null;
  /** Discard all buffered bytes (call before issuing a fresh command). */
  reset(): void;
  /** Bytes currently held (diagnostics / tests). */
  readonly buffered: number;
}

export function createFrameReassembler(): FrameReassembler {
  let buf = new Uint8Array(0);

  /** First index >= `from` where a confirmed `0x7E 0x5A` delimiter begins, or -1. */
  const nextMagic = (b: Uint8Array, from: number): number => {
    for (let i = from; i + 1 < b.length; i++) {
      if (b[i] === MAGIC1 && b[i + 1] === MAGIC2) return i;
    }
    return -1;
  };

  /**
   * Drop leading bytes until the buffer begins at a frame start. After this the
   * buffer is one of: empty, exactly `[0x7E]` (a possible split delimiter awaiting
   * its second byte), or starting with `0x7E 0x5A`.
   */
  const resync = (): void => {
    if (buf.length === 0) return;
    // Already positioned at a (possibly still-forming) frame start.
    if (buf[0] === MAGIC1 && (buf.length === 1 || buf[1] === MAGIC2)) return;
    const i = nextMagic(buf, 0);
    if (i >= 0) {
      buf = buf.slice(i);
      return;
    }
    // No confirmed delimiter anywhere. Preserve only a trailing lone 0x7E, which
    // could be the first half of a delimiter split across chunks; drop the rest.
    buf = buf[buf.length - 1] === MAGIC1 ? buf.slice(buf.length - 1) : new Uint8Array(0);
  };

  return {
    push(chunk: Uint8Array): Uint8Array[] {
      if (chunk.length === 0) return [];

      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf, 0);
      merged.set(chunk, buf.length);
      buf = merged;

      // Runaway guard: an undelimited stream keeps only the most recent window.
      if (buf.length > MAX_FRAME_BYTES) buf = buf.slice(buf.length - MAX_FRAME_BYTES);

      const frames: Uint8Array[] = [];
      for (;;) {
        resync();
        // Need at least the delimiter itself before we can look for the next one.
        if (buf.length < 2 || buf[0] !== MAGIC1 || buf[1] !== MAGIC2) break;
        const j = nextMagic(buf, 2);
        if (j < 0) break; // current frame not yet delimited by a following frame
        frames.push(buf.slice(0, j));
        buf = buf.slice(j);
      }
      return frames;
    },

    flush(): Uint8Array | null {
      resync();
      if (buf.length >= 2 && buf[0] === MAGIC1 && buf[1] === MAGIC2) {
        const frame = buf.slice();
        buf = new Uint8Array(0);
        return frame;
      }
      return null;
    },

    reset(): void {
      buf = new Uint8Array(0);
    },

    get buffered(): number {
      return buf.length;
    },
  };
}
