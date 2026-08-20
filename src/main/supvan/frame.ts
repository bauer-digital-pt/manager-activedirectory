/**
 * 16-byte command frames (0x7E 0x5A format).
 *
 * Byte-exact port of `cmd.rs::{make_cmd, make_cmd_start_trans}` and
 * test_print.py's equivalents. A plain command is a start-transfer frame with
 * block_count = 0, so the parameter occupies the block_size field at [12..14].
 */
import {
  MAGIC1,
  MAGIC2,
  PROTO_ID,
  PROTO_VER,
  MARKER_AA,
  CMD_PAYLOAD_LEN,
} from "./constants.ts";

/** Write a u16 as little-endian at `buf[offset]`, `buf[offset+1]`. */
function writeU16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
}

/**
 * Build a 16-byte start-transfer command frame.
 *
 * Layout:
 *   [0]  0x7E   [1]  0x5A
 *   [2]  0x0C   [3]  0x00   (payload length = 12)
 *   [4]  0x10   [5]  0x01   (protocol ID, version)
 *   [6]  0xAA   [7]  CMD
 *   [8..10]  checksum LE (sum of bytes [10..16])
 *   [10] 0x00  [11] 0x01
 *   [12..14] block_size LE
 *   [14..16] block_count LE
 *
 * Used for CMD_NEXT_ZIPPEDBULK (block_size=512, block_count=num_packets) and
 * CMD_BUF_FULL (block_size=compressed_len, block_count=speed).
 */
export function makeCmdStartTrans(
  cmd: number,
  blockSize: number,
  blockCount: number,
): Uint8Array {
  const pkt = new Uint8Array(16);
  pkt[0] = MAGIC1;
  pkt[1] = MAGIC2;
  pkt[2] = CMD_PAYLOAD_LEN;
  // pkt[3] = 0x00 (already zero)
  pkt[4] = PROTO_ID;
  pkt[5] = PROTO_VER;
  pkt[6] = MARKER_AA;
  pkt[7] = cmd & 0xff;
  // pkt[10] = 0x00 (reserved, already zero)
  pkt[11] = 0x01;
  writeU16LE(pkt, 12, blockSize);
  writeU16LE(pkt, 14, blockCount);

  // Checksum = LE u16 of the byte sum over [10..16].
  let chk = 0;
  for (let i = 10; i < 16; i++) chk += pkt[i];
  writeU16LE(pkt, 8, chk & 0xffff);
  return pkt;
}

/**
 * Build a standard 16-byte command frame. The parameter lands in the block_size
 * field at [12..14]; block_count stays 0.
 */
export function makeCmd(cmd: number, param = 0): Uint8Array {
  return makeCmdStartTrans(cmd, param, 0);
}
