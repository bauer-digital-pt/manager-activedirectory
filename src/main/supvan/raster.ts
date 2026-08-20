/**
 * Raster pipeline: grayscale dithering, row-major → column-major LSB-first
 * repack, printhead centering, print-buffer assembly, and the deterministic
 * test pattern.
 *
 * Byte-exact port of `bitmap.rs`, `buffer.rs`, and `dither.rs`, cross-checked
 * against test_print.py's build_page_reg_bits / build_print_buffer /
 * create_test_pattern. See docs/supvan-e11-label-printing-plan.md §6-7.
 */
import {
  MAX_BUF_DATA,
  PRINT_BUF_SIZE,
  PRINT_BUF_HEADER,
  MARGIN_MAX_DOTS,
  MAX_DENSITY,
  CHECKSUM_STRIDE,
  DOTS_PER_MM,
  PRINTHEAD_WIDTH_MM,
  DEFAULT_MARGIN_DOTS,
} from "./constants.ts";

// ---------------------------------------------------------------------------
// Dithering (dither.rs)
// ---------------------------------------------------------------------------

/**
 * Thermal-compensated sRGB-to-dither LUT (W colorspace: 0=black, 255=white).
 * Combines sRGB linearization with a thermal-bleed compensation curve so
 * mid-tones stay light (anything above ~50% dot density prints solid). Copied
 * verbatim from dither.rs.
 */
// prettier-ignore
export const SRGB_TO_LINEAR: readonly number[] = [
  0, 50, 58, 63, 67, 70, 72, 74, 76, 78, 80, 82, 83, 85, 86, 88, 89, 90, 92, 93, 95, 96, 97, 98,
  100, 101, 102, 103, 105, 106, 107, 108, 109, 110, 112, 113, 114, 115, 116, 117, 118, 119, 120,
  121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 135, 136, 137, 138,
  139, 140, 141, 142, 142, 143, 144, 145, 146, 147, 148, 148, 149, 150, 151, 152, 152, 153, 154,
  155, 156, 156, 157, 158, 159, 159, 160, 161, 162, 162, 163, 164, 165, 165, 166, 167, 167, 168,
  169, 170, 170, 171, 172, 172, 173, 174, 174, 175, 176, 177, 177, 178, 179, 179, 180, 181, 181,
  182, 183, 183, 184, 184, 185, 186, 186, 187, 188, 188, 189, 190, 190, 191, 191, 192, 193, 193,
  194, 195, 195, 196, 196, 197, 198, 198, 199, 199, 200, 201, 201, 202, 202, 203, 203, 204, 205,
  205, 206, 206, 207, 207, 208, 209, 209, 210, 210, 211, 211, 212, 213, 213, 214, 214, 215, 215,
  216, 216, 217, 217, 218, 219, 219, 220, 220, 221, 221, 222, 222, 223, 223, 224, 224, 225, 225,
  226, 226, 227, 227, 228, 228, 229, 230, 230, 231, 231, 232, 232, 233, 233, 234, 234, 235, 235,
  236, 236, 237, 237, 238, 238, 238, 239, 239, 240, 240, 241, 241, 242, 242, 243, 243, 244, 244,
  245, 245, 246, 246, 247, 247, 248, 248, 249, 249, 249, 250, 250, 251, 251, 252, 252, 253, 253,
  254, 254, 255, 255,
];

/** 4x4 Bayer ordered-dither threshold matrix, scaled 0-255 (dither.rs). */
// prettier-ignore
export const BAYER4: readonly (readonly number[])[] = [
  [8, 136, 40, 168],
  [200, 72, 232, 104],
  [56, 184, 24, 152],
  [248, 120, 216, 88],
];

/**
 * Dither one 8bpp sRGB grayscale scanline to 1bpp MSB-first, horizontally
 * mirrored. `mono` must be at least ceil(width/8) bytes and pre-zeroed by the
 * caller. Exact port of dither_line.
 */
export function ditherLine(
  line: Uint8Array,
  width: number,
  y: number,
  mono: Uint8Array,
): void {
  const bayerRow = BAYER4[y & 3];
  for (let x = 0; x < width; x++) {
    const mx = width - 1 - x; // mirror
    const linear = SRGB_TO_LINEAR[line[x]];
    if (linear < bayerRow[mx & 3]) {
      mono[mx >> 3] |= 0x80 >> (mx & 7);
    }
  }
}

