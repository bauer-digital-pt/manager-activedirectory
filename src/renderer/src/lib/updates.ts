// Auto-update bridge (electron-updater in the main process).
// In the browser (dev/mock) window.updatesAPI is absent, so the helpers no-op.

export type UpdateStatus =
  | { state: "none" }
  | { state: "available"; version?: string }
  | { state: "downloading"; percent?: number }
  | { state: "downloaded"; version?: string }
  | { state: "error"; message?: string };

declare global {
  interface Window {
    updatesAPI?: {
      check(): Promise<{ ok: boolean; version?: string; error?: string }>;
      download(): Promise<{ ok: boolean; error?: string }>;
      install(): Promise<void>;
      onStatus(cb: (status: UpdateStatus) => void): () => void;
    };
  }
}

// Browser preview only: with ?update (or ?updateerror) simulate a download so the
// UpdateAvailable screen can be verified without a packaged build.
function simulateUpdate(cb: (status: UpdateStatus) => void): () => void {
  const params = new URLSearchParams(location.search);
  if (!params.has("update") && !params.has("updateerror")) return () => {};
  cb({ state: "available", version: "1.1.0" });
  let percent = 0;
  const id = window.setInterval(() => {
    percent += 7;
    if (percent < 100) { cb({ state: "downloading", percent }); return; }
    window.clearInterval(id);
    if (params.has("updateerror")) cb({ state: "error", message: "Falha na ligação ao GitHub (simulação)." });
    else cb({ state: "downloaded", version: "1.1.0" });
  }, 220);
  return () => window.clearInterval(id);
}

export const updatesAPI = {
  check: () => window.updatesAPI?.check() ?? Promise.resolve({ ok: false, error: "unavailable" }),
  download: () => window.updatesAPI?.download() ?? Promise.resolve({ ok: false, error: "unavailable" }),
  install: () => window.updatesAPI?.install() ?? Promise.resolve(),
  onStatus: (cb: (status: UpdateStatus) => void) =>
    window.updatesAPI?.onStatus(cb) ?? simulateUpdate(cb),
};

// App version for the General settings panel. Falls back to a dev placeholder
// in the browser preview where appAPI is absent.
export async function getAppVersion(): Promise<string> {
  try {
    if (window.appAPI?.getVersion) return await window.appAPI.getVersion();
  } catch { /* ignore */ }
  return "dev";
}
