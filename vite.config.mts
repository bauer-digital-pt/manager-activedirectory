import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron";
import renderer from "vite-plugin-electron-renderer";

// One codebase → two installers. APP_FLAVOR (manager|agent) is baked into every
// bundle via `__APP_FLAVOR__`, read by src/shared/flavor.ts. Unset defaults to
// "manager". Each of the main/preload electron entries gets its OWN Vite build,
// so the define must be repeated per entry (they don't inherit the top-level one).
const APP_FLAVOR = process.env.APP_FLAVOR === "agent" ? "agent" : "manager";
const flavorDefine = { __APP_FLAVOR__: JSON.stringify(APP_FLAVOR) };

export default defineConfig({
  define: flavorDefine,
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
          define: flavorDefine,
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
          define: flavorDefine,
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
