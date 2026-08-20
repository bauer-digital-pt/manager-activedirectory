/**
 * MonoCanvas — a 1-bit-per-pixel drawing surface for composing label images.
 *
 * A dark pixel (thermal dot fired) is `true`. The canvas is framework-free (no
 * DOM `<canvas>`, no deps), so the exact same rendering runs in the Electron
 * main process, in `node --test`, and in the renderer preview — a label looks
 * identical wherever it is drawn.
 *
 * `toBitmap()` yields a row-major, MSB-first, 1bpp packed bitmap (dark bit = 1)
 * which is precisely the input `repackToCanvas()` → `buildJobFromColumnMajor()`
 * expect. Coordinates are (x = across the tape, y = along the feed); origin is
 * top-left; out-of-bounds writes are silently clipped.
 */

export interface MonoBitmap {
  /** Row-major, MSB-first, 1bpp packed pixels; dark = 1. */
  data: Uint8Array;
  width: number;
  height: number;
  /** Bytes per row = ceil(width / 8). */
  bytesPerLine: number;
}

export class MonoCanvas {
  readonly width: number;
  readonly height: number;
  /** One byte per pixel (0 or 1), row-major. Simple and fast to address. */
  private readonly px: Uint8Array;

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error(`MonoCanvas: invalid size ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.px = new Uint8Array(width * height);
  }

  inBounds(x: number, y: number): boolean {
    // Integer-strict: a fractional coordinate addresses no pixel, so both get()
    // and set() treat it as out of bounds (get → light, set → no-op). Without
    // this, get(2.5, y) would index px[…+2.5] === undefined and read as dark.
    return (
      Number.isInteger(x) && Number.isInteger(y) &&
      x >= 0 && x < this.width && y >= 0 && y < this.height
    );
  }

  get(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.px[y * this.width + x] !== 0;
  }

  /** Set a single pixel; out-of-bounds is a no-op. */
  set(x: number, y: number, dark: boolean = true): void {
    if (this.inBounds(x, y)) this.px[y * this.width + x] = dark ? 1 : 0;
  }

  /** Fill the whole canvas (default: clear to light). */
  clear(dark: boolean = false): void {
    this.px.fill(dark ? 1 : 0);
  }

  /** Filled rectangle. Negative origins / oversize extents are clipped. */
  fillRect(x: number, y: number, w: number, h: number, dark: boolean = true): void {
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
  strokeRect(
    x: number,
    y: number,
    w: number,
    h: number,
    dark: boolean = true,
    thickness: number = 1,
  ): void {
    const t = Math.max(1, Math.min(thickness, Math.ceil(Math.min(w, h) / 2)));
    this.fillRect(x, y, w, t, dark); // top
    this.fillRect(x, y + h - t, w, t, dark); // bottom
    this.fillRect(x, y, t, h, dark); // left
    this.fillRect(x + w - t, y, t, h, dark); // right
  }

  /**
   * Blit a boolean module matrix (e.g. a QR symbol's `modules`) at (x, y),
   * enlarging every module to a `scale`×`scale` block. `matrix[row][col]` maps
   * to canvas (x + col*scale, y + row*scale). Only dark modules draw, so an
   * existing light background is preserved (caller places the quiet zone).
   */
  blitMatrix(matrix: readonly (readonly boolean[])[], x: number, y: number, scale: number = 1): void {
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
  blitGlyph(
    glyph: Uint8Array,
    glyphW: number,
    glyphH: number,
    x: number,
    y: number,
    scale: number = 1,
  ): void {
    if (scale < 1) throw new Error(`MonoCanvas.blitGlyph: scale must be >= 1 (got ${scale})`);
    const bpl = Math.ceil(glyphW / 8);
    for (let gy = 0; gy < glyphH; gy++) {
      for (let gx = 0; gx < glyphW; gx++) {
        const byte = glyph[gy * bpl + (gx >> 3)];
        if (byte === undefined) continue;
        if ((byte >> (7 - (gx & 7))) & 1) {
          this.fillRect(x + gx * scale, y + gy * scale, scale, scale, true);
        }
      }
    }
  }

  /** Pack to a row-major MSB-first 1bpp bitmap (dark = 1). */
  toBitmap(): MonoBitmap {
    const bpl = Math.ceil(this.width / 8);
    const data = new Uint8Array(bpl * this.height);
    for (let y = 0; y < this.height; y++) {
      const rowIn = y * this.width;
      const rowOut = y * bpl;
      for (let x = 0; x < this.width; x++) {
        if (this.px[rowIn + x]) data[rowOut + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return { data, width: this.width, height: this.height, bytesPerLine: bpl };
  }

  /** Debug/preview helper: render as ASCII art (`#` dark, space light). */
  toAsciiArt(darkChar: string = "#", lightChar: string = " "): string {
    const lines: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let line = "";
      for (let x = 0; x < this.width; x++) line += this.px[y * this.width + x] ? darkChar : lightChar;
      lines.push(line);
    }
    return lines.join("\n");
  }
}
