import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron";
import renderer from "vite-plugin-electron-renderer";

export default defineConfig({
  build: {
    // Electron 32 ships Chromium 128 — target it so the renderer bundle isn't
    // needlessly down-levelled (async/await, optional chaining and nullish
    // coalescing all ship as-is instead of being transpiled + polyfilled). This
    // only affects the renderer build; the electron() entries below set their
    // own Node target for the main/preload bundles.
    target: "chrome128",
  },
  plugins: [
    react(),
    // Tailwind v4 is a Vite plugin — without it, index.css ships with its
    // `@import "tailwindcss"` and every `@apply` uncompiled, so the packaged
    // app renders with no styles at all. The browser dev config already has it.
    tailwindcss(),
    electron([
      {
        entry: "src/main/main.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            // Main/preload run on Electron 32's bundled Node 20 — target it
            // explicitly so these don't inherit the renderer's chrome128 target.
            target: "node20",
          },
        },
      },
      {
        entry: "src/preload/preload.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            // Main/preload run on Electron 32's bundled Node 20 — target it
            // explicitly so these don't inherit the renderer's chrome128 target.
            target: "node20",
          },
        },
        onstart(options) {
          options.reload();
        },
      },
    ]),
    renderer(),
  ],
});