/**
 * Convenience front-end: dither a full 8bpp grayscale image (row-major,
 * `width * height` bytes) into a row-major MSB-first 1bpp bitmap suitable for
 * `rasterToColumnMajor`. Optional — the print path also accepts an already-1bpp
 * bitmap (a QR + text render is effectively 1-bit already).
 */
export function dither8bpp(
  gray: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const bpl = Math.ceil(width / 8);
  const out = new Uint8Array(bpl * height);
  for (let y = 0; y < height; y++) {
    const line = gray.subarray(y * width, y * width + width);
    ditherLine(line, width, y, out.subarray(y * bpl, y * bpl + bpl));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row-major → column-major repack (bitmap.rs)
// ---------------------------------------------------------------------------

export interface ColumnMajorResult {
  data: Uint8Array;
  cols: number;
  bytesPerLine: number;
}

/**
 * Convert a row-major MSB-first 1bpp bitmap into the printer's column-major
 * LSB-first format. Exact port of raster_to_column_major — note this is NOT a
 * true rotation: output column = input row y, dot position within a column =
 * input x, repacked MSB→LSB.
 */
export function rasterToColumnMajor(
  input: Uint8Array,
  width: number,
  height: number,
): ColumnMajorResult {
  const inBytesPerRow = Math.ceil(width / 8);
  const outBytesPerLine = Math.ceil(width / 8);
  const outCols = height;
  const output = new Uint8Array(outCols * outBytesPerLine);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inByteIdx = y * inBytesPerRow + (x >> 3);
      if (inByteIdx >= input.length) continue;
      const inBit = 7 - (x & 7); // MSB-first read
      const pixel = (input[inByteIdx] >> inBit) & 1;
      if (pixel !== 0) {
        const outByteIdx = y * outBytesPerLine + (x >> 3);
        output[outByteIdx] |= 1 << (x & 7); // LSB-first write
      }
    }
  }
  return { data: output, cols: outCols, bytesPerLine: outBytesPerLine };
}

/**
 * Center column-major LSB-first data within a full-width printhead canvas.
 * Exact port of center_in_printhead, including the truncate branch when the
 * input already fills or exceeds the canvas.
 */
export function centerInPrinthead(
  input: Uint8Array,
  numCols: number,
  inputWidthDots: number,
  canvasWidthDots: number,
): { data: Uint8Array; bytesPerLine: number } {
  const canvasBpl = Math.floor(canvasWidthDots / 8);
  const inputBpl = Math.ceil(inputWidthDots / 8);

  if (inputWidthDots >= canvasWidthDots) {
    const output = new Uint8Array(numCols * canvasBpl);
    const copyLen = Math.min(canvasBpl, inputBpl);
    for (let col = 0; col < numCols; col++) {
      const inStart = col * inputBpl;
      const outStart = col * canvasBpl;
      if (inStart + copyLen <= input.length) {
        output.set(input.subarray(inStart, inStart + copyLen), outStart);
      }
    }
    return { data: output, bytesPerLine: canvasBpl };
  }

  const xOffsetDots = Math.floor((canvasWidthDots - inputWidthDots) / 2);
  const output = new Uint8Array(numCols * canvasBpl);
  for (let col = 0; col < numCols; col++) {
    for (let dot = 0; dot < inputWidthDots; dot++) {
      const inByte = col * inputBpl + (dot >> 3);
      if (inByte >= input.length) continue;
      const pixel = (input[inByte] >> (dot & 7)) & 1;
      if (pixel !== 0) {
        const outDot = xOffsetDots + dot;
        const outByte = col * canvasBpl + (outDot >> 3);
        if (outByte < output.length) output[outByte] |= 1 << (outDot & 7);
      }
    }
  }
  return { data: output, bytesPerLine: canvasBpl };
}

// ---------------------------------------------------------------------------
// PAGE_REG_BITS + print buffer (buffer.rs)
// ---------------------------------------------------------------------------

export interface PageRegBits {
  pageSt?: boolean;
  pageEnd?: boolean;
  prtEnd?: boolean;
  cut?: number;
  savepaper?: boolean;
  firstCut?: number;
  nodu?: number;
  mat?: number;
}

