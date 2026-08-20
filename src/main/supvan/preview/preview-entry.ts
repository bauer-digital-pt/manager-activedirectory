/**
 * SUPVAN label preview — a standalone, dependency-free dogfood tool for Phase 2.
 *
 * It imports the REAL `renderLabel` pipeline (the same pure code that runs in the
 * print path and in `node --test`) and paints the resulting 1bpp bitmap onto a
 * DOM canvas, so we can eyeball layout, QR scale, text fit, and print-orientation
 * centering on real content BEFORE any hardware exists. It touches none of the
 * app's files — bundle it with esbuild and open it in a browser (see README).
 *
 * This is NOT wired into the Electron app; the in-app action is Phase 4.
 */
import { renderLabel, rotateBitmap90, type LabelRender } from "../label.ts";
import type { MonoBitmap } from "../mono.ts";
import type { Ecc } from "../qr.ts";

// --- tiny DOM helpers --------------------------------------------------------
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};
const num = (id: string): number => Number(($(id) as HTMLInputElement).value);
const str = (id: string): string => ($(id) as HTMLInputElement).value;

/** Read a pixel from a row-major MSB-first bitmap (dark = 1). */
const bitAt = (bmp: MonoBitmap, x: number, y: number): boolean =>
  ((bmp.data[y * bmp.bytesPerLine + (x >> 3)] >> (7 - (x & 7))) & 1) !== 0;

/** Paint a MonoBitmap onto a canvas at integer `zoom`, optionally on a wider band. */
function paint(
  canvas: HTMLCanvasElement,
  bmp: MonoBitmap,
  zoom: number,
  bandWidth: number = bmp.width,
): void {
  const xOff = Math.floor((bandWidth - bmp.width) / 2);
  canvas.width = bandWidth * zoom;
  canvas.height = bmp.height * zoom;
  const ctx = canvas.getContext("2d")!;
  // Light tape.
  ctx.fillStyle = "#f7f4ec";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Dark dots.
  ctx.fillStyle = "#141414";
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      if (bitAt(bmp, x, y)) ctx.fillRect((xOff + x) * zoom, y * zoom, zoom, zoom);
    }
  }
  // Faint band edges when the label is narrower than the tape.
  if (bandWidth > bmp.width) {
    ctx.strokeStyle = "#c9c2b0";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
  }
}

function render(): void {
  const lines = str("lines")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  let r: LabelRender;
  try {
    r = renderLabel(
      { qr: str("qr"), lines },
      {
        qrEcc: str("ecc") as Ecc,
        qrScale: num("qrScale"),
        qrQuiet: num("quiet"),
        textScale: num("textScale"),
        lineGap: num("lineGap"),
        gap: num("gap"),
        padding: num("padding"),
      },
    );
  } catch (e) {
    $("meta").textContent = `render error: ${(e as Error).message}`;
    return;
  }

  const zoom = num("zoom");
  const quarterTurns = num("rotate");
  const printhead = num("printhead");
  const marginTop = 8;
  const marginBottom = 8;

  // Natural reading orientation.
  paint($<HTMLCanvasElement>("natural"), r.bitmap, zoom);

  // Print orientation: rotate, then center in a printhead-width band with the
  // blank feed margins the job builder adds.
  const rot = rotateBitmap90(r.bitmap, quarterTurns);
  const band = Math.max(printhead, rot.width);
  const withMargins: MonoBitmap = {
    // Reuse rot's rows, but present a taller image with blank feed margins.
    data: (() => {
      const bpl = rot.bytesPerLine;
      const out = new Uint8Array(bpl * (rot.height + marginTop + marginBottom));
      out.set(rot.data, marginTop * bpl);
      return out;
    })(),
    width: rot.width,
    height: rot.height + marginTop + marginBottom,
    bytesPerLine: rot.bytesPerLine,
  };
  paint($<HTMLCanvasElement>("print"), withMargins, zoom, band);

  const fits = rot.width <= printhead;
  $("meta").innerHTML =
    `<b>QR</b> v${r.qr.version} · ${r.qr.size}×${r.qr.size} modules · ecc ${r.qr.ecc} · mask ${r.qr.mask}` +
    ` &nbsp;|&nbsp; <b>image</b> ${r.width}×${r.height} dots` +
    ` &nbsp;|&nbsp; <b>across tape</b> ${rot.width} dots ` +
    (fits
      ? `<span style="color:#2b7a2b">✓ fits ${printhead}</span>`
      : `<span style="color:#c02626">✗ overflows ${printhead}</span>`);
}

// Debounced re-render on any input.
for (const id of [
  "qr", "lines", "ecc", "qrScale", "textScale", "quiet", "gap", "padding", "lineGap", "zoom", "rotate", "printhead",
]) {
  $(id).addEventListener("input", render);
}
render();
