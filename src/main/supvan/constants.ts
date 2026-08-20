/**
 * SUPVAN T-series / E11 wire-protocol constants.
 *
 * Byte-for-byte port of the reference implementation
 * (https://github.com/heeen/supvan-cups): `crates/supvan-proto/src/{cmd,data,
 * buffer,bitmap}.rs` and the runnable `test_print.py`. Every value here is
 * cross-checked against BOTH the Rust source and the Python client, which are
 * themselves ports of the vendor Android app (BasePrint.java / T50PlusPrint.java
 * / LzmaUtils.java). See docs/supvan-e11-label-printing-plan.md §5.
 *
 * All three physical transports (Classic-BT SPP, USB HID, BLE GATT) share this
 * identical 16-byte command framing, 512-byte data framing, status bit layout,
 * and print-buffer format — only the byte pipe differs. Nothing in this module
 * touches hardware.
 */

// --- Protocol magic / markers (cmd.rs) ---
export const MAGIC1 = 0x7e;
export const MAGIC2 = 0x5a;
export const PROTO_ID = 0x10;
export const PROTO_VER = 0x01;
export const MARKER_AA = 0xaa;
/** Data-transfer type byte at frame[5] of a 512-byte data frame. */
export const DATA_TYPE = 0x02;

// --- Data-packet magic (data.rs) ---
export const DATA_MAGIC1 = 0xaa;
export const DATA_MAGIC2 = 0xbb;
/**
 * Firmware-packet marker (byte 1). A firmware transfer reuses the exact
 * 506-byte packet / 512-byte frame layout but marks each packet 0xAA 0xC7.
 * The marker sits outside the checksum range ([4..506]) so it never affects
 * the packet checksum.
 */
export const FIRMWARE_MAGIC2 = 0xc7;

// --- Command bytes (cmd.rs / test_print.py) ---
export const CMD_BUF_FULL = 0x10;
export const CMD_INQUIRY_STA = 0x11;
export const CMD_CHECK_DEVICE = 0x12;
export const CMD_START_PRINT = 0x13;
export const CMD_STOP_PRINT = 0x14;
export const CMD_RD_DEV_NAME = 0x16;
export const CMD_READ_REV = 0x17;
export const CMD_PAPER_SKIP = 0x2e;
export const CMD_RETURN_MAT = 0x30;
export const CMD_NEXT_ZIPPEDBULK = 0x5c;
export const CMD_SET_RFID_DATA = 0x5d;
export const CMD_READ_FWVER = 0xc5;
/** Firmware-transfer start (sendCmdStartTrans(0xC6, 512, num_chunks)). */
export const CMD_UPDATE_FW = 0xc6;

// --- Additional opcodes recovered from the vendor Linux tool (cmd.rs). None is
// exercised by the T50 print/status/material path (all documented unused or
// "Reserved" in the reference, and absent from test_print.py), so they produce
// no wire bytes here — kept only so this vocabulary is complete against cmd.rs. ---
/** CHECK_RIB — check ribbon. No active call site in the reference. */
export const CMD_CHECK_RIB = 0x19;
/** RD_LAB_DPI — read the loaded label's DPI (G/TP/MP50 plugins). */
export const CMD_RD_LAB_DPI = 0x22;
/** RD_LAB_DPI per-material read variants. */
export const CMD_RD_LAB_DPI_24 = 0x24;
export const CMD_RD_LAB_DPI_25 = 0x25;
/** SET_PRTMODE — set print mode (MP50/P70-family in the vendor tool). */
export const CMD_SET_PRTMODE = 0x33;
/** SEND_INF — set print density (MP50/P70-family in the vendor tool). */
export const CMD_SEND_INF = 0x35;
/** TRANSFER ("传输字模") — Reserved; never sent (live bitmap path is NEXT_ZIPPEDBULK). */
export const CMD_TRANSFER = 0xf0;

// --- Command-frame layout (cmd.rs) ---
/** Declared payload length in byte 2 of every 16-byte command frame (= 12). */
export const CMD_PAYLOAD_LEN = 0x0c;

// --- Data-frame layout (data.rs) ---
/** Max payload bytes per 506-byte data packet. */
export const DATA_PAYLOAD_SIZE = 500;
/** 506-byte data packet total size (0xAA 0xBB header + idx/total + payload). */
export const DATA_PACKET_SIZE = 506;
/** 512-byte transfer frame total size. */
export const DATA_FRAME_SIZE = 512;
/** Transfer-frame payload length declared in frame[2..4] (= 506 + 2 = 508). */
export const DATA_FRAME_PAYLOAD_LEN = 508;

// --- Print-buffer layout (buffer.rs / test_print.py) ---
/** Max image-data bytes per print buffer (Android R2.drawable.sf5334_). */
export const MAX_BUF_DATA = 4074;
/** Print-buffer total size. */
export const PRINT_BUF_SIZE = 4096;
/** Print-buffer header size (bytes before image data). */
export const PRINT_BUF_HEADER = 14;
/** Margin clamp range (dots) for the print-buffer header. */
export const MARGIN_MAX_DOTS = 900;
/** Maximum density / red-deepness value encoded in the buffer header. */
export const MAX_DENSITY = 15;
/** The firmware re-reads the running checksum at every Nth byte. */
export const CHECKSUM_STRIDE = 256;

// --- Geometry (bitmap.rs) ---
// NOTE: these are the T50-Pro reference values. The E11 with 12/15mm tape almost
// certainly has a NARROWER printhead (~96-120 dots, not 384) — see the plan's
// risk register #2. The print pipeline takes geometry as parameters; these are
// only the reference defaults used by the golden-vector tests.
export const DOTS_PER_MM = 8;
export const PRINTHEAD_WIDTH_MM = 48;
export const PRINTHEAD_WIDTH_DOTS = PRINTHEAD_WIDTH_MM * DOTS_PER_MM; // 384
export const PRINTHEAD_BYTES_PER_LINE = PRINTHEAD_WIDTH_DOTS / 8; // 48
export const DEFAULT_MARGIN_DOTS = 8;

// --- Status-frame offsets (status.rs / test_print.py) ---
/** BT response framing length that precedes every payload. */
export const BT_RESP_HEADER_LEN = 22;
