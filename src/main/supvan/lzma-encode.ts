/**
 * Pure-TypeScript LZMA1 "alone" encoder for the SUPVAN print pipeline.
 *
 * This is the concrete backend for the `LzmaAloneEncoder` seam that `compress.ts`
 * deliberately leaves injected (so the core stays dependency-free and the backend
 * choice — native vs WASM vs pure-JS — can be made per platform). It runs in the
 * renderer (the Web Bluetooth print path is renderer-side), in `node --test`, and
 * in the main process, because it touches nothing but typed arrays.
 *
 * WHY LITERALS-ONLY. A valid LZMA1 stream may encode every byte as a literal (no
 * match/length/distance ops at all). Such a stream:
 *   - is decoded correctly by any compliant LZMA1 decoder (the firmware uses the
 *     tukaani `org.tukaani.xz` family — see the plan's source map), and
 *   - is INDEPENDENT of the dictionary size, since it never emits a back-reference,
 *     so the vendor's 8 KiB-dict decoder accepts it regardless of input length.
 * We still emit the vendor header (props 0x5D = lc3/lp0/pb2, dict 8192) so
 * `compressAlone`'s prefix check passes and the firmware reads the parameters it
 * expects. The adaptive literal + isMatch bit models mean repetitive 1-bit raster
 * (long runs of 0x00 / 0xFF) still compresses well below 1 byte/byte — adequate
 * for the small labels this feature prints, and well under the 255-packet
 * (~127 KB) transfer cap.
 *
 * Correctness is validated OFFLINE by round-tripping every output through Python's
 * canonical `lzma.decompress(..., FORMAT_ALONE)` (see test/supvan/lzma-encode.test.ts),
 * which reads the parameters straight from our header. That proves the stream is a
 * well-formed LZMA1-alone stream; the remaining hardware question (does the E11's
 * specific firmware accept it — plan risk R5) stays a Phase-5 bring-up item.
 *
 * A match-finding upgrade (hash-chain greedy, bounded to the 8 KiB window) is a
 * later size optimization — it would change only this file, never the seam.
 *
 * Reference: LZMA SDK range coder (`LzmaEnc.c`) — the literal + isMatch path only.
 */
import {
  LZMA_ALONE_PROPS_BYTE,
  LZMA_DICT_SIZE,
  LZMA_ALONE_HEADER_LEN,
} from "./compress.ts";

// --- LZMA probability-model constants (from the SDK) ------------------------
const K_NUM_BIT_MODEL_TOTAL_BITS = 11;
const K_BIT_MODEL_TOTAL = 1 << K_NUM_BIT_MODEL_TOTAL_BITS; // 2048
const PROB_INIT = K_BIT_MODEL_TOTAL >>> 1; // 1024
const K_NUM_MOVE_BITS = 5;
const K_TOP_VALUE = 1 << 24;

// Vendor parameters (must match the props byte above): lc=3, lp=0, pb=2.
const LC = 3;
const PB = 2;
const POS_MASK = (1 << PB) - 1; // 3

// Model sizes.
const NUM_STATES = 12;
const IS_MATCH_SIZE = NUM_STATES << 4; // 12 states × 16 posStates (pb up to 4)
const LIT_SIZE = 0x300 << LC; // lp=0 → 0x300 << 3 = 0x1800

// End-marker coder sizes (used exactly once, so their probs stay at init).
const K_NUM_POS_SLOT_BITS = 6;
const K_NUM_ALIGN_BITS = 4;

/**
 * LZMA range encoder. `low` is kept as a JS number (it reaches ~40 bits during a
 * carry, well within 2^53), so all shifts that could exceed 32 bits use
 * multiply/divide/modulo — NEVER the `<<`/`>>>` operators, which are 32-bit in JS
 * and would silently corrupt the stream.
 */
class RangeEncoder {
  private low = 0; // up to ~2^40 during carry propagation
  private range = 0xffffffff; // u32
  private cache = 0; // u8
  private cacheSize = 1; // u64 (small in practice)
  private readonly out: number[] = [];

