/**
 * Bulk-data framing: 506-byte data packets (0xAA 0xBB) wrapped in 512-byte
 * transfer frames (0x7E 0x5A). Byte-exact port of `data.rs` and test_print.py's
 * make_data_packet / wrap_data_frame / build_data_frames.
 */
import {
  MAGIC1,
  MAGIC2,
  PROTO_ID,
  DATA_TYPE,
  DATA_MAGIC1,
  DATA_MAGIC2,
  FIRMWARE_MAGIC2,
  DATA_PAYLOAD_SIZE,
  DATA_PACKET_SIZE,
  DATA_FRAME_SIZE,
  DATA_FRAME_PAYLOAD_LEN,
} from "./constants.ts";

/**
 * Build a 506-byte data packet.
 *
 * Layout:
 *   [0]      0xAA
 *   [1]      0xBB
 *   [2..4]   checksum LE (low 16 bits of the byte sum over [4..506])
 *   [4]      packet index (0-based)
 *   [5]      total packet count
 *   [6..506] payload (500 bytes, zero-padded)
 *
 * The checksum range [4..506] deliberately includes idx, total, and the padded
 * payload but NOT the magic bytes — so a firmware packet (byte[1] = 0xC7) has
 * the same checksum as the identical print packet.
 */
export function makeDataPacket(
  dataChunk: Uint8Array,
  pktIdx: number,
  pktTotal: number,
): Uint8Array {
  const pkt = new Uint8Array(DATA_PACKET_SIZE);
  pkt[0] = DATA_MAGIC1;
  pkt[1] = DATA_MAGIC2;
  pkt[4] = pktIdx & 0xff;
  pkt[5] = pktTotal & 0xff;

  const copyLen = Math.min(dataChunk.length, DATA_PAYLOAD_SIZE);
  pkt.set(dataChunk.subarray(0, copyLen), 6);

  // Sum in a plain JS number (safe: max 502 * 255 well under 2^53), keep low 16.
  let chk = 0;
  for (let i = 4; i < DATA_PACKET_SIZE; i++) chk += pkt[i];
  chk &= 0xffff;
  pkt[2] = chk & 0xff;
  pkt[3] = (chk >> 8) & 0xff;
  return pkt;
}

/**
 * Wrap a 506-byte data packet in a 512-byte transfer frame.
 *
 * Layout:
 *   [0]      0x7E
 *   [1]      0x5A
 *   [2..4]   0x01FC (payload length = 508)
 *   [4]      0x10 (protocol ID)
 *   [5]      0x02 (data transfer type)
 *   [6..512] 506-byte payload
 */
export function wrapDataFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(DATA_FRAME_SIZE);
  frame[0] = MAGIC1;
  frame[1] = MAGIC2;
  frame[2] = DATA_FRAME_PAYLOAD_LEN & 0xff;
  frame[3] = (DATA_FRAME_PAYLOAD_LEN >> 8) & 0xff;
  frame[4] = PROTO_ID;
  frame[5] = DATA_TYPE;
  frame.set(payload.subarray(0, DATA_PACKET_SIZE), 6);
  return frame;
}

/**
 * Number of 500-byte data packets a stream splits into: `ceil(len / 500)`,
 * i.e. Rust's `len.div_ceil(500)` and the reference's `(len + 499) // 500`.
 * A zero-length stream yields 0 packets — matching the references exactly (no
 * `max(1, …)` floor, which would emit a spurious empty packet for len 0).
 */
export function dataPacketCount(len: number): number {
  return Math.ceil(len / DATA_PAYLOAD_SIZE);
}

/**
 * Split a compressed raster stream into 512-byte transfer frames.
 * num_packets = ceil(len / 500); pkt_total is truncated to a u8 (matches the
 * vendor — jobs never exceed 255 packets in practice).
 */
export function buildDataFrames(compressed: Uint8Array): Uint8Array[] {
  const numPackets = dataPacketCount(compressed.length);
  const pktTotal = numPackets & 0xff;
  const frames: Uint8Array[] = [];
  for (let i = 0; i < numPackets; i++) {
    const offset = i * DATA_PAYLOAD_SIZE;
    const end = Math.min(offset + DATA_PAYLOAD_SIZE, compressed.length);
    const chunk = compressed.subarray(offset, end);
    frames.push(wrapDataFrame(makeDataPacket(chunk, i & 0xff, pktTotal)));
  }
  return frames;
}

/**
 * Split raw firmware into 512-byte transfer frames. Identical framing to
 * buildDataFrames except each packet carries the firmware marker (0xC7) at
 * byte 1, which is outside the checksum range so no recompute is needed.
 *
 * Framing primitive only — the flash is destructive and unverified on
 * T50-class printers; a live send is deliberately left to a caller.
 */
export function buildFirmwareFrames(firmware: Uint8Array): Uint8Array[] {
  const numPackets = dataPacketCount(firmware.length);
  const pktTotal = numPackets & 0xff;
  const frames: Uint8Array[] = [];
  for (let i = 0; i < numPackets; i++) {
    const offset = i * DATA_PAYLOAD_SIZE;
    const end = Math.min(offset + DATA_PAYLOAD_SIZE, firmware.length);
    const pkt = makeDataPacket(firmware.subarray(offset, end), i & 0xff, pktTotal);
    pkt[1] = FIRMWARE_MAGIC2; // outside checksum range — no recompute
    frames.push(wrapDataFrame(pkt));
  }
  return frames;
}
