import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Browser preview defaults to the Manager flavor. Either UI can be previewed from
// this one dev server via a `?flavor=agent` query param (see lib/flavor.ts), so
// no per-flavor build is needed just to look at the interface.
const APP_FLAVOR = process.env.APP_FLAVOR === "agent" ? "agent" : "manager";

export default defineConfig({
  define: { __APP_FLAVOR__: JSON.stringify(APP_FLAVOR) },
  // Mirror the production renderer target (Electron 32 = Chromium 128) so a
  // browser-preview build behaves like the packaged app.
  build: { target: "chrome128" },
  plugins: [react(), tailwindcss()],
  root: ".",
});
