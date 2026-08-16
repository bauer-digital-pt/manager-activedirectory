// App preferences (dev mode, login timeout, remembered username).
//
// In Electron these persist to settings.json via the main process. In the
// browser (dev/mock) they fall back to localStorage so the UI still works.
import type { AppSettings } from "../../../shared/types";

export type { AppSettings } from "../../../shared/types";

export const DEFAULT_SETTINGS: AppSettings = {
  devMode: false,
  loginTimeoutMin: 30,
  lastUsername: "",
  kioskMode: false,
};

const LS_KEY = "admanager.settings";

function clampTimeout(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_SETTINGS.loginTimeoutMin;
  return Math.min(60, Math.max(5, Math.round(v)));
}

function normalize(raw: Partial<AppSettings> | null | undefined): AppSettings {
  return {
    devMode: !!raw?.devMode,
    loginTimeoutMin: clampTimeout(raw?.loginTimeoutMin),
    lastUsername: typeof raw?.lastUsername === "string" ? raw.lastUsername : "",
    kioskMode: !!raw?.kioskMode,
  };
}

export async function getSettings(): Promise<AppSettings> {
  try {
    if (window.configAPI?.getSettings) {
      return normalize(await window.configAPI.getSettings());
    }
    const stored = localStorage.getItem(LS_KEY);
    if (stored) return normalize(JSON.parse(stored));
  } catch { /* fall through */ }
  return { ...DEFAULT_SETTINGS };
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  if (window.configAPI?.setSettings) {
    return normalize(await window.configAPI.setSettings(patch));
  }
  const current = await getSettings();
  const next = normalize({ ...current, ...patch });
  localStorage.setItem(LS_KEY, JSON.stringify(next));
  return next;
}
