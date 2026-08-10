import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import electronUpdater from "electron-updater";
import { runPS, type ADConnection, type LogEntry } from "./ps-runner";
import {
  bindLogWindow,
  pushLog,
  getHistory,
  clearHistory,
  redact,
  redactPsArgs,
  truncate,
} from "./logbus";

const { autoUpdater } = electronUpdater;

const CONFIG_PATH = join(app.getPath("userData"), "groups.json");
type GroupConfig = Record<string, unknown>;

function readGroups(): GroupConfig {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch { /* fall through */ }
  return {};
}

function writeGroups(config: GroupConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

// --- Remote AD connection config ---
// Stored in connection.json. The password is encrypted at rest with Electron's
// safeStorage (OS keychain) and is never sent back to the renderer in clear text.
const CONN_PATH = join(app.getPath("userData"), "connection.json");

interface StoredConnection {
  server: string;
  username: string;
  password: string; // base64 of safeStorage-encrypted bytes ("" when unset)
}

function readStoredConnection(): StoredConnection {
  try {
    if (existsSync(CONN_PATH)) {
      const raw = JSON.parse(readFileSync(CONN_PATH, "utf8"));
      return {
        server: raw.server ?? "",
        username: raw.username ?? "",
        password: raw.password ?? "",
      };
    }
  } catch { /* fall through */ }
  return { server: "", username: "", password: "" };
}

function decryptPassword(encoded: string): string {
  if (!encoded) return "";
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(encoded, "base64"));
    }
    // Fallback: stored as plain base64 when OS encryption is unavailable.
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function encryptPassword(plain: string): string {
  if (!plain) return "";
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString("base64");
  }
  return Buffer.from(plain, "utf8").toString("base64");
}

// Full connection (with decrypted password) for use by the PS runner.
function getConnection(): ADConnection {
  const stored = readStoredConnection();
  return {
    server: stored.server,
    username: stored.username,
    password: decryptPassword(stored.password),
  };
}

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;
  bindLogWindow(win);
  wireWindowLogging(win);

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(join(__dirname, "../dist/index.html"));
  }
}

// Mirror the window's load lifecycle, renderer console output, crashes, and
// outbound network requests into the activity log, so the Console shows exactly
// what is being loaded, every connection, and every failure/timeout.
function wireWindowLogging(win: BrowserWindow) {
  const wc = win.webContents;

  wc.on("did-start-loading", () => pushLog({ level: "debug", source: "window", label: "did-start-loading" }));
  wc.on("dom-ready", () => pushLog({ level: "debug", source: "window", label: "dom-ready", detail: wc.getURL() }));
  wc.on("did-finish-load", () => pushLog({ level: "success", source: "window", label: "did-finish-load", detail: wc.getURL() }));
  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) =>
    pushLog({ level: "error", source: "window", label: "did-fail-load", detail: `${desc} (${code}) — ${url}`, data: { code, desc, url, isMainFrame } }));
  wc.on("did-fail-provisional-load", (_e, code, desc, url) =>
    pushLog({ level: "error", source: "window", label: "did-fail-provisional-load", detail: `${desc} (${code}) — ${url}`, data: { code, desc, url } }));
  wc.on("render-process-gone", (_e, details) =>
    pushLog({ level: "error", source: "window", label: "render-process-gone", detail: details.reason, data: details }));
  wc.on("unresponsive", () => pushLog({ level: "warn", source: "window", label: "unresponsive" }));
  wc.on("responsive", () => pushLog({ level: "info", source: "window", label: "responsive" }));
  wc.on("preload-error", (_e, preloadPath, error) =>
    pushLog({ level: "error", source: "window", label: "preload-error", detail: String(error?.message ?? error), data: { preloadPath } }));

  // Renderer console.* (and Chromium resource warnings) surfaced in main.
  const CHROME_LEVEL: Record<number, "debug" | "info" | "warn" | "error"> = { 0: "debug", 1: "info", 2: "warn", 3: "error" };
  wc.on("console-message", (_e, level, message, line, sourceId) =>
    pushLog({ level: CHROME_LEVEL[level] ?? "info", source: "renderer", label: "console", detail: message, data: { line, sourceId } }));

  // Outbound HTTP(S) connections (auto-update checks, downloads). file:// asset
  // loads are intentionally skipped so a startup burst doesn't drown the log.
  const wr = win.webContents.session.webRequest;
  wr.onCompleted(({ url, method, statusCode }) => {
    if (!/^https?:/i.test(url)) return;
    const level = statusCode >= 400 ? "error" : "debug";
    pushLog({ level, source: "net", label: `${method} ${statusCode}`, detail: url });
  });
  wr.onErrorOccurred(({ url, method, error }) => {
    if (!/^https?:/i.test(url)) return;
    pushLog({ level: "error", source: "net", label: `${method} failed`, detail: `${error} — ${url}`, data: { error } });
  });
}

