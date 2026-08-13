import { BrowserWindow } from "electron";

// Central activity log for the whole app. Everything the main process does —
// IPC calls, PowerShell runs, window/network load events, auto-update and RSAT
// install progress, and errors reported from the renderer — is normalized into
// one AppLogEntry stream. Entries are kept in a ring buffer so the Console page
// can back-fill everything that happened *before* the user opened it (startup
// module check, group load, etc.), then follow live via the "console:log" push.

export type LogLevel = "debug" | "info" | "success" | "warn" | "error";

export interface AppLogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  source: string;   // "app" | "window" | "net" | "ipc" | "ps" | "updater" | "rsat" | "renderer"
  label: string;    // short title: channel, script, event name
  detail?: string;  // one-line human message
  data?: unknown;   // structured payload (args, result, stdout/stderr, stack…)
  durationMs?: number;
  mocked?: boolean;
}

const BUFFER_MAX = 3000;
const buffer: AppLogEntry[] = [];
let seq = 0;

export function getHistory(): AppLogEntry[] {
  return buffer;
}

export function clearHistory(): void {
  buffer.length = 0;
}

export function pushLog(partial: Omit<AppLogEntry, "id" | "ts"> & { ts?: number }): AppLogEntry {
  const entry: AppLogEntry = {
    id: `${Date.now().toString(36)}-${(seq++).toString(36)}`,
    ts: partial.ts ?? Date.now(),
    level: partial.level,
    source: partial.source,
    label: partial.label,
    detail: partial.detail,
    data: partial.data,
    durationMs: partial.durationMs,
    mocked: partial.mocked,
  };
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX);
  // Fan the live entry out to every open window — the main app window AND the
  // detached Console window (Ctrl+Shift+C). Each renderer that cares subscribes
  // via console:log; those that don't (e.g. the Agent's wizard) simply ignore it.
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try { w.webContents.send("console:log", entry); } catch { /* window tearing down */ }
  }
  return entry;
}

// ── Secret redaction ────────────────────────────────────────────────────────
// Nothing that reaches the log may contain a plaintext password. Objects are
// masked by key name; positional PowerShell args are masked by script + index.
const SECRET_KEY = /pass(word)?|secret|token|credential/i;
const REDACTED = "‹redacted›";

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

// PowerShell scripts take secrets as positional args (no key to match on).
const PS_SECRET_ARGS: Record<string, number[]> = {
  "New-ADUser.ps1": [3],       // password
  "Reset-ADPassword.ps1": [1], // newPassword
};

export function redactPsArgs(script: string, args: string[]): string[] {
  const secret = PS_SECRET_ARGS[script];
  if (!secret) return args;
  return args.map((a, i) => (secret.includes(i) && a ? REDACTED : a));
}

export function truncate(s: string, max = 20000): string {
  return s.length > max ? `${s.slice(0, max)}\n…(${s.length - max} more chars)` : s;
}