/**
 * Build the 2-byte PAGE_REG_BITS for a print-buffer header. Exact port of
 * build_page_reg_bits.
 *
 * Byte 0: bit1 PageSt, bit2 PageEnd, bit3 PrtEnd, bits4-6 Cut, bit7 Savepaper.
 * Byte 1: bits0-1 FirstCut, bits2-5 Nodu (density), bits6-7 Mat.
 */
export function buildPageRegBits(p: PageRegBits): Uint8Array {
  const cut = p.cut ?? 0;
  const firstCut = p.firstCut ?? 0;
  const nodu = p.nodu ?? 4;
  const mat = p.mat ?? 1;

  let b0 = 0;
  if (p.pageSt) b0 |= 0x02;
  if (p.pageEnd) b0 |= 0x04;
  if (p.prtEnd) b0 |= 0x08;
  b0 &= 0x0f;
  b0 |= (cut & 0x07) << 4;
  if (p.savepaper) b0 |= 0x80;

  let b1 = 0;
  b1 |= firstCut & 0x03;
  b1 |= (nodu & 0x0f) << 2;
  b1 |= (mat & 0x03) << 6;

  return new Uint8Array([b0 & 0xff, b1 & 0xff]);
}

export interface PrintBufferParams {
  imageData: Uint8Array;
  perLineByte: number;
  colsInBuf: number;
  pageSt: boolean;
  pageEnd: boolean;
  prtEnd: boolean;
  marginTop: number;
  marginBottom: number;
  density: number;
}

/**
 * Build a 4096-byte print buffer. Exact port of build_print_buffer.
 *
 * Layout: [0..2] checksum LE, [2..4] PAGE_REG_BITS, [4..6] col count LE,
 * [6] bytes/line, [7] reserved, [8..10] margin top LE, [10..12] margin bottom
 * LE, [12] density, [13] 0, [14..] image data.
 *
 * Checksum = sum(buf[2..14]) + Σ buf[i*256 - 1] for i in 1..=(data_end/256),
 * where data_end = colsInBuf * perLineByte + 14.
 */
export function buildPrintBuffer(p: PrintBufferParams): Uint8Array {
  const buf = new Uint8Array(PRINT_BUF_SIZE);

  const pageBits = buildPageRegBits({
    pageSt: p.pageSt,
    pageEnd: p.pageEnd,
    prtEnd: p.prtEnd,
    nodu: p.density,
    mat: 1,
  });
  buf[2] = pageBits[0];
  buf[3] = pageBits[1];

  buf[4] = p.colsInBuf & 0xff;
  buf[5] = (p.colsInBuf >> 8) & 0xff;
  buf[6] = p.perLineByte & 0xff;

  const mt = Math.max(1, Math.min(p.marginTop, MARGIN_MAX_DOTS));
  const mb = Math.max(1, Math.min(p.marginBottom, MARGIN_MAX_DOTS));
  buf[8] = mt & 0xff;
  buf[9] = (mt >> 8) & 0xff;
  buf[10] = mb & 0xff;
  buf[11] = (mb >> 8) & 0xff;

  buf[12] = Math.min(p.density, MAX_DENSITY);
  // buf[13] = 0

  const dataLen = Math.min(p.imageData.length, PRINT_BUF_SIZE - PRINT_BUF_HEADER);
  buf.set(p.imageData.subarray(0, dataLen), PRINT_BUF_HEADER);

  const dataEnd = p.colsInBuf * p.perLineByte + PRINT_BUF_HEADER;
  let chk = 0;
  for (let i = 2; i < 14; i++) chk += buf[i];
  const nStrides = Math.floor(dataEnd / CHECKSUM_STRIDE);
  for (let i = 1; i <= nStrides; i++) {
    const idx = i * CHECKSUM_STRIDE - 1;
    if (idx < buf.length) chk += buf[idx];
  }
  buf[0] = chk & 0xff;
  buf[1] = (chk >> 8) & 0xff;

  return buf;
}

/**
 * Split column-major image data into 4096-byte print buffers ready for LZMA.
 * Exact port of split_into_buffers.
 */