app.whenReady().then(() => {
  pushLog({
    level: "info",
    source: "app",
    label: "ready",
    detail: `AD Manager ${app.getVersion()} · ${process.platform} ${process.arch} · Electron ${process.versions.electron} · packaged=${app.isPackaged}`,
  });
  createWindow();
  setupAutoUpdates();
});

// --- Auto-updates (GitHub Releases via electron-updater) ---
function sendToRenderer(channel: string, payload: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function setupAutoUpdates() {
  // The updater only works in a packaged app with published release metadata.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () =>
    pushLog({ level: "info", source: "updater", label: "checking-for-update", detail: "A procurar atualizações…" }));
  autoUpdater.on("update-available", (info) => {
    pushLog({ level: "info", source: "updater", label: "update-available", detail: `v${info.version}`, data: info });
    sendToRenderer("updates:status", { state: "available", version: info.version });
  });
  autoUpdater.on("update-not-available", (info) => {
    pushLog({ level: "info", source: "updater", label: "update-not-available", detail: "Já está na versão mais recente." });
    sendToRenderer("updates:status", { state: "none" });
  });
  autoUpdater.on("download-progress", (p) => {
    pushLog({ level: "debug", source: "updater", label: "download-progress", detail: `${Math.round(p.percent)}% · ${Math.round(p.bytesPerSecond / 1024)} KB/s` });
    sendToRenderer("updates:status", { state: "downloading", percent: Math.round(p.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    pushLog({ level: "success", source: "updater", label: "update-downloaded", detail: `v${info.version} pronta a instalar` });
    sendToRenderer("updates:status", { state: "downloaded", version: info.version });
  });
  autoUpdater.on("error", (err) => {
    pushLog({ level: "error", source: "updater", label: "error", detail: String(err?.message ?? err), data: { stack: err?.stack } });
    sendToRenderer("updates:status", { state: "error", message: String(err?.message ?? err) });
  });

  autoUpdater.checkForUpdates().catch((e) =>
    pushLog({ level: "warn", source: "updater", label: "check-failed", detail: String(e?.message ?? e) }));
}

// --- RSAT ActiveDirectory auto-install ---
// The RSAT "Active Directory" module is a Windows Feature-on-Demand. On Windows
// 10/11 it installs via DISM /add-capability, which streams a real percentage to
// stdout that we forward to the renderer as a progress bar. The packaged app runs
// elevated (requireAdministrator), so DISM inherits admin rights — no extra UAC.
const RSAT_CAPABILITY = "Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0";

// Turns a raw DISM error/output into a short, actionable Portuguese message.
function friendlyInstallError(output: string, code: number | null): string {
  const text = (output || "").toLowerCase();
  if (text.includes("0x800f0954") || text.includes("0x800f0906") || text.includes("0x800f081f")) {
    return "O Windows Update / Funcionalidades Opcionais parece estar bloqueado por política nesta máquina "
      + "(erro 0x800f0954). Instala o RSAT manualmente com os passos abaixo, ou pede ao IT para permitir o "
      + "download de funcionalidades opcionais diretamente do Windows Update.";
  }
  if (code === 740 || text.includes("elevat") || text.includes("access is denied") || text.includes("acesso negado")) {
    return "É preciso executar o AD Manager como administrador para instalar o componente. "
      + "Fecha a app, clica com o botão direito e escolhe “Executar como administrador”.";
  }
  if (text.includes("could not be found") || text.includes("não foi possível encontrar")) {
    return "O Windows não encontrou os ficheiros do RSAT (pode ser uma edição de Windows sem esta funcionalidade, "
      + "ou Windows Server). Instala o RSAT manualmente com os passos abaixo.";
  }
  return `A instalação automática falhou${code != null ? ` (código ${code})` : ""}. `
    + "Tenta novamente ou instala o RSAT manualmente com os passos abaixo.";
}

// Runs the DISM install, forwarding progress on the "ad:install-progress" channel.
// Resolves with the final outcome so the invoking IPC call also gets a result.
function installADModule(): Promise<{ ok: boolean; rebootRequired?: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      const error = "A instalação automática só está disponível no Windows.";
      pushLog({ level: "error", source: "rsat", label: "install", detail: error });
      sendToRenderer("ad:install-progress", { state: "error", message: error });
      resolve({ ok: false, error });
      return;
    }

    pushLog({ level: "info", source: "rsat", label: "install", detail: `A iniciar DISM /add-capability ${RSAT_CAPABILITY}` });
    sendToRenderer("ad:install-progress", { state: "installing", percent: 0, message: "A preparar a instalação…" });

    let dism;
    try {
      dism = spawn(
        "dism.exe",
        ["/online", "/add-capability", `/capabilityname:${RSAT_CAPABILITY}`, "/norestart"],
        { windowsHide: true },
      );
    } catch (e) {
      const error = friendlyInstallError(e instanceof Error ? e.message : String(e), null);
      sendToRenderer("ad:install-progress", { state: "error", message: error });
      resolve({ ok: false, error });
      return;
    }

    let buf = "";
    let lastPercent = 0;

    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      // DISM updates a single progress line in place; grab the last "NN.N%" seen.
      const matches = buf.match(/(\d{1,3}(?:[.,]\d)?)\s*%/g);
      if (matches && matches.length) {
        const raw = matches[matches.length - 1].replace(/[^\d.,]/g, "").replace(",", ".");
        const p = Math.min(99, Math.max(lastPercent, Math.round(parseFloat(raw))));
        if (p !== lastPercent) {
          lastPercent = p;
          sendToRenderer("ad:install-progress", { state: "installing", percent: p, message: "A instalar componentes…" });
        }
      }
      // Keep only a tail of the buffer so error strings survive without unbounded growth.
      if (buf.length > 16384) buf = buf.slice(-4096);
    };

    dism.stdout?.on("data", onData);
    dism.stderr?.on("data", onData);

    dism.on("error", (err) => {
      const error = friendlyInstallError(err.message, null);
      pushLog({ level: "error", source: "rsat", label: "install", detail: error, data: { raw: err.message } });
      sendToRenderer("ad:install-progress", { state: "error", message: error });
      resolve({ ok: false, error });
    });

    dism.on("close", (code) => {
      if (code === 0 || code === 3010) {
        const rebootRequired = code === 3010;
        pushLog({ level: "success", source: "rsat", label: "install", detail: rebootRequired ? "Instalado (é preciso reiniciar)" : "Instalado", data: { code } });
        sendToRenderer("ad:install-progress", { state: "done", percent: 100, rebootRequired });
        resolve({ ok: true, rebootRequired });
      } else {
        const error = friendlyInstallError(buf, code);
        pushLog({ level: "error", source: "rsat", label: "install", detail: error, data: { code, output: truncate(buf) } });
        sendToRenderer("ad:install-progress", { state: "error", message: error, code });
        resolve({ ok: false, error });
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// --- IPC handlers ---

// Normalize a raw PowerShell LogEntry into the unified activity log. Secrets in
// positional args are masked, stdout is parsed (so the Console can show the real
// result/data), and timeouts/failures surface their actual reason.
function emitLog(e: LogEntry) {
  let parsed: unknown;
  try { parsed = e.stdout ? JSON.parse(e.stdout.trim()) : undefined; } catch { parsed = undefined; }
  const errorMsg =
    (parsed && typeof parsed === "object" && parsed && "error" in parsed ? (parsed as { error?: string }).error : undefined) ||
    (e.stderr?.trim() || undefined);
  pushLog({
    ts: e.ts,
    level: e.ok ? "success" : "error",
    source: "ps",
    label: e.script,
    detail: e.ok ? (e.args.length ? redactPsArgs(e.script, e.args).filter(Boolean).join(" ") : undefined) : errorMsg,
    data: {
      args: redactPsArgs(e.script, e.args),
      exitCode: e.exitCode,
      stdout: e.stdout ? truncate(e.stdout) : "",
      stderr: e.stderr ?? "",
      parsed,
    },
    durationMs: e.durationMs,
    mocked: e.mocked,
  });
}

// Wrap an IPC handler so every invocation is logged (request + outcome +
// duration) with secrets redacted. This is what makes non-PS activity
// (config, connection, updates) visible in the Console, not just AD scripts.
function handle(
  channel: string,
  fn: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown,
) {
  ipcMain.handle(channel, async (event, ...args) => {
    const start = Date.now();
    pushLog({ level: "debug", source: "ipc", label: channel, detail: "→ invoke", data: { args: args.map((a) => redact(a)) } });
    try {
      const result = await fn(event, ...args);
      const failed = !!(result && typeof result === "object" && "ok" in result && (result as { ok?: boolean }).ok === false);
      pushLog({
        level: failed ? "error" : "info",
        source: "ipc",
        label: channel,
        detail: failed ? `✗ ${(result as { error?: string }).error ?? "erro"}` : "✓ concluído",
        data: { result: redact(result) },
        durationMs: Date.now() - start,
      });
      return result;
    } catch (err) {
      pushLog({
        level: "error",
        source: "ipc",
        label: channel,
        detail: `✗ ${err instanceof Error ? err.message : String(err)}`,
        data: { stack: err instanceof Error ? err.stack : undefined },
        durationMs: Date.now() - start,
      });
      throw err;
    }
  });
}

function ps(script: string, args: string[] = []) {
  return runPS(script, args, emitLog, getConnection());
}

handle("ad:get-groups", async () => {
  return ps("Get-ADGroup-All.ps1");
});

handle("ad:get-group-members", async (_e, groupName) => {
  return ps("Get-ADGroupMembers.ps1", [groupName as string]);
});

handle("ad:create-user", async (_e, rawParams) => {
  const params = rawParams as Record<string, string>;
  const args = [
    params.firstName,
    params.lastName,
    params.username,
    params.password,
    params.groupName,
    params.description ?? "",
    params.street ?? "",
    params.city ?? "",
    params.postalCode ?? "",
    params.changePasswordAtLogon ?? "true",
    params.passwordNeverExpires ?? "false",
    params.jobTitle ?? "",
    params.department ?? "",
    params.company ?? "",
    params.email ?? "",
  ];
  return ps("New-ADUser.ps1", args);
});

handle("ad:reset-password", async (_e, params) => {
  const p = params as { username: string; newPassword: string };
  return ps("Reset-ADPassword.ps1", [p.username, p.newPassword]);
});

handle("ad:unlock-user", async (_e, username) => {
  return ps("Unlock-ADUser.ps1", [username as string]);
});

handle("ad:add-group-permission", async (_e, params) => {
  const p = params as { groupName: string; description: string };
  return ps("Add-ADGroup.ps1", [p.groupName, p.description]);
});

handle("ad:remove-group", async (_e, groupName) => {
  return ps("Remove-ADGroup.ps1", [groupName as string]);
});

// Reports whether the RSAT ActiveDirectory module is installed on this machine.
handle("ad:check-module", async () => {
  return ps("Check-ADModule.ps1");
});

// Installs the RSAT ActiveDirectory module via DISM, streaming progress to the
// renderer on "ad:install-progress". Resolves with the final outcome.
handle("ad:install-module", async () => {
  return installADModule();
});

// --- Update IPC ---
handle("updates:check", async () => {
  if (!app.isPackaged) return { ok: false, error: "Updates only run in the installed app." };
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r?.updateInfo?.version };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

handle("updates:install", () => {
  autoUpdater.quitAndInstall();
});

// --- Config IPC ---
handle("config:get-groups", () => readGroups());
handle("config:set-groups", (_e, groups) => { writeGroups(groups as Record<string, unknown>); });

// --- Connection IPC ---
// Never returns the password itself — only whether one is stored.
handle("config:get-connection", () => {
  const stored = readStoredConnection();
  return { server: stored.server, username: stored.username, hasPassword: !!stored.password };
});

handle("config:set-connection", (_e, rawPayload) => {
  const payload = rawPayload as { server: string; username: string; password?: string };
  const current = readStoredConnection();
  const next: StoredConnection = {
    server: payload.server ?? "",
    username: payload.username ?? "",
    // password omitted => keep existing; empty string => explicitly clear.
    password: payload.password === undefined ? current.password : encryptPassword(payload.password),
  };
  writeFileSync(CONN_PATH, JSON.stringify(next, null, 2), "utf8");
});

// Runs a test using the given values (if provided) instead of the saved ones,
// so the user can verify before saving. Falls back to saved config otherwise.
handle("ad:test-connection", (_e, rawOverride) => {
  const override = rawOverride as { server: string; username: string; password?: string } | undefined;
  let conn = getConnection();
  if (override) {
    conn = {
      server: override.server ?? "",
      username: override.username ?? "",
      password: override.password !== undefined && override.password !== ""
        ? override.password
        : conn.password,
    };
  }
  return runPS("Test-ADConnection.ps1", [], emitLog, conn);
});

// --- Console / activity log IPC ---
// Registered on raw ipcMain (not the logging `handle` wrapper) so reading or
// clearing the log doesn't itself generate log noise or recurse.
ipcMain.handle("console:get-history", () => getHistory());
ipcMain.handle("console:clear", () => { clearHistory(); });
ipcMain.on("console:report", (_e, entry: {
  level?: import("./logbus").LogLevel; source?: string; label?: string; detail?: string; data?: unknown;
}) => {
  pushLog({
    level: entry?.level ?? "info",
    source: entry?.source ?? "renderer",
    label: entry?.label ?? "event",
    detail: entry?.detail,
    data: entry?.data,
  });
});
