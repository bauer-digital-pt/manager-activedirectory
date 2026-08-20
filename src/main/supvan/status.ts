/**
 * Response parsers for INQUIRY_STA (0x11) and RETURN_MAT (0x30), plus the
 * generic response validator. Byte-exact port of `status.rs` and
 * test_print.py's parse_status / parse_material.
 *
 * Offsets are for the BT (0x7E 0x5A) framing. The USB HID framing packs the
 * same bits at different offsets; that transport is out of scope for the E11
 * (BLE-only), so only the BT/BLE-shared framing is decoded here.
 */
import {
  MAGIC1,
  MAGIC2,
  CMD_INQUIRY_STA,
  CMD_RETURN_MAT,
  BT_RESP_HEADER_LEN,
} from "./constants.ts";

/** Parsed printer status from a CMD_INQUIRY_STA response. */
export interface PrinterStatus {
  // MSTA_REG low (byte 14)
  bufFull: boolean;
  labelRwError: boolean;
  labelEnd: boolean;
  labelModeError: boolean;
  ribbonRwError: boolean;
  ribbonEnd: boolean;
  lowBattery: boolean;
  // MSTA_REG high (byte 15)
  deviceBusy: boolean;
  headTempHigh: boolean;
  // FSTA_REG low (byte 16)
  coverOpen: boolean;
  insertUsb: boolean;
  printing: boolean;
  // FSTA_REG high (byte 17)
  labelNotInstalled: boolean;
  // Bytes 18-19
  printCount: number;
}

/** Parsed material/consumable info from a CMD_RETURN_MAT response. */
export interface MaterialInfo {
  uuid: string;
  code: string;
  sn: number;
  labelType: number;
  widthMm: number;
  heightMm: number;
  gapMm: number;
  remaining: number | null;
  deviceSn: string | null;
}

/**
 * Decode the four status register bytes (MSTA low/high, FSTA low/high) plus the
 * print counter. Shared by BT and USB framings, which carry the same bit
 * layout at different offsets.
 */
export function decodeStatusBits(
  b0: number,
  b1: number,
  b2: number,
  b3: number,
  printCount: number,
): PrinterStatus {
  return {
    bufFull: (b0 & 0x01) !== 0,
    labelRwError: (b0 & 0x02) !== 0,
    labelEnd: (b0 & 0x04) !== 0,
    labelModeError: (b0 & 0x08) !== 0,
    ribbonRwError: (b0 & 0x10) !== 0,
    ribbonEnd: (b0 & 0x20) !== 0,
    lowBattery: (b0 & 0x40) !== 0,
    deviceBusy: (b1 & 0x04) !== 0,
    headTempHigh: (b1 & 0x08) !== 0,
    coverOpen: (b2 & 0x08) !== 0,
    insertUsb: (b2 & 0x10) !== 0,
    printing: (b2 & 0x40) !== 0,
    labelNotInstalled: (b3 & 0x01) !== 0,
    printCount,
  };
}

/** Parse printer status from a CMD_INQUIRY_STA response, or null if invalid. */
export function parseStatus(data: Uint8Array): PrinterStatus | null {
  if (data.length < 20) return null;
  if (data[0] !== MAGIC1 || data[1] !== MAGIC2) return null;
  if (data[7] !== CMD_INQUIRY_STA) return null;
  return decodeStatusBits(
    data[14],
    data[15],
    data[16],
    data[17],
    (data[18] & 0xff) | ((data[19] & 0xff) << 8),
  );
}

/** Error flags paired with human-readable descriptions, in report order. */
const ERROR_FLAGS: Array<[keyof PrinterStatus, string]> = [
  ["labelRwError", "label read/write error"],
  ["labelEnd", "label roll end"],
  ["labelModeError", "label mode mismatch"],
  ["ribbonRwError", "ribbon read/write error"],
  ["ribbonEnd", "ribbon end"],
  ["coverOpen", "cover open"],
  ["headTempHigh", "printhead temperature too high"],
  ["labelNotInstalled", "label not installed"],
];

/** True if any error flag is set. */
export function hasError(status: PrinterStatus): boolean {
  return ERROR_FLAGS.some(([key]) => status[key] === true);
}

/** Human-readable description of any set error flags, or null if none. */
export function errorDescription(status: PrinterStatus): string | null {
  const errors = ERROR_FLAGS.filter(([key]) => status[key] === true).map(
    ([, msg]) => msg,
  );
  return errors.length ? errors.join(", ") : null;
}

function hexUpper(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out.toUpperCase();
}

/**
 * Parse material info from a CMD_RETURN_MAT response (BT framing), matching
 * test_print.py's parse_material — the runnable ground truth.
 *
 * Offsets (absolute in the raw frame; payload begins at BT_RESP_HEADER_LEN=22):
 *   [22..29]  uuid   (7 bytes, hex-upper)
 *   [29..37]  code   (8 bytes, hex-upper)
 *   [37..39]  sn     (u16 little-endian)
 *   [39]      labelType
 *   [40]      widthMm
 *   [41]      heightMm
 *   [42]      gapMm
 *   [43..47]  remaining (u32 little-endian, if present)
 *   [51..57]  deviceSn (6 bytes rendered as %02d each, if present)
 */
export function parseMaterial(data: Uint8Array): MaterialInfo | null {
  if (data.length < 43) return null;
  if (data[0] !== MAGIC1 || data[1] !== MAGIC2) return null;
  if (data[7] !== CMD_RETURN_MAT) return null;

  const uuid = hexUpper(data.subarray(22, 29));
  const code = hexUpper(data.subarray(29, 37));
  // Python builds the SN from `f'{data[38]:02x}{data[37]:02x}'` → high byte is
  // [38]; that equals a little-endian read of [37],[38].
  const sn = (data[37] & 0xff) | ((data[38] & 0xff) << 8);
  const labelType = data[39] & 0xff;
  const widthMm = data[40];
  const heightMm = data[41];
  const gapMm = data[42];

  let remaining: number | null = null;
  if (data.length >= 47) {
    remaining =
      (data[43] |
        (data[44] << 8) |
        (data[45] << 16) |
        (data[46] << 24)) >>>
      0;
  }

  let deviceSn: string | null = null;
  if (data.length >= 57) {
    let s = "";
    for (let i = 0; i < 6; i++) s += (data[51 + i] & 0xff).toString().padStart(2, "0");
    deviceSn = s;
  }

  return { uuid, code, sn, labelType, widthMm, heightMm, gapMm, remaining, deviceSn };
}

/**
 * Validate a response frame: at least `minLen` bytes, correct magic, and the
 * expected command echoed in the command slot. Mirrors
 * `status.rs::validate_response` (minLen = 8).
 */
export function validateResponse(
  data: Uint8Array,
  expectedCmd: number,
  minLen = 8,
): boolean {
  return (
    data.length >= minLen &&
    data[0] === MAGIC1 &&
    data[1] === MAGIC2 &&
    data[7] === expectedCmd
  );
}

// Re-export for callers that build responses / need the header length.
export { BT_RESP_HEADER_LEN };