export function splitIntoBuffers(
  imageData: Uint8Array,
  perLineByte: number,
  totalCols: number,
  marginTop: number,
  marginBottom: number,
  density: number,
): Uint8Array[] {
  const maxCols = Math.floor(MAX_BUF_DATA / perLineByte);
  const imageCols = totalCols - marginTop - marginBottom;
  const buffers: Uint8Array[] = [];
  let colsRemaining = imageCols;
  let currentCol = 0;

  while (colsRemaining > 0) {
    const colsInBuf = Math.min(colsRemaining, maxCols);
    const isFirst = currentCol === 0;
    const isLast = colsRemaining <= maxCols;

    const imgStart = (marginTop + currentCol) * perLineByte;
    const imgEnd = imgStart + colsInBuf * perLineByte;
    const imgChunk = imageData.subarray(imgStart, Math.min(imgEnd, imageData.length));

    buffers.push(
      buildPrintBuffer({
        imageData: imgChunk,
        perLineByte,
        colsInBuf,
        pageSt: isFirst,
        pageEnd: isLast,
        prtEnd: isLast,
        marginTop,
        marginBottom,
        density,
      }),
    );
    currentCol += colsInBuf;
    colsRemaining -= colsInBuf;
  }
  return buffers;
}

// ---------------------------------------------------------------------------
// Deterministic test pattern (bitmap.rs / test_print.py)
// ---------------------------------------------------------------------------

export interface TestPattern {
  data: Uint8Array;
  canvasWidthDots: number;
  heightDots: number;
  bytesPerLine: number;
}

/**
 * Create the reference test pattern (border + per-buffer X-cross + buffer-number
 * dots), column-major LSB-first. Exact port of create_test_pattern (minus the
 * reference's debug prints). Used as a deterministic golden image source.
 */
export function createTestPattern(
  labelWidthMm: number,
  heightMm: number,
  dpi: number = DOTS_PER_MM,
): TestPattern {
  const canvasWidthDots = PRINTHEAD_WIDTH_MM * dpi; // 384 @ dpi 8
  const heightDots = heightMm * dpi;
  const bytesPerLine = Math.floor(canvasWidthDots / 8);
  const labelWidthDots = labelWidthMm * dpi;
  const xOffset = Math.floor((canvasWidthDots - labelWidthDots) / 2);

  const marginTop = DEFAULT_MARGIN_DOTS;
  const marginBottom = DEFAULT_MARGIN_DOTS;
  const maxCols = Math.floor(MAX_BUF_DATA / bytesPerLine);

  const bufRegions: Array<[number, number]> = [];
  {
    let col = marginTop;
    while (col < heightDots - marginBottom) {
      const end = Math.min(col + maxCols, heightDots - marginBottom);
      bufRegions.push([col, end]);
      col = end;
    }
  }

  const buf = new Uint8Array(bytesPerLine * heightDots);

  for (let col = 0; col < heightDots; col++) {
    for (let row = 0; row < canvasWidthDots; row++) {
      let pixel = false;

      const labelRow = row - xOffset;
      if (labelRow >= 0 && labelRow < labelWidthDots) {
        const lr = labelRow;

        // Outer border (2px)
        if (lr < 2 || lr >= labelWidthDots - 2 || col < 2 || col >= heightDots - 2) {
          pixel = true;
        }

        for (let i = 0; i < bufRegions.length; i++) {
          const [bs, be] = bufRegions[i];
          if (col >= bs && col < be) {
            const bh = be - bs;
            const bw = labelWidthDots;
            const localCol = col - bs;

            // Buffer top/bottom border
            if (localCol < 2 || localCol >= bh - 2) pixel = true;

            // X cross diagonals (bh > 0 always here, so the div is defined)
            const expectedRow1 = Math.floor((localCol * bw) / bh);
            if (Math.abs(lr - expectedRow1) < 2) pixel = true;
            const expectedRow2 = bw - 1 - expectedRow1;
            if (Math.abs(lr - expectedRow2) < 2) pixel = true;

            // Buffer-number dots
            for (let d = 0; d <= i; d++) {
              const dx = 10 + d * 12;
              const dy = 10;
              if (lr >= dx && lr < dx + 8 && localCol >= dy && localCol < dy + 8) {
                pixel = true;
              }
            }
            break;
          }
        }
      }

      if (pixel) {
        const byteIdx = col * bytesPerLine + (row >> 3);
        buf[byteIdx] |= 1 << (row & 7); // LSB-first
      }
    }
  }

  return { data: buf, canvasWidthDots, heightDots, bytesPerLine };
}
