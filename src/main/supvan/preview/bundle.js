"use strict";
(() => {
  // src/main/supvan/qr.ts
  var ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    // L
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    // M
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    // Q
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
    // H
  ];
  var NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    // L
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    // M
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    // Q
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
    // H
  ];
  var ECC_ORDINAL = { L: 0, M: 1, Q: 2, H: 3 };
  var ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
  var MIN_VERSION = 1;
  var MAX_VERSION = 40;
  var PENALTY_N2 = 3;
  var PENALTY_N3 = 40;
  var PENALTY_N4 = 10;
  var GF_EXP = new Uint8Array(512);
  var GF_LOG = new Uint8Array(256);
  (function initGf() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 256) x ^= 285;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();
  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }
  function rsGeneratorPoly(degree) {
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
  function rsRemainder(data, degree) {
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
  function sizeForVersion(ver) {
    return ver * 4 + 17;
  }
  function numRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function numDataCodewords(ver, ecc) {
    const ord = ECC_ORDINAL[ecc];
    const totalCw = Math.floor(numRawDataModules(ver) / 8);
    const eccPerBlock = ECC_CODEWORDS_PER_BLOCK[ord][ver];
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ord][ver];
    return totalCw - eccPerBlock * numBlocks;
  }
  function byteModeCountBits(ver) {
    return ver <= 9 ? 8 : 16;
  }
  function alignmentPositions(ver) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const size = sizeForVersion(ver);
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) {
      result.splice(1, 0, pos);
    }
    return result;
  }
  var BitBuffer = class {
    bits = [];
    append(value, len) {
      for (let i = len - 1; i >= 0; i--) this.bits.push(value >>> i & 1);
    }
  };
  function utf8Bytes(text) {
    return new TextEncoder().encode(text);
  }
  function chooseVersion(dataLen, ecc, minVer, maxVer) {
    for (let ver = minVer; ver <= maxVer; ver++) {
      const capacityBits = numDataCodewords(ver, ecc) * 8;
      const usedBits = 4 + byteModeCountBits(ver) + dataLen * 8;
      if (usedBits <= capacityBits) return ver;
    }
    throw new Error(
      `data too long for QR byte mode: ${dataLen} bytes exceeds version ${maxVer}/${ecc}`
    );
  }
  function buildDataCodewords(bytes, ver, ecc) {
    const bb = new BitBuffer();
    bb.append(4, 4);
    bb.append(bytes.length, byteModeCountBits(ver));
    for (const b of bytes) bb.append(b, 8);
    const capacityBits = numDataCodewords(ver, ecc) * 8;
    const term = Math.min(4, capacityBits - bb.bits.length);
    bb.append(0, term);
    bb.append(0, 8 - bb.bits.length % 8);
    for (let pad = 236; bb.bits.length < capacityBits; pad ^= 236 ^ 17) {
      bb.append(pad, 8);
    }
    const out = new Uint8Array(bb.bits.length / 8);
    for (let i = 0; i < bb.bits.length; i++) {
      out[i >> 3] |= bb.bits[i] << 7 - (i & 7);
    }
    return out;
  }
  function addEccAndInterleave(data, ver, ecc) {
    const ord = ECC_ORDINAL[ecc];
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ord][ver];
    const eccLen = ECC_CODEWORDS_PER_BLOCK[ord][ver];
    const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - rawCodewords % numBlocks;
    const shortBlockDataLen = Math.floor(rawCodewords / numBlocks) - eccLen;
    const blocks = [];
    let offset = 0;
    for (let i = 0; i < numBlocks; i++) {
      const dataLen = shortBlockDataLen + (i < numShortBlocks ? 0 : 1);
      const blockData = data.subarray(offset, offset + dataLen);
      offset += dataLen;
      blocks.push({ data: blockData, ecc: rsRemainder(blockData, eccLen) });
    }
    const result = [];
    const maxDataLen = shortBlockDataLen + 1;
    for (let i = 0; i < maxDataLen; i++) {
      for (let b = 0; b < blocks.length; b++) {
        if (i < blocks[b].data.length) result.push(blocks[b].data[i]);
      }
    }
    for (let i = 0; i < eccLen; i++) {
      for (let b = 0; b < blocks.length; b++) result.push(blocks[b].ecc[i]);
    }
    return Uint8Array.from(result);
  }
  var Matrix = class {
    size;
    modules;
    isFunction;
    constructor(ver) {
      this.size = sizeForVersion(ver);
      this.modules = Array.from(
        { length: this.size },
        () => new Array(this.size).fill(false)
      );
      this.isFunction = Array.from(
        { length: this.size },
        () => new Array(this.size).fill(false)
      );
    }
    setFn(x, y, dark) {
      this.modules[y][x] = dark;
      this.isFunction[y][x] = true;
    }
    drawFunctionPatterns(ver) {
      const size = this.size;
      for (let i = 0; i < size; i++) {
        this.setFn(6, i, i % 2 === 0);
        this.setFn(i, 6, i % 2 === 0);
      }
      this.drawFinder(3, 3);
      this.drawFinder(size - 4, 3);
      this.drawFinder(3, size - 4);
      const pos = alignmentPositions(ver);
      const n = pos.length;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const corner = i === 0 && j === 0 || i === 0 && j === n - 1 || i === n - 1 && j === 0;
          if (!corner) this.drawAlignment(pos[i], pos[j]);
        }
      }
      for (const c of this.formatCells()) this.setFn(c.x, c.y, false);
      this.setFn(8, size - 8, false);
      if (ver >= 7) {
        for (const c of this.versionCells()) this.setFn(c.x, c.y, false);
      }
    }
    /** (x,y) → format-info bit index (15 bits), both placement copies. */
    formatCells() {
      const size = this.size;
      const cells = [];
      for (let i = 0; i <= 5; i++) cells.push({ x: 8, y: i, bit: i });
      cells.push({ x: 8, y: 7, bit: 6 });
      cells.push({ x: 8, y: 8, bit: 7 });
      cells.push({ x: 7, y: 8, bit: 8 });
      for (let i = 9; i < 15; i++) cells.push({ x: 14 - i, y: 8, bit: i });
      for (let i = 0; i < 8; i++) cells.push({ x: size - 1 - i, y: 8, bit: i });
      for (let i = 8; i < 15; i++) cells.push({ x: 8, y: size - 15 + i, bit: i });
      return cells;
    }
    /** (x,y) → version-info bit index (18 bits), both placement copies. */
    versionCells() {
      const size = this.size;
      const cells = [];
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + i % 3;
        const b = Math.floor(i / 3);
        cells.push({ x: a, y: b, bit: i });
        cells.push({ x: b, y: a, bit: i });
      }
      return cells;
    }
    drawFinder(cx, cy) {
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
    drawAlignment(cx, cy) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          this.setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    /** Write the real 15-bit format information (call AFTER mask selection). */
    drawFormatBits(ecc, mask) {
      const data = ECC_FORMAT_BITS[ecc] << 3 | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = rem << 1 ^ (rem >> 9) * 1335;
      const bits = (data << 10 | rem) ^ 21522;
      for (const c of this.formatCells()) {
        this.setFn(c.x, c.y, (bits >> c.bit & 1) !== 0);
      }
      this.setFn(8, this.size - 8, true);
    }
    /** Write the real 18-bit version information for v≥7 (AFTER mask). */
    drawVersion(ver) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = rem << 1 ^ (rem >> 11) * 7973;
      const bits = ver << 12 | rem;
      for (const c of this.versionCells()) {
        this.setFn(c.x, c.y, (bits >> c.bit & 1) !== 0);
      }
    }
    drawCodewords(data) {
      const size = this.size;
      let i = 0;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
          for (let j = 0; j < 2; j++) {
            const x = right - j;
            const upward = (right + 1 & 2) === 0;
            const y = upward ? size - 1 - vert : vert;
            if (!this.isFunction[y][x] && i < data.length * 8) {
              this.modules[y][x] = (data[i >> 3] >> 7 - (i & 7) & 1) !== 0;
              i++;
            }
          }
        }
      }
    }
    applyMask(mask) {
      const size = this.size;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (this.isFunction[y][x]) continue;
          let invert = false;
          switch (mask) {
            case 0:
              invert = (x + y) % 2 === 0;
              break;
            case 1:
              invert = y % 2 === 0;
              break;
            case 2:
              invert = x % 3 === 0;
              break;
            case 3:
              invert = (x + y) % 3 === 0;
              break;
            case 4:
              invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
              break;
            case 5:
              invert = x * y % 2 + x * y % 3 === 0;
              break;
            case 6:
              invert = (x * y % 2 + x * y % 3) % 2 === 0;
              break;
            case 7:
              invert = ((x + y) % 2 + x * y % 3) % 2 === 0;
              break;
            default:
              throw new Error(`invalid mask ${mask}`);
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
    penaltyScore() {
      const b = this.scoreBreakdown();
      return b[0] + b[1] + b[2] + b[3];
    }
    scoreBreakdown() {
      const size = this.size;
      const m = this.modules;
      const bit = (y, x) => m[y][x] ? 1 : 0;
      let n1 = 0;
      let n2 = 0;
      let n3 = 0;
      let dark = 0;
      let lastRow = null;
      for (let i = 0; i < size; i++) {
        const row = new Array(size);
        const col = new Array(size);
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
          if (rb === rowPrev) n1r++;
          else {
            if (n1r >= 5) n1 += n1r - 2;
            n1r = 1;
          }
          if (cb === colPrev) n1c++;
          else {
            if (n1c >= 5) n1 += n1c - 2;
            n1c = 1;
          }
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
      const n4 = PENALTY_N4 * Math.floor(Math.abs(dark / total * 100 - 50) / 5);
      return [n1, n2, n3, n4];
    }
    /** Count 1:1:3:1:1 finder-like patterns in one sequence (reference port). */
    n3Occurrences(seq) {
      const size = this.size;
      const anyDark = (lo, hi) => {
        for (let k = Math.max(lo, 0); k < Math.min(hi, size); k++) {
          if (seq[k]) return true;
        }
        return false;
      };
      const findPattern = (start) => {
        for (let idx2 = start; idx2 <= size - 7; idx2++) {
          if (seq[idx2] === 1 && seq[idx2 + 1] === 0 && seq[idx2 + 2] === 1 && seq[idx2 + 3] === 1 && seq[idx2 + 4] === 1 && seq[idx2 + 5] === 0 && seq[idx2 + 6] === 1) {
            return idx2;
          }
        }
        return -1;
      };
      let count = 0;
      let idx = findPattern(0);
      while (idx !== -1) {
        let offset = idx + 7;
        if (idx === 0 || idx === size - 7 || !anyDark(idx - 4, idx) || !anyDark(offset, offset + 4)) {
          count += PENALTY_N3;
        } else {
          offset = idx + 4;
        }
        idx = findPattern(offset);
      }
      return count;
    }
  };
  function encodeQr(text, opts = {}) {
    const ecc = opts.ecc ?? "M";
    const minVer = Math.max(MIN_VERSION, opts.minVersion ?? MIN_VERSION);
    const maxVer = Math.min(MAX_VERSION, opts.maxVersion ?? MAX_VERSION);
    if (minVer > maxVer) throw new Error("minVersion exceeds maxVersion");
    const bytes = utf8Bytes(text);
    const ver = chooseVersion(bytes.length, ecc, minVer, maxVer);
    const dataCw = buildDataCodewords(bytes, ver, ecc);
    const allCw = addEccAndInterleave(dataCw, ver, ecc);
    const build = (mask) => {
      const mtx2 = new Matrix(ver);
      mtx2.drawFunctionPatterns(ver);
      mtx2.drawCodewords(allCw);
      mtx2.applyMask(mask);
      return mtx2;
    };
    let chosenMask = opts.mask;
    let mtx;
    if (chosenMask === void 0) {
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
    mtx.drawFormatBits(ecc, chosenMask);
    if (ver >= 7) mtx.drawVersion(ver);
    return {
      version: ver,
      size: mtx.size,
      ecc,
      mask: chosenMask,
      modules: mtx.modules
    };
  }

  // src/main/supvan/mono.ts
  var MonoCanvas = class {
    width;
    height;
    /** One byte per pixel (0 or 1), row-major. Simple and fast to address. */
    px;
    constructor(width, height) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`MonoCanvas: invalid size ${width}x${height}`);
      }
      this.width = width;
      this.height = height;
      this.px = new Uint8Array(width * height);
    }
    inBounds(x, y) {
      return x >= 0 && x < this.width && y >= 0 && y < this.height;
    }
    get(x, y) {
      return this.inBounds(x, y) && this.px[y * this.width + x] !== 0;
    }
    /** Set a single pixel; out-of-bounds is a no-op. */
    set(x, y, dark = true) {
      if (this.inBounds(x, y)) this.px[y * this.width + x] = dark ? 1 : 0;
    }
    /** Fill the whole canvas (default: clear to light). */
    clear(dark = false) {
      this.px.fill(dark ? 1 : 0);
    }
    /** Filled rectangle. Negative origins / oversize extents are clipped. */
    fillRect(x, y, w, h, dark = true) {
      const x0 = Math.max(0, x);
      const y0 = Math.max(0, y);
      const x1 = Math.min(this.width, x + w);
      const y1 = Math.min(this.height, y + h);
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * this.width;
        this.px.fill(dark ? 1 : 0, row + x0, row + x1);
      }
    }
    /** Rectangle outline of the given border thickness (drawn inward). */
    strokeRect(x, y, w, h, dark = true, thickness = 1) {
      const t = Math.max(1, Math.min(thickness, Math.ceil(Math.min(w, h) / 2)));
      this.fillRect(x, y, w, t, dark);
      this.fillRect(x, y + h - t, w, t, dark);
      this.fillRect(x, y, t, h, dark);
      this.fillRect(x + w - t, y, t, h, dark);
    }
    /**
     * Blit a boolean module matrix (e.g. a QR symbol's `modules`) at (x, y),
     * enlarging every module to a `scale`×`scale` block. `matrix[row][col]` maps
     * to canvas (x + col*scale, y + row*scale). Only dark modules draw, so an
     * existing light background is preserved (caller places the quiet zone).
     */
    blitMatrix(matrix, x, y, scale = 1) {
      if (scale < 1) throw new Error(`MonoCanvas.blitMatrix: scale must be >= 1 (got ${scale})`);
      for (let row = 0; row < matrix.length; row++) {
        const line = matrix[row];
        for (let col = 0; col < line.length; col++) {
          if (line[col]) this.fillRect(x + col * scale, y + row * scale, scale, scale, true);
        }
      }
    }
    /**
     * Blit a packed 1bpp glyph (row-major, MSB-first, `glyphW` px wide) at (x, y),
     * scaling each source pixel to a `scale`×`scale` block. Dark source bits draw
     * dark; light bits are skipped (transparent), so glyphs compose over any
     * background. This is the primitive the bitmap font renders through.
     */
    blitGlyph(glyph, glyphW, glyphH, x, y, scale = 1) {
      if (scale < 1) throw new Error(`MonoCanvas.blitGlyph: scale must be >= 1 (got ${scale})`);
      const bpl = Math.ceil(glyphW / 8);
      for (let gy = 0; gy < glyphH; gy++) {
        for (let gx = 0; gx < glyphW; gx++) {
          const byte = glyph[gy * bpl + (gx >> 3)];
          if (byte === void 0) continue;
          if (byte >> 7 - (gx & 7) & 1) {
            this.fillRect(x + gx * scale, y + gy * scale, scale, scale, true);
          }
        }
      }
    }
    /** Pack to a row-major MSB-first 1bpp bitmap (dark = 1). */
    toBitmap() {
      const bpl = Math.ceil(this.width / 8);
      const data = new Uint8Array(bpl * this.height);
      for (let y = 0; y < this.height; y++) {
        const rowIn = y * this.width;
        const rowOut = y * bpl;
        for (let x = 0; x < this.width; x++) {
          if (this.px[rowIn + x]) data[rowOut + (x >> 3)] |= 128 >> (x & 7);
        }
      }
      return { data, width: this.width, height: this.height, bytesPerLine: bpl };
    }
    /** Debug/preview helper: render as ASCII art (`#` dark, space light). */
    toAsciiArt(darkChar = "#", lightChar = " ") {
      const lines = [];
      for (let y = 0; y < this.height; y++) {
        let line = "";
        for (let x = 0; x < this.width; x++) line += this.px[y * this.width + x] ? darkChar : lightChar;
        lines.push(line);
      }
      return lines.join("\n");
    }
  };

  // src/main/supvan/font.ts
  var GLYPH_W = 5;
  var GLYPH_H = 7;
  var GLYPH_ROWS = {
    " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
    "J": ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
    "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["10001", "10001", "11001", "10101", "10011", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
    "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
    "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
    "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
    '"': ["01010", "01010", "01010", "00000", "00000", "00000", "00000"],
    "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
    "$": ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
    "%": ["11000", "11001", "00010", "00100", "01000", "10011", "00011"],
    "&": ["01100", "10010", "10100", "01000", "10101", "10010", "01101"],
    "'": ["00100", "00100", "00100", "00000", "00000", "00000", "00000"],
    "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
    ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
    "*": ["00000", "00100", "10101", "01110", "10101", "00100", "00000"],
    "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
    ",": ["00000", "00000", "00000", "00000", "00100", "00100", "01000"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
    "/": ["00001", "00010", "00100", "00100", "00100", "01000", "10000"],
    ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
    ";": ["00000", "01100", "01100", "00000", "01100", "00100", "01000"],
    "=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
    "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
    "@": ["01110", "10001", "10111", "10101", "10111", "10000", "01110"],
    "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
    "\xB7": ["00000", "00000", "00000", "00100", "00000", "00000", "00000"]
    // U+00B7 middot separator
  };
  var FALLBACK = "?";
  var PACKED = /* @__PURE__ */ new Map();
  function packGlyph(rows) {
    const bpl = Math.ceil(GLYPH_W / 8);
    const out = new Uint8Array(bpl * GLYPH_H);
    for (let y = 0; y < GLYPH_H; y++) {
      const row = rows[y];
      for (let x = 0; x < GLYPH_W; x++) {
        if (row[x] === "1") out[y * bpl + (x >> 3)] |= 128 >> (x & 7);
      }
    }
    return out;
  }
  for (const [ch, rows] of Object.entries(GLYPH_ROWS)) PACKED.set(ch, packGlyph(rows));
  function normalizeChar(ch) {
    if (PACKED.has(ch)) return ch;
    const stripped = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (PACKED.has(stripped)) return stripped;
    const upper = stripped.toUpperCase();
    if (PACKED.has(upper)) return upper;
    return FALLBACK;
  }
  var DEFAULT_SCALE = 2;
  var DEFAULT_SPACING = 1;
  function chars(text) {
    return Array.from(text);
  }
  function measureText(text, opts = {}) {
    const scale = opts.scale ?? DEFAULT_SCALE;
    const spacing = opts.letterSpacing ?? DEFAULT_SPACING;
    const n = chars(text).length;
    if (n === 0) return { width: 0, height: GLYPH_H * scale };
    const width = (n * GLYPH_W + (n - 1) * spacing) * scale;
    return { width, height: GLYPH_H * scale };
  }
  function drawText(canvas, text, x, y, opts = {}) {
    const scale = opts.scale ?? DEFAULT_SCALE;
    const spacing = opts.letterSpacing ?? DEFAULT_SPACING;
    let cursor = x;
    for (const ch of chars(text)) {
      const glyph = PACKED.get(normalizeChar(ch));
      canvas.blitGlyph(glyph, GLYPH_W, GLYPH_H, cursor, y, scale);
      cursor += (GLYPH_W + spacing) * scale;
    }
    const n = chars(text).length;
    return n === 0 ? 0 : cursor - x - spacing * scale;
  }

  // src/main/supvan/constants.ts
  var DOTS_PER_MM = 8;
  var PRINTHEAD_WIDTH_MM = 48;
  var PRINTHEAD_WIDTH_DOTS = PRINTHEAD_WIDTH_MM * DOTS_PER_MM;
  var PRINTHEAD_BYTES_PER_LINE = PRINTHEAD_WIDTH_DOTS / 8;

  // src/main/supvan/label.ts
  var DEF = {
    qrEcc: "M",
    qrScale: 3,
    qrQuiet: 4,
    textScale: 2,
    letterSpacing: 1,
    lineGap: 2,
    gap: 6,
    padding: 2
  };
  function renderLabel(model, style = {}) {
    const qrEcc = style.qrEcc ?? DEF.qrEcc;
    const qrScale = style.qrScale ?? DEF.qrScale;
    const quiet = style.qrQuiet ?? DEF.qrQuiet;
    const textScale = style.textScale ?? DEF.textScale;
    const letterSpacing = style.letterSpacing ?? DEF.letterSpacing;
    const lineGap = style.lineGap ?? DEF.lineGap;
    const gap = style.gap ?? DEF.gap;
    const padding = style.padding ?? DEF.padding;
    if (qrScale < 1) throw new Error(`renderLabel: qrScale must be >= 1 (got ${qrScale})`);
    const qr = encodeQr(model.qr, { ecc: qrEcc });
    const qrBlockPx = (qr.size + 2 * quiet) * qrScale;
    const lines = model.lines ?? [];
    const lineHeight = GLYPH_H * textScale;
    const textBlockWidth = lines.reduce(
      (w, ln) => Math.max(w, measureText(ln, { scale: textScale, letterSpacing }).width),
      0
    );
    const textBlockHeight = lines.length === 0 ? 0 : lines.length * lineHeight + (lines.length - 1) * lineGap;
    const hasText = lines.length > 0 && textBlockWidth > 0;
    const contentHeight = Math.max(qrBlockPx, textBlockHeight);
    const width = padding + qrBlockPx + (hasText ? gap + textBlockWidth : 0) + padding;
    const height = padding + contentHeight + padding;
    const canvas = new MonoCanvas(width, height);
    const qrX = padding;
    const qrY = padding + Math.floor((contentHeight - qrBlockPx) / 2);
    canvas.blitMatrix(qr.modules, qrX + quiet * qrScale, qrY + quiet * qrScale, qrScale);
    if (hasText) {
      const textX = padding + qrBlockPx + gap;
      const textTop = padding + Math.floor((contentHeight - textBlockHeight) / 2);
      for (let i = 0; i < lines.length; i++) {
        const y = textTop + i * (lineHeight + lineGap);
        drawText(canvas, lines[i], textX, y, { scale: textScale, letterSpacing });
      }
    }
    return {
      canvas,
      bitmap: canvas.toBitmap(),
      width,
      height,
      qr,
      qrBlock: { x: qrX, y: qrY, size: qrBlockPx, scale: qrScale, quiet }
    };
  }
  function bitAt(bmp, x, y) {
    return (bmp.data[y * bmp.bytesPerLine + (x >> 3)] >> 7 - (x & 7) & 1) !== 0;
  }
  function rotateBitmap90(bmp, quarterTurns = 1) {
    const k = (Math.trunc(quarterTurns) % 4 + 4) % 4;
    if (k === 0) return bmp;
    const { width: w, height: h } = bmp;
    const nw = k === 2 ? w : h;
    const nh = k === 2 ? h : w;
    const out = new MonoCanvas(nw, nh);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!bitAt(bmp, x, y)) continue;
        let nx;
        let ny;
        if (k === 1) {
          nx = h - 1 - y;
          ny = x;
        } else if (k === 2) {
          nx = w - 1 - x;
          ny = h - 1 - y;
        } else {
          nx = y;
          ny = w - 1 - x;
        }
        out.set(nx, ny, true);
      }
    }
    return out.toBitmap();
  }

  // src/main/supvan/preview/preview-entry.ts
  var $ = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el;
  };
  var num = (id) => Number($(id).value);
  var str = (id) => $(id).value;
  var bitAt2 = (bmp, x, y) => (bmp.data[y * bmp.bytesPerLine + (x >> 3)] >> 7 - (x & 7) & 1) !== 0;
  function paint(canvas, bmp, zoom, bandWidth = bmp.width) {
    const xOff = Math.floor((bandWidth - bmp.width) / 2);
    canvas.width = bandWidth * zoom;
    canvas.height = bmp.height * zoom;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f7f4ec";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#141414";
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < bmp.width; x++) {
        if (bitAt2(bmp, x, y)) ctx.fillRect((xOff + x) * zoom, y * zoom, zoom, zoom);
      }
    }
    if (bandWidth > bmp.width) {
      ctx.strokeStyle = "#c9c2b0";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
    }
  }
  function render() {
    const lines = str("lines").split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
    let r;
    try {
      r = renderLabel(
        { qr: str("qr"), lines },
        {
          qrEcc: str("ecc"),
          qrScale: num("qrScale"),
          qrQuiet: num("quiet"),
          textScale: num("textScale"),
          lineGap: num("lineGap"),
          gap: num("gap"),
          padding: num("padding")
        }
      );
    } catch (e) {
      $("meta").textContent = `render error: ${e.message}`;
      return;
    }
    const zoom = num("zoom");
    const quarterTurns = num("rotate");
    const printhead = num("printhead");
    const marginTop = 8;
    const marginBottom = 8;
    paint($("natural"), r.bitmap, zoom);
    const rot = rotateBitmap90(r.bitmap, quarterTurns);
    const band = Math.max(printhead, rot.width);
    const withMargins = {
      // Reuse rot's rows, but present a taller image with blank feed margins.
      data: (() => {
        const bpl = rot.bytesPerLine;
        const out = new Uint8Array(bpl * (rot.height + marginTop + marginBottom));
        out.set(rot.data, marginTop * bpl);
        return out;
      })(),
      width: rot.width,
      height: rot.height + marginTop + marginBottom,
      bytesPerLine: rot.bytesPerLine
    };
    paint($("print"), withMargins, zoom, band);
    const fits = rot.width <= printhead;
    $("meta").innerHTML = `<b>QR</b> v${r.qr.version} \xB7 ${r.qr.size}\xD7${r.qr.size} modules \xB7 ecc ${r.qr.ecc} \xB7 mask ${r.qr.mask} &nbsp;|&nbsp; <b>image</b> ${r.width}\xD7${r.height} dots &nbsp;|&nbsp; <b>across tape</b> ${rot.width} dots ` + (fits ? `<span style="color:#2b7a2b">\u2713 fits ${printhead}</span>` : `<span style="color:#c02626">\u2717 overflows ${printhead}</span>`);
  }
  for (const id of [
    "qr",
    "lines",
    "ecc",
    "qrScale",
    "textScale",
    "quiet",
    "gap",
    "padding",
    "lineGap",
    "zoom",
    "rotate",
    "printhead"
  ]) {
    $(id).addEventListener("input", render);
  }
  render();
})();
