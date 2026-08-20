/**
 * Self-contained QR Code encoder (byte mode) — zero dependencies.
 *
 * Produces a spec-conformant QR symbol (ISO/IEC 18004) as a boolean module
 * matrix, for rendering onto a 1-bit label. Only **byte mode** is implemented
 * (a single UTF-8 byte segment), which encodes any URL / asset id correctly;
 * numeric/alphanumeric compaction is intentionally omitted (a label QR is not
 * capacity-constrained). Supports all 40 versions and the four ECC levels,
 * automatic smallest-fit version selection, and penalty-based mask selection.
 *
 * Verified byte-for-byte against `segno` (a conformant reference generator):
 * for a fixed mask the full module matrix matches, and the auto-selected mask
 * matches segno's, across many inputs / versions / ECC levels. See
 * test/supvan/qr.test.ts and test/supvan/gen_qr_golden.py.
 *
 * The algorithm follows the well-known public reference structure (Nayuki's QR
 * generator); the code here is an original TypeScript implementation. Nothing
 * touches hardware or Electron.
 */

// --- Public types -----------------------------------------------------------

/** Error-correction level (recovery capacity: L≈7%, M≈15%, Q≈25%, H≈30%). */
export type Ecc = "L" | "M" | "Q" | "H";

export interface QrCode {
  /** QR version 1..40 (symbol size = version*4 + 17 modules per side). */
  version: number;
  /** Modules per side. */
  size: number;
  ecc: Ecc;
  /** Applied data mask 0..7. */
  mask: number;
  /** Row-major module grid; `true` = dark module. */
  modules: boolean[][];
}

export interface QrOptions {
  /** Error-correction level (default "M"). */
  ecc?: Ecc;
  /** Pin a mask 0..7; omit for penalty-based auto selection. */
  mask?: number;
  /** Smallest version to consider (default 1). */
  minVersion?: number;
  /** Largest version to consider (default 40). */
  maxVersion?: number;
}

// --- ECC tables (indexed [eccOrdinal][version], version 1-based) -------------
// eccOrdinal: 0=L, 1=M, 2=Q, 3=H. Index 0 of each row is an unused placeholder.

// prettier-ignore
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
];

// prettier-ignore
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
];

const ECC_ORDINAL: Record<Ecc, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** Format-info 2-bit field per level (NOT the ordinal): L=1,M=0,Q=3,H=2. */
const ECC_FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

const MIN_VERSION = 1;
const MAX_VERSION = 40;
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

// --- Galois field GF(256) with primitive 0x11D ------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Reed-Solomon generator polynomial coefficients for `degree` ECC codewords. */
function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let d = 0; d < degree; d++) {
    const next = new Uint8Array(poly.length + 1);
    for (let i = 0; i < poly.length; i++) {
      next[i] ^= poly[i];
      next[i + 1] ^= gfMul(poly[i], GF_EXP[d]);
    }
    poly = next;
  }
  return poly;
}

/** ECC codewords for one data block. */
function rsRemainder(data: Uint8Array, degree: number): Uint8Array {
  // Monic generator poly (length degree+1, leading coeff 1). The remainder
  // step consumes the leading 1 via `factor`, so it uses only the trailing
  // `degree` coefficients (gen[1..degree]).
  const gen = rsGeneratorPoly(degree);
  const res = new Uint8Array(degree);
  for (const b of data) {
    const factor = b ^ res[0];
    res.copyWithin(0, 1);
    res[degree - 1] = 0;
    for (let i = 0; i < degree; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

// --- Version geometry -------------------------------------------------------

function sizeForVersion(ver: number): number {
  return ver * 4 + 17;
}

/** Total data-region module count (bits) available for data+ecc codewords. */
function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36; // two 18-bit version blocks
  }
  return result;
}

/** Number of 8-bit data codewords for (version, ecc). */
function numDataCodewords(ver: number, ecc: Ecc): number {
  const ord = ECC_ORDINAL[ecc];
  const totalCw = Math.floor(numRawDataModules(ver) / 8);
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK[ord][ver];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ord][ver];
  return totalCw - eccPerBlock * numBlocks;
}

/** Byte-mode character-count-indicator width in bits for a version. */
function byteModeCountBits(ver: number): number {
  return ver <= 9 ? 8 : 16;
}

