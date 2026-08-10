// Renderer view of the unified activity log (mirror of src/main/logbus.ts).
export type LogLevel = "debug" | "info" | "success" | "warn" | "error";

export interface AppLogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  source: string;
  label: string;
  detail?: string;
  data?: unknown;
  durationMs?: number;
  mocked?: boolean;
}

// Report a renderer-side event into the main-process log bus (no-op if the
// bridge isn't there yet). Used for uncaught errors / rejections.
function report(e: { level: LogLevel; source: string; label: string; detail?: string; data?: unknown }) {
  try { window.consoleAPI?.report?.(e); } catch { /* bridge not ready */ }
}

let installed = false;

// Capture things the main-process console-message hook can miss (stack traces
// for uncaught errors and unhandled promise rejections) and forward them.
export function installRendererLogging(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (ev) => {
    report({
      level: "error",
      source: "renderer",
      label: "uncaught-error",
      detail: ev.message || String(ev.error ?? "erro"),
      data: { filename: ev.filename, line: ev.lineno, col: ev.colno, stack: (ev.error as Error | undefined)?.stack },
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason as { message?: string; stack?: string } | undefined;
    report({
      level: "error",
      source: "renderer",
      label: "unhandled-rejection",
      detail: String(reason?.message ?? ev.reason),
      data: { stack: reason?.stack },
    });
  });

  report({ level: "debug", source: "renderer", label: "logging-ready", detail: navigator.userAgent });
}

// ── Browser-only mock (npm run dev:browser, no Electron/preload) ─────────────
// Seeds a representative history and wires report() so the Console page is fully
// exercisable in the browser preview.
export function installConsoleBrowserMock(): void {
  if (window.consoleAPI) return;

  const listeners = new Set<(e: AppLogEntry) => void>();
  const buffer: AppLogEntry[] = [];
  let seq = 0;
  const base = Date.now();

  const push = (p: Partial<AppLogEntry>): AppLogEntry => {
    const e: AppLogEntry = {
      id: `${(p.ts ?? Date.now()).toString(36)}-${(seq++).toString(36)}`,
      ts: p.ts ?? Date.now(),
      level: p.level ?? "info",
      source: p.source ?? "app",
      label: p.label ?? "event",
      detail: p.detail,
      data: p.data,
      durationMs: p.durationMs,
      mocked: p.mocked,
    };
    buffer.push(e);
    listeners.forEach((l) => l(e));
    return e;
  };

  // Seed history spanning startup → steady state, covering every source/level.
  push({ ts: base - 9000, level: "info", source: "app", label: "ready", detail: "AD Manager 1.0.4 · darwin arm64 · Electron 32 · packaged=false (browser mock)" });
  push({ ts: base - 8900, level: "debug", source: "window", label: "did-start-loading" });
  push({ ts: base - 8600, level: "debug", source: "window", label: "dom-ready", detail: "http://localhost:5173/" });
  push({ ts: base - 8500, level: "success", source: "window", label: "did-finish-load", detail: "http://localhost:5173/" });
  push({ ts: base - 8200, level: "debug", source: "ipc", label: "ad:check-module", detail: "→ invoke", data: { args: [] } });
  push({ ts: base - 8000, level: "success", source: "ps", label: "Check-ADModule.ps1", detail: "", durationMs: 214, mocked: true, data: { exitCode: 0, parsed: { available: true } } });
  push({ ts: base - 7900, level: "info", source: "ipc", label: "ad:check-module", detail: "✓ concluído", durationMs: 220, data: { result: { ok: true, data: { available: true } } } });
  push({ ts: base - 6000, level: "debug", source: "net", label: "GET 200", detail: "https://api.github.com/repos/bauer-digital-pt/manager-activedirectory/releases/latest" });
  push({ ts: base - 5800, level: "info", source: "updater", label: "update-not-available", detail: "Já está na versão mais recente." });
  push({ ts: base - 4200, level: "info", source: "ipc", label: "ad:get-groups", detail: "✓ concluído", durationMs: 642, data: { result: { ok: true } } });
  push({ ts: base - 4000, level: "success", source: "ps", label: "Get-ADGroup-All.ps1", detail: "", durationMs: 640, mocked: true, data: { exitCode: 0, parsed: [{ Name: "IT" }, { Name: "REDACAO" }] } });
  push({ ts: base - 2500, level: "error", source: "ps", label: "Test-ADConnection.ps1", detail: "A operação demorou demasiado tempo (mais de 30s) e foi cancelada. Verifica a ligação ao Active Directory.", durationMs: 30012, mocked: true, data: { exitCode: null, stderr: "", killed: true } });
  push({ ts: base - 2400, level: "error", source: "ipc", label: "ad:test-connection", detail: "✗ A operação demorou demasiado tempo…", durationMs: 30015 });
  push({ ts: base - 1200, level: "warn", source: "window", label: "unresponsive" });
  push({ ts: base - 1100, level: "info", source: "window", label: "responsive" });

  window.consoleAPI = {
    onLog: (cb) => { listeners.add(cb as (e: AppLogEntry) => void); return () => listeners.delete(cb as (e: AppLogEntry) => void); },
    getHistory: async () => buffer.slice(),
    clear: async () => { buffer.length = 0; },
    report: (entry) => {
      const e = entry as Partial<AppLogEntry>;
      push({ level: e.level, source: e.source ?? "renderer", label: e.label ?? "event", detail: e.detail, data: e.data });
    },
  };
}
