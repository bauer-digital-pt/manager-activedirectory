/**
 * Baked brand mark for asset labels — the Bauer Media "B" play-mark, the same
 * symbol shown in the app sidebar (assets/logo_1.png), reduced to 1bpp.
 *
 * WHY baked, not decoded at runtime: renderLabel must stay pure and dependency-
 * free so the exact same bytes render in the Electron main process, in
 * `node --test`, and in the renderer preview. Node has no built-in PNG decoder
 * and the browser's is DOM-coupled, so the mark is pre-rasterised here as a
 * packed 1bpp bitmap. Only the purple play-mark survives the threshold — the
 * teal triangle field is light and drops out, which is exactly what we want on
 * a monochrome thermal label. Regenerate with tools/gen-brand-mark.mjs if the
 * source logo changes (target height 64 dots, keeps aspect).
 *
 * Format matches MonoBitmap: row-major, MSB-first, 1bpp packed (dark = 1).
 */
import type { MonoBitmap } from "./mono.ts";

const WIDTH = 61;
const HEIGHT = 64;
const BYTES_PER_LINE = 8; // ceil(61 / 8)

// Packed pixels (hex). Decoded portably (no Buffer/atob) so it loads anywhere.
const HEX =
  "0007ffffffc00000000ffffffff80000000fffffffff0000000fffffffff8000001fffffffffc000001fffffffffe000001fc000003ff000001fc000000ff800001fc0000007f8007e1fc0000001fc00ff9fc0000001fc00ffdfc0000000fe00ffffc0000000fe00ffffc00000007e00ffffc00000007e00ffffc00000007e00fdffe00000007e00fc7ff00000007e00fc3ffc0000007e00fc1fff0000007e00fc1fffc00000fe00fc1fffe00000fe00fc1ffff80000fc00fc1fdffe0001fc00fc1fc7ff8003f800fc1fc1ffe003f800fc1fc07ff00ff000fc1fc03ff80fe000fc1fc00ff81fe000fc1fc00ff81ff000fc1fc01ff80ffc00fc1fc07ff007fe00fc1fc1ffe003ff00fc1fc7ff8000ff80fc1fdffe00007fc0fc1ffffc00003fc0fc1ffff000001fe0fc1fffc000000fe0fc1fff80000007f0fc1ffe00000007f0fc1ff800000003f0fc0fe000000003f8fc0f8000000001f8fc070000000001f8fc000000000001f8fc000000000001f8fc000000000001f8fc000000000001f878000000000001f800000000000003f800000000000003f000000000000007f000000000000007f00000000000000fe00000000000001fe00000000000003fc0000000000000ff80000000000007ff800007ffffffffff00000ffffffffffc00000ffffffffff800000fffffffffe000000fffffffff80000007fffffffc0000";

function decodeHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** The Bauer Media "B" play-mark as a 1bpp bitmap (61×64 dots, dark = 1). */
export const BAUER_B_MARK: MonoBitmap = {
  data: decodeHex(HEX),
  width: WIDTH,
  height: HEIGHT,
  bytesPerLine: BYTES_PER_LINE,
};