  /** Encode one adaptive bit against `probs[i]`, updating the model. */
  encodeBit(probs: Uint16Array, i: number, bit: number): void {
    const prob = probs[i];
    // range is u32; use >>> for the 11-bit shift (safe, < 2^32), and Math.imul-free
    // multiply via a float (bound < 2^32, exact in a double).
    const bound = (this.range >>> K_NUM_BIT_MODEL_TOTAL_BITS) * prob;
    if (bit === 0) {
      this.range = bound;
      probs[i] = prob + ((K_BIT_MODEL_TOTAL - prob) >>> K_NUM_MOVE_BITS);
    } else {
      // low += bound (may push low above 2^32 — handled as a float, then carried
      // out in shiftLow). range -= bound stays u32.
      this.low += bound;
      this.range = this.range - bound;
      probs[i] = prob - (prob >>> K_NUM_MOVE_BITS);
    }
    this.renorm();
  }

  /** Encode `numBits` fixed-probability (0.5) bits of `value`, MSB first. */
  encodeDirectBits(value: number, numBits: number): void {
    for (let i = numBits - 1; i >= 0; i--) {
      this.range = this.range >>> 1;
      if ((value >>> i) & 1) this.low += this.range;
      this.renorm();
    }
  }

  private renorm(): void {
    // Renormalize while range < 2^24. Compare as unsigned (range is always ≥ 0 here).
    while ((this.range >>> 0) < K_TOP_VALUE) {
      this.range = (this.range << 8) >>> 0;
      this.shiftLow();
    }
  }