/** Alignment-pattern centre coordinates for a version. */
function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const size = sizeForVersion(ver);
  const step =
    ver === 32
      ? 26
      : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result: number[] = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

// --- Bit buffer -------------------------------------------------------------

class BitBuffer {
  readonly bits: number[] = [];
  append(value: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

// --- Encoding ---------------------------------------------------------------

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function chooseVersion(
  dataLen: number,
  ecc: Ecc,
  minVer: number,
  maxVer: number,
): number {
  for (let ver = minVer; ver <= maxVer; ver++) {
    const capacityBits = numDataCodewords(ver, ecc) * 8;
    const usedBits = 4 + byteModeCountBits(ver) + dataLen * 8;
    if (usedBits <= capacityBits) return ver;
  }
  throw new Error(
    `data too long for QR byte mode: ${dataLen} bytes exceeds version ${maxVer}/${ecc}`,
  );
}

/** Build the padded, terminated data codeword sequence for one symbol. */
function buildDataCodewords(bytes: Uint8Array, ver: number, ecc: Ecc): Uint8Array {
  const bb = new BitBuffer();
  bb.append(0b0100, 4); // byte mode indicator
  bb.append(bytes.length, byteModeCountBits(ver));
  for (const b of bytes) bb.append(b, 8);

  const capacityBits = numDataCodewords(ver, ecc) * 8;
  // Terminator (up to 4 zero bits).
  const term = Math.min(4, capacityBits - bb.bits.length);
  bb.append(0, term);
  // Pad to byte boundary. Note: matches the reference generator (segno), which
  // adds `8 - (len % 8)` zero bits — i.e. a full zero byte when the stream is
  // already byte-aligned after the terminator. This trailing zero codeword is
  // ignored by decoders (it follows the terminator) but must be present for a
  // byte-identical symbol.
  bb.append(0, 8 - (bb.bits.length % 8));
  // Alternating pad bytes.
  for (let pad = 0xec; bb.bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
    bb.append(pad, 8);
  }

  const out = new Uint8Array(bb.bits.length / 8);
  for (let i = 0; i < bb.bits.length; i++) {
    out[i >> 3] |= bb.bits[i] << (7 - (i & 7));
  }
  return out;
}

/** Split into blocks, compute RS ECC, interleave data then ECC codewords. */
function addEccAndInterleave(data: Uint8Array, ver: number, ecc: Ecc): Uint8Array {
  const ord = ECC_ORDINAL[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ord][ver];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[ord][ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockDataLen = Math.floor(rawCodewords / numBlocks) - eccLen;

  const blocks: { data: Uint8Array; ecc: Uint8Array }[] = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const dataLen = shortBlockDataLen + (i < numShortBlocks ? 0 : 1);
    const blockData = data.subarray(offset, offset + dataLen);
    offset += dataLen;
    blocks.push({ data: blockData, ecc: rsRemainder(blockData, eccLen) });
  }

  const result: number[] = [];
  // Interleave data codewords column-by-column across blocks.
  const maxDataLen = shortBlockDataLen + 1;
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < blocks[b].data.length) result.push(blocks[b].data[i]);
    }
  }
  // Interleave ECC codewords.
  for (let i = 0; i < eccLen; i++) {
    for (let b = 0; b < blocks.length; b++) result.push(blocks[b].ecc[i]);
  }
  return Uint8Array.from(result);
}

