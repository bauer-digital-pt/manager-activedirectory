// Remote AD connection settings.
//
// In Electron the password is stored encrypted by the main process and is never
// read back into the renderer — getConnection() only reports whether a password
// is set. In the browser (dev/mock) everything falls back to localStorage.

export interface ConnectionInfo {
  server: string;
  username: string;
  hasPassword: boolean;
}

export interface ConnectionPayload {
  server: string;
  username: string;
  password?: string; // omit to keep the stored password, "" to clear it
}

export interface ConnectionTestResult {
  ok: boolean;
  data?: { domain?: string; forest?: string; dc?: string };
  error?: string;
}

const LS_KEY = "admanager.connection";

// Default domain controller (domain: bmap.lis). Kept in sync with DEFAULT_DC in
// the main process — mirrored here only for the browser (dev/mock) fallback.
const DEFAULT_DC = "10.4.0.12";

// window.configAPI is declared globally in groupsConfig.ts.

export async function getConnection(): Promise<ConnectionInfo> {
  try {
    if (window.configAPI?.getConnection) {
      return await window.configAPI.getConnection();
    }
    const stored = localStorage.getItem(LS_KEY);
    if (stored) {
      const raw = JSON.parse(stored);
      return { server: raw.server || DEFAULT_DC, username: raw.username ?? "", hasPassword: !!raw.password };
    }
  } catch { /* fall through */ }
  return { server: DEFAULT_DC, username: "", hasPassword: false };
}

export async function setConnection(payload: ConnectionPayload): Promise<void> {
  if (window.configAPI?.setConnection) {
    return window.configAPI.setConnection(payload);
  }
  // Browser mock — persist to localStorage (password kept in clear only in dev).
  const stored = localStorage.getItem(LS_KEY);
  const current = stored ? JSON.parse(stored) : {};
  const next = {
    server: payload.server ?? "",
    username: payload.username ?? "",
    password: payload.password === undefined ? (current.password ?? "") : payload.password,
  };
  localStorage.setItem(LS_KEY, JSON.stringify(next));
}