  /** Carry-aware byte emit — the delicate part of the range coder. */
  private shiftLow(): void {
    const lowHi = Math.floor(this.low / 0x100000000); // low >>> 32 (the carry bit)
    const low32 = this.low % 0x100000000; // low & 0xFFFFFFFF
    // Emit the cached byte(s) when the top byte is settled (not 0xFF) or a carry
    // occurred. 0xFF bytes are deferred (cached) until we know the carry.
    if (low32 < 0xff000000 || lowHi === 1) {
      let temp = this.cache;
      do {
        this.out.push((temp + lowHi) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = (low32 >>> 24) & 0xff;
    }
    this.cacheSize++;
    // low = (low32 << 8) & 0xFFFFFFFF, via multiply to avoid 32-bit shift overflow.
    this.low = (low32 & 0x00ffffff) * 256;
  }

  /** Flush the 5 pending bytes that close an LZMA range-coded stream. */
  flush(): void {
    for (let i = 0; i < 5; i++) this.shiftLow();
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

/** LZMA literal state transition for a literal op (no-match branch). */
function nextLiteralState(state: number): number {
  if (state < 4) return 0;
  if (state < 10) return state - 3;
  return state - 6;
}

/** MSB-first bit-tree encode (RcTree_Encode): probs sized `1 << numBits`. */
function encodeTree(rc: RangeEncoder, probs: Uint16Array, numBits: number, symbol: number): void {
  let m = 1;
  for (let i = numBits - 1; i >= 0; i--) {
    const bit = (symbol >>> i) & 1;
    rc.encodeBit(probs, m, bit);
    m = (m << 1) | bit;
  }
}

/** LSB-first bit-tree encode (RcTree_ReverseEncode) — used by the align coder. */
function encodeTreeReverse(rc: RangeEncoder, probs: Uint16Array, numBits: number, symbol: number): void {
  let m = 1;
  let s = symbol;
  for (let i = 0; i < numBits; i++) {
    const bit = s & 1;
    s >>>= 1;
    rc.encodeBit(probs, m, bit);
    m = (m << 1) | bit;
  }
}

/**
 * Emit the LZMA end-of-stream marker: a "simple match" with distance 0xFFFFFFFF
 * and the minimum length. Byte-exact with the SDK's WriteEndMarker. All the
 * sub-coders here (isRep, len, posSlot, align) are used ONLY for this single
 * marker, so they stay at the init probability and need no persistent state —
 * the decoder starts them at the same init, so the encode/decode stay in lockstep.
 */
function writeEndMarker(
  rc: RangeEncoder,
  isMatch: Uint16Array,
  state: number,
  posState: number,
): void {
  // Fresh init-probability sub-coders (each touched once).
  const isRep = new Uint16Array(NUM_STATES).fill(PROB_INIT);
  const lenChoice = new Uint16Array(1).fill(PROB_INIT);
  const lenLow = new Uint16Array(1 << 3).fill(PROB_INIT); // low tree for this posState
  const posSlot = new Uint16Array(1 << K_NUM_POS_SLOT_BITS).fill(PROB_INIT);
  const align = new Uint16Array(1 << K_NUM_ALIGN_BITS).fill(PROB_INIT);

  // isMatch = 1 (a match), isRep = 0 (a simple, non-repeated match).
  rc.encodeBit(isMatch, (state << 4) + posState, 1);
  rc.encodeBit(isRep, state, 0);

  // Length: symbol 0 (= kMatchMinLen). choice bit 0 → low coder, then 3-bit tree = 0.
  rc.encodeBit(lenChoice, 0, 0);
  encodeTree(rc, lenLow, 3, 0);

  // Distance for len-state 0: posSlot 63 (the maximum), then the high footer bits
  // as direct bits and the low 4 bits through the align reverse-tree.
  encodeTree(rc, posSlot, K_NUM_POS_SLOT_BITS, (1 << K_NUM_POS_SLOT_BITS) - 1);
  const footerBits = 30; // (63 >> 1) - 1
  const directCount = footerBits - K_NUM_ALIGN_BITS; // 26
  // (0xFFFFFFFF >> 4) & ((1<<26)-1) = 26 one-bits.
  rc.encodeDirectBits((1 << directCount) - 1, directCount);
  encodeTreeReverse(rc, align, K_NUM_ALIGN_BITS, (1 << K_NUM_ALIGN_BITS) - 1); // low nibble = 15
}

/**
 * Encode `data` to a valid LZMA1 alone-format stream with the vendor parameters
 * (props 0x5D, dict 8192). Literals-only — see the file header.
 *
 * Shape: `[0x5D][dictSize u32 LE][uncompressedSize u64 LE][range-coded payload]`.
 * We write the "unknown size" sentinel (0xFF×8) in the header and terminate the
 * payload with a real LZMA1 end-of-stream marker — exactly the shape a canonical
 * alone encoder (e.g. liblzma FORMAT_ALONE) produces. `compressAlone` then patches
 * the size field to the definite value for the firmware (`patchUncompressedSize`);
 * both the sentinel form (decode-until-marker) and the patched definite form
 * decode to the same bytes, so the stream is valid before AND after patching.
 */
export const lzmaAloneEncode = (data: Uint8Array): Uint8Array => {
  const isMatch = new Uint16Array(IS_MATCH_SIZE).fill(PROB_INIT);
  const lit = new Uint16Array(LIT_SIZE).fill(PROB_INIT);

  const rc = new RangeEncoder();
  let state = 0;
  let prevByte = 0;

  for (let pos = 0; pos < data.length; pos++) {
    const posState = pos & POS_MASK;
    // isMatch[state, posState] = 0 → this position is a literal.
    rc.encodeBit(isMatch, (state << 4) + posState, 0);

    // Literal sub-coder. Context = top LC bits of the previous byte (lp=0).
    const base = 0x300 * (prevByte >>> (8 - LC));
    const symbol = data[pos];
    let ctx = 1;
    for (let bit = 7; bit >= 0; bit--) {
      const b = (symbol >>> bit) & 1;
      rc.encodeBit(lit, base + ctx, b);
      ctx = (ctx << 1) | b;
    }

    state = nextLiteralState(state);
    prevByte = symbol;
  }

  // Terminate with the end-of-stream marker (posState continues the position
  // sequence, i.e. the count of bytes emitted so far).
  writeEndMarker(rc, isMatch, state, data.length & POS_MASK);
  rc.flush();
  const payload = rc.bytes();

  const out = new Uint8Array(LZMA_ALONE_HEADER_LEN + payload.length);
  out[0] = LZMA_ALONE_PROPS_BYTE;
  out[1] = LZMA_DICT_SIZE & 0xff;
  out[2] = (LZMA_DICT_SIZE >>> 8) & 0xff;
  out[3] = (LZMA_DICT_SIZE >>> 16) & 0xff;
  out[4] = (LZMA_DICT_SIZE >>> 24) & 0xff;
  // Uncompressed size = 0xFFFFFFFFFFFFFFFF ("unknown"); the end marker delimits
  // the stream. compressAlone patches this to the definite size afterward.
  for (let i = 0; i < 8; i++) out[5 + i] = 0xff;
  out.set(payload, LZMA_ALONE_HEADER_LEN);
  return out;
};