// --- Matrix -----------------------------------------------------------------

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly isFunction: boolean[][];

  constructor(ver: number) {
    this.size = sizeForVersion(ver);
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.isFunction = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
  }

  private setFn(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  drawFunctionPatterns(ver: number): void {
    const size = this.size;
    // Timing patterns.
    for (let i = 0; i < size; i++) {
      this.setFn(6, i, i % 2 === 0);
      this.setFn(i, 6, i % 2 === 0);
    }
    // Finder patterns + separators (three corners).
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    // Alignment patterns.
    const pos = alignmentPositions(ver);
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const corner =
          (i === 0 && j === 0) ||
          (i === 0 && j === n - 1) ||
          (i === n - 1 && j === 0);
        if (!corner) this.drawAlignment(pos[i], pos[j]);
      }
    }
    // Reserve format & version areas as LIGHT so codewords skip them and mask
    // evaluation sees them as 0 — matching the reference, which scores the
    // symbol BEFORE format/version info is written (ISO 18004 §7.8).
    for (const c of this.formatCells()) this.setFn(c.x, c.y, false);
    this.setFn(8, size - 8, false); // dark module (drawn dark later)
    if (ver >= 7) {
      for (const c of this.versionCells()) this.setFn(c.x, c.y, false);
    }
  }

  /** (x,y) → format-info bit index (15 bits), both placement copies. */
  private formatCells(): Array<{ x: number; y: number; bit: number }> {
    const size = this.size;
    const cells: Array<{ x: number; y: number; bit: number }> = [];
    // First copy, around the top-left finder.
    for (let i = 0; i <= 5; i++) cells.push({ x: 8, y: i, bit: i });
    cells.push({ x: 8, y: 7, bit: 6 });
    cells.push({ x: 8, y: 8, bit: 7 });
    cells.push({ x: 7, y: 8, bit: 8 });
    for (let i = 9; i < 15; i++) cells.push({ x: 14 - i, y: 8, bit: i });
    // Second copy, split across the other two finders.
    for (let i = 0; i < 8; i++) cells.push({ x: size - 1 - i, y: 8, bit: i });
    for (let i = 8; i < 15; i++) cells.push({ x: 8, y: size - 15 + i, bit: i });
    return cells;
  }

  /** (x,y) → version-info bit index (18 bits), both placement copies. */
  private versionCells(): Array<{ x: number; y: number; bit: number }> {
    const size = this.size;
    const cells: Array<{ x: number; y: number; bit: number }> = [];
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      cells.push({ x: a, y: b, bit: i });
      cells.push({ x: b, y: a, bit: i });
    }
    return cells;
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFn(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  /** Write the real 15-bit format information (call AFTER mask selection). */
  drawFormatBits(ecc: Ecc, mask: number): void {
    const data = (ECC_FORMAT_BITS[ecc] << 3) | mask; // 5 bits
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412; // 15 bits, masked
    for (const c of this.formatCells()) {
      this.setFn(c.x, c.y, ((bits >> c.bit) & 1) !== 0);
    }
    this.setFn(8, this.size - 8, true); // always-dark module
  }

  /** Write the real 18-bit version information for v≥7 (AFTER mask). */
  drawVersion(ver: number): void {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
    const bits = (ver << 12) | rem; // 18 bits
    for (const c of this.versionCells()) {
      this.setFn(c.x, c.y, ((bits >> c.bit) & 1) !== 0);
    }
  }

  drawCodewords(data: Uint8Array): void {
    const size = this.size;
    let i = 0; // bit index
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip vertical timing column
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = ((data[i >> 3] >> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    const size = this.size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (this.isFunction[y][x]) continue;
        let invert = false;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: throw new Error(`invalid mask ${mask}`);
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /**
   * Penalty score of the current (masked) matrix. Faithful port of the
   * reference `mask_scores` (ISO 18004 §7.8.3, Table 11); must be evaluated
   * with the format/version areas still light for the mask choice to match.
   */
  penaltyScore(): number {
    const b = this.scoreBreakdown();
    return b[0] + b[1] + b[2] + b[3];
  }

  scoreBreakdown(): [number, number, number, number] {
    const size = this.size;
    const m = this.modules;
    const bit = (y: number, x: number): number => (m[y][x] ? 1 : 0);

    let n1 = 0;
    let n2 = 0;
    let n3 = 0;
    let dark = 0;
    let lastRow: number[] | null = null;

    for (let i = 0; i < size; i++) {
      const row = new Array<number>(size);
      const col = new Array<number>(size);
      let rowPrev = -1;
      let colPrev = -1;
      let n1r = 0;
      let n1c = 0;
      for (let j = 0; j < size; j++) {
        const rb = bit(i, j);
        const cb = bit(j, i);
        row[j] = rb;
        col[j] = cb;
        dark += rb;
        // N1 — row-wise runs.
        if (rb === rowPrev) n1r++;
        else {
          if (n1r >= 5) n1 += n1r - 2;
          n1r = 1;
        }
        // N1 — column-wise runs.
        if (cb === colPrev) n1c++;
        else {
          if (n1c >= 5) n1 += n1c - 2;
          n1c = 1;
        }
        // N2 — 2x2 uniform block ending at (i,j).
        if (lastRow && j > 0 && rb === rowPrev && rb === lastRow[j] && rb === lastRow[j - 1]) {
          n2 += PENALTY_N2;
        }
        rowPrev = rb;
        colPrev = cb;
      }
      lastRow = row;
      n3 += this.n3Occurrences(row);
      n3 += this.n3Occurrences(col);
      if (n1r >= 5) n1 += n1r - 2;
      if (n1c >= 5) n1 += n1c - 2;
    }

    const total = size * size;
    const n4 = PENALTY_N4 * Math.floor(Math.abs((dark / total) * 100 - 50) / 5);
    return [n1, n2, n3, n4];
  }

  /** Count 1:1:3:1:1 finder-like patterns in one sequence (reference port). */
  private n3Occurrences(seq: number[]): number {
    const size = this.size;
    const anyDark = (lo: number, hi: number): boolean => {
      for (let k = Math.max(lo, 0); k < Math.min(hi, size); k++) {
        if (seq[k]) return true;
      }
      return false;
    };
    const findPattern = (start: number): number => {
      for (let idx = start; idx <= size - 7; idx++) {
        if (
          seq[idx] === 1 &&
          seq[idx + 1] === 0 &&
          seq[idx + 2] === 1 &&
          seq[idx + 3] === 1 &&
          seq[idx + 4] === 1 &&
          seq[idx + 5] === 0 &&
          seq[idx + 6] === 1
        ) {
          return idx;
        }
      }
      return -1;
    };

    let count = 0;
    let idx = findPattern(0);
    while (idx !== -1) {
      let offset = idx + 7;
      if (
        idx === 0 ||
        idx === size - 7 ||
        !anyDark(idx - 4, idx) ||
        !anyDark(offset, offset + 4)
      ) {
        count += PENALTY_N3;
      } else {
        offset = idx + 4;
      }
      idx = findPattern(offset);
    }
    return count;
  }
}

// --- Top-level encode -------------------------------------------------------

/**
 * Encode `text` (UTF-8, byte mode) into a QR symbol. Selects the smallest
 * version that fits within [minVersion, maxVersion] for the ECC level, and the
 * lowest-penalty mask unless one is pinned.
 */
export function encodeQr(text: string, opts: QrOptions = {}): QrCode {
  const ecc = opts.ecc ?? "M";
  const minVer = Math.max(MIN_VERSION, opts.minVersion ?? MIN_VERSION);
  const maxVer = Math.min(MAX_VERSION, opts.maxVersion ?? MAX_VERSION);
  if (minVer > maxVer) throw new Error("minVersion exceeds maxVersion");

  const bytes = utf8Bytes(text);
  const ver = chooseVersion(bytes.length, ecc, minVer, maxVer);
  const dataCw = buildDataCodewords(bytes, ver, ecc);
  const allCw = addEccAndInterleave(dataCw, ver, ecc);

  // Build the masked matrix WITHOUT format/version info (so penalty evaluation
  // and mask selection match the reference).
  const build = (mask: number): Matrix => {
    const mtx = new Matrix(ver);
    mtx.drawFunctionPatterns(ver);
    mtx.drawCodewords(allCw);
    mtx.applyMask(mask);
    return mtx;
  };

  let chosenMask = opts.mask;
  let mtx: Matrix;
  if (chosenMask === undefined) {
    let best = Infinity;
    chosenMask = 0;
    mtx = build(0);
    for (let mask = 0; mask < 8; mask++) {
      const candidate = build(mask);
      const p = candidate.penaltyScore();
      if (p < best) {
        best = p;
        chosenMask = mask;
        mtx = candidate;
      }
    }
  } else {
    if (chosenMask < 0 || chosenMask > 7) throw new Error("mask must be 0..7");
    mtx = build(chosenMask);
  }

  // Now write the real format & version information onto the chosen matrix.
  mtx.drawFormatBits(ecc, chosenMask);
  if (ver >= 7) mtx.drawVersion(ver);

  return {
    version: ver,
    size: mtx.size,
    ecc,
    mask: chosenMask,
    modules: mtx.modules,
  };
}
