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
      install(): Promise<void>;
      onStatus(cb: (status: UpdateStatus) => void): () => void;
    };
  }
}

export const updatesAPI = {
  check: () => window.updatesAPI?.check() ?? Promise.resolve({ ok: false, error: "unavailable" }),
  install: () => window.updatesAPI?.install() ?? Promise.resolve(),
  onStatus: (cb: (status: UpdateStatus) => void) => window.updatesAPI?.onStatus(cb) ?? (() => {}),
};
