import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Mirror the production renderer target (Electron 32 = Chromium 128) so a
  // browser-preview build behaves like the packaged app.
  build: { target: "chrome128" },
  plugins: [react(), tailwindcss()],
  root: ".",
});
