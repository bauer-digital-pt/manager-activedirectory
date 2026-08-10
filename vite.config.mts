import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron";
import renderer from "vite-plugin-electron-renderer";

export default defineConfig({
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
          },
        },
      },
      {
        entry: "src/preload/preload.ts",
        vite: {
          build: {
            outDir: "dist-electron",
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
