import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";
import renderer from "vite-plugin-electron-renderer";

export default defineConfig({
  plugins: [
    react(),
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
