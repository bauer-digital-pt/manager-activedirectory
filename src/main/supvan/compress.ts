/**
 * LZMA1 "alone" compression for print buffers.
 *
 * The printer firmware decodes an LZMA1 alone-format stream with the vendor's
 * fixed parameters (LzmaUtils.java): dict_size=8192, lc=3, lp=0, pb=2,
 * nice_len=128, MODE_NORMAL, MF_BT4. The alone header is then patched so bytes
 * [5..13] hold the EXACT uncompressed size (the encoder writes 0xFFFF… for
 * "unknown"; the firmware needs the real value). Port of `compress.rs` +
 * test_print.py's LZMA block.
 *
 * The actual entropy coder is injected (`LzmaAloneEncoder`) rather than bundled.
 * A real print therefore REQUIRES a caller-supplied encoder — choosing the
 * backend (lzma-native vs a pure-JS/WASM coder) is a Phase-2 task once the
 * transport is settled. Note the encoder need NOT be byte-identical to Python's
 * `lzma` module: LZMA output is not canonical, and the firmware DECODES the
 * stream rather than comparing bytes, so any encoder that emits a valid alone
 * stream with the vendor parameters (which `compressAlone` verifies via the
 * header prefix) prints correctly. Everything in THIS module — header-shape
 * validation and the size patch — is deterministic and unit-tested against the
 * Python reference now; the golden tests exercise it by injecting a
 * reference-produced stream as the encoder.
 */

/**
 * LZMA1 alone-format properties byte for lc=3, lp=0, pb=2.
 * Encoding: lc + lp*9 + pb*45 = 3 + 0 + 90 = 93 = 0x5D.
 */
export const LZMA_ALONE_PROPS_BYTE = 0x5d;

/** Vendor dictionary size (8 KiB — larger dictionaries exceed printer RAM). */
export const LZMA_DICT_SIZE = 8192;

/** Alone header length: 1 props byte + 4 dict-size + 8 uncompressed-size. */
export const LZMA_ALONE_HEADER_LEN = 13;

/**
 * An injected LZMA1 alone-format encoder. MUST encode with the vendor
 * parameters above and produce a standard 13-byte alone header followed by the
 * compressed payload. `compressAlone` fixes up the uncompressed-size field
 * afterward, so an encoder that writes the "unknown size" sentinel is fine.
 */
export type LzmaAloneEncoder = (data: Uint8Array) => Uint8Array;

/**
 * The expected 5-byte alone-header prefix (props byte + dict_size LE) for the
 * vendor parameters. Used to validate an injected encoder's output.
 */
export function expectedAloneHeaderPrefix(): Uint8Array {
  const h = new Uint8Array(5);
  h[0] = LZMA_ALONE_PROPS_BYTE;
  h[1] = LZMA_DICT_SIZE & 0xff;
  h[2] = (LZMA_DICT_SIZE >> 8) & 0xff;
  h[3] = (LZMA_DICT_SIZE >> 16) & 0xff;
  h[4] = (LZMA_DICT_SIZE >> 24) & 0xff;
  return h;
}

/**
 * Patch bytes [5..13] of an LZMA alone stream with the definite uncompressed
 * size, little-endian u64 — byte-exact equivalent of Python's
 * `struct.pack_into('<Q', stream, 5, size)`. Mutates and returns `stream`.
 */
export function patchUncompressedSize(
  stream: Uint8Array,
  uncompressedSize: number,
): Uint8Array {
  if (stream.length < LZMA_ALONE_HEADER_LEN) {
    throw new Error(
      `lzma alone stream too short to patch: ${stream.length} bytes`,
    );
  }
  if (!Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0) {
    throw new Error(`invalid uncompressed size: ${uncompressedSize}`);
  }
  let v = BigInt(uncompressedSize);
  const mask = 0xffn;
  for (let i = 0; i < 8; i++) {
    stream[5 + i] = Number(v & mask);
    v >>= 8n;
  }
  return stream;
}

/**
 * Compress `data` to a size-patched LZMA1 alone stream using the injected
 * encoder. Validates the encoder emitted the vendor header prefix, then patches
 * the uncompressed-size field to `data.length`.
 */
export function compressAlone(
  data: Uint8Array,
  encode: LzmaAloneEncoder,
): Uint8Array {
  const raw = encode(data);
  if (raw.length < LZMA_ALONE_HEADER_LEN) {
    throw new Error(`encoder returned a too-short stream: ${raw.length} bytes`);
  }
  const wantPrefix = expectedAloneHeaderPrefix();
  for (let i = 0; i < wantPrefix.length; i++) {
    if (raw[i] !== wantPrefix[i]) {
      throw new Error(
        `encoder produced unexpected LZMA header (byte ${i}: got 0x${raw[
          i
        ].toString(16)}, want 0x${wantPrefix[i].toString(16)}) — check lc/lp/pb/dict_size`,
      );
    }
  }
  // Copy so we never mutate the encoder's buffer under the caller.
  const out = raw.slice();
  patchUncompressedSize(out, data.length);
  return out;
}

/** Concatenate 4096-byte print buffers into one contiguous stream. */
export function concatBuffers(buffers: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const b of buffers) total += b.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

export interface CompressedBuffers {
  compressed: Uint8Array;
  /** Average compressed bytes per buffer (drives `calcSpeed`). */
  avgPerBuffer: number;
}

/**
 * Concatenate print buffers and compress them as a SINGLE alone stream (the
 * firmware reads the 14-byte header at each 4096-byte boundary internally). The
 * average-per-buffer figure matches the vendor's `len / count` speed input.
 */
export function compressBuffersForPrint(
  buffers: Uint8Array[],
  encode: LzmaAloneEncoder,
): CompressedBuffers {
  if (buffers.length === 0) throw new Error("no buffers to compress");
  const compressed = compressAlone(concatBuffers(buffers), encode);
  return { compressed, avgPerBuffer: compressed.length / buffers.length };
}
