import { app, BrowserWindow, ipcMain, safeStorage, Menu } from "electron";
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

// Log (don't die on) stray main-process errors. Without these, an uncaught
// throw — e.g. from the auto-updater tearing down — pops a native crash dialog
// and takes the app down with no trace in the activity log.
process.on("uncaughtException", (err) => {
  pushLog({ level: "error", source: "app", label: "uncaughtException", detail: String(err?.message ?? err), data: { stack: err?.stack } });
});
process.on("unhandledRejection", (reason) => {
  pushLog({ level: "error", source: "app", label: "unhandledRejection", detail: reason instanceof Error ? reason.message : String(reason), data: { stack: reason instanceof Error ? reason.stack : undefined } });
});

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

// Domain controller the app talks to by default (domain: bmap.lis). Pre-filled
// so a fresh install connects out of the box; the user can override it in
// Settings → Connection. An empty stored value also falls back to this.
// We use the DC's IP directly (not the hostname pt-srv-dc02) because some client
// PCs don't resolve the DC hostname via DNS, which broke ADWS connectivity.
const DEFAULT_DC = "10.4.0.12";

// Legacy stored server values that must be transparently migrated to the IP:
// the hostname pt-srv-dc02 doesn't resolve via DNS on some client PCs, which
// broke the AD connection. An install carrying the old hostname in
// connection.json would otherwise keep using it and ignore the new default.
const LEGACY_DCS = new Set(["pt-srv-dc02", "pt-srv-dc02.bmap.lis"]);

function migrateServer(server: string): string {
  const s = (server ?? "").trim();
  if (!s) return DEFAULT_DC;
  if (LEGACY_DCS.has(s.toLowerCase())) return DEFAULT_DC;
  return s;
}

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
        server: migrateServer(raw.server),
        username: raw.username ?? "",
        password: raw.password ?? "",
      };
    }
  } catch { /* fall through */ }
  return { server: DEFAULT_DC, username: "", password: "" };
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

// --- App settings (settings.json) ---
// General preferences, separate from AD group config and the AD connection.
// Non-secret: stored in clear. lastUsername is remembered to pre-fill the login
// screen; the login PASSWORD is never persisted (session-only, see `session`).
const SETTINGS_PATH = join(app.getPath("userData"), "settings.json");

// Remembers the version this profile last ran, so the next launch can tell
// whether we just came back from an (auto-)update and greet the user.
const VERSION_PATH = join(app.getPath("userData"), "version.json");
interface StartupInfo { version: string; justUpdated: boolean; previousVersion?: string }
let startupInfo: StartupInfo = { version: "", justUpdated: false };

// Compare the version stored last run against the running one. A mismatch means
// an update was applied since; a first-ever run (no file) is NOT an update.
function computeStartupInfo() {
  const current = app.getVersion();
  let previous: string | undefined;
  try {
    if (existsSync(VERSION_PATH)) {
      const raw = JSON.parse(readFileSync(VERSION_PATH, "utf8")) as { version?: string };
      if (typeof raw.version === "string" && raw.version) previous = raw.version;
    }
  } catch { /* ignore a corrupt marker */ }
  startupInfo = {
    version: current,
    justUpdated: !!previous && previous !== current,
    previousVersion: previous,
  };
  try { writeFileSync(VERSION_PATH, JSON.stringify({ version: current }), "utf8"); } catch { /* best-effort */ }
  if (startupInfo.justUpdated) {
    pushLog({ level: "success", source: "updater", label: "updated", detail: `${previous} -> ${current}` });
  }
}

interface AppSettings {
  devMode: boolean;
  loginTimeoutMin: number;
  lastUsername: string;
}

const DEFAULT_SETTINGS: AppSettings = { devMode: false, loginTimeoutMin: 30, lastUsername: "" };

function readSettings(): AppSettings {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
      return {
        devMode: !!raw.devMode,
        loginTimeoutMin: Math.min(60, Math.max(5, Number(raw.loginTimeoutMin) || 30)),
        lastUsername: typeof raw.lastUsername === "string" ? raw.lastUsername : "",
      };
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_SETTINGS };
}

function writeSettings(next: AppSettings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf8");
}

// --- In-memory login session (NEVER persisted) ---
// The credentials the user typed at the login screen become the credentials all
// AD operations run with, for this run only. Password lives here and nowhere on
// disk; cleared on every launch and on logout / inactivity relock.
let session: ADConnection | null = null;

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;

// Drop the native application menu (File/Edit/…). On macOS a null menu also
// strips the standard Cmd+C/V/X/Q/W accelerators, so keep a minimal app+edit
// menu there; on Windows/Linux the frameless window has no menu bar at all.
function installAppMenu() {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#ffffff",
    // Frameless everywhere. macOS keeps the traffic lights via the hidden title
    // bar (inset a touch so they clear our custom top bar); Windows/Linux drop
    // the frame entirely and rely on the renderer's TitleBar for drag + controls.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 14, y: 16 } }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;
  bindLogWindow(win);
  wireWindowLogging(win);

  // Harden the renderer: it only ever loads our own bundle — the Vite dev server
  // in dev, a file:// URL in production. Deny any window/popup the page tries to
  // open, and block navigation away from that origin, so an injected link or
  // redirect can't repoint the window at remote/attacker-controlled content
  // (which would run with this app's Node/preload bridge and admin rights).
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    const devOk = !!VITE_DEV_SERVER_URL && url.startsWith(VITE_DEV_SERVER_URL);
    if (!devOk && !url.startsWith("file://")) {
      e.preventDefault();
      pushLog({ level: "warn", source: "window", label: "navigation-blocked", detail: url });
    }
  });

  // Pin the zoom to 100%. Running elevated (requireAdministrator) can drop the
  // app's per-monitor DPI awareness and render everything shrunk, and Chromium
  // otherwise persists any stray Ctrl+wheel zoom per origin. Reset it on every
  // load and lock the pinch/zoom limits so the UI can't get stuck tiny.
  win.webContents.on("did-finish-load", () => {
    win.webContents.setZoomFactor(1);
    win.webContents.setVisualZoomLevelLimits(1, 1);
  });

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
  // Login now owns authentication. Purge any legacy service-account password left
  // encrypted at rest by earlier versions — creds are session-only from here on.
  clearLegacyStoredPassword();
  computeStartupInfo();
  installAppMenu();
  createWindow();
  setupAutoUpdates();
});

// One-time migration: earlier builds persisted the AD password (safeStorage) in
// connection.json. Login supersedes that, so strip the stored password while
// keeping server/username for pre-fill and DC targeting.
function clearLegacyStoredPassword() {
  try {
    const stored = readStoredConnection();
    if (stored.password) {
      writeFileSync(
        CONN_PATH,
        JSON.stringify({ server: stored.server, username: stored.username, password: "" }, null, 2),
        "utf8",
      );
      pushLog({ level: "info", source: "app", label: "auth", detail: "Legacy stored AD password cleared" });
    }
  } catch { /* best-effort */ }
}

// --- Auto-updates (GitHub Releases via electron-updater) ---
function sendToRenderer(channel: string, payload: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// Set once an update installer has finished downloading, so updates:install
// never calls quitAndInstall with nothing staged (which throws → crash dialog).
let updateReady = false;
let downloadedVersion: string | undefined;

function setupAutoUpdates() {
  // The updater only works in a packaged app with published release metadata.
  if (!app.isPackaged) return;

  // Automatic on launch: the startup check downloads a found update straight
  // away, so the renderer walks available → downloading (progress bar) →
  // downloaded → "reinicia para instalar" without any user action. The General
  // settings "check for updates" modal rides the same status stream.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Differential downloads (via the .blockmap) routinely hang at 0% behind
  // corporate proxies/firewalls because they rely on HTTP range requests to the
  // GitHub asset CDN. Force a plain full download of the installer — a few MB —
  // which emits normal progress and is far more robust on locked-down networks.
  autoUpdater.disableDifferentialDownload = true;

  // The Windows build is NOT code-signed (no certificate in CI), so electron-
  // updater's Authenticode check rejects every downloaded installer with
  // "New version … is not signed by the application owner" and the update
  // silently never applies. Until a signing certificate is available, skip that
  // verification. The installer is still fetched over HTTPS from our own GitHub
  // releases. `verifyUpdateCodeSignature` returning null means "no error".
  (autoUpdater as unknown as {
    verifyUpdateCodeSignature: () => Promise<string | null>;
  }).verifyUpdateCodeSignature = () => Promise.resolve(null);

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
    updateReady = true;
    downloadedVersion = info.version;
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

// AD operations run with the logged-in session credentials. Before login (or
// after a relock) `session` is null and cmdlets fall back to the local domain /
// current Windows user — harmless because the login gate blocks the UI until a
// session exists. Module/connection checks deliberately DON'T use this path.
function ps(script: string, args: string[] = [], extraEnv?: Record<string, string>) {
  return runPS(script, args, emitLog, session ?? getConnection(), undefined, extraEnv);
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
    "", // password travels via NEW_USER_PASSWORD env, not the command line
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
    params.copyFromUser ?? "",
  ];
  return ps("New-ADUser.ps1", args, { NEW_USER_PASSWORD: params.password ?? "" });
});

handle("ad:reset-password", async (_e, params) => {
  const p = params as { username: string; newPassword: string };
  // Password via RESET_PASSWORD env, not the command line (kept off arg[1]).
  return ps("Reset-ADPassword.ps1", [p.username, ""], { RESET_PASSWORD: p.newPassword });
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
  if (!app.isPackaged) return { ok: false, error: "Updates only run in the installed app." };
  if (!updateReady) {
    return { ok: false, error: "Ainda não há atualização transferida para instalar." };
  }
  // Show the branded "A instalar…" takeover BEFORE anything closes, so the
  // window never just vanishes (which read as a crash). Then give the renderer
  // a moment to paint that screen and run the SILENT installer — no ugly NSIS
  // wizard, forceRunAfter relaunches the freshly-installed app.
  sendToRenderer("updates:status", { state: "installing", version: downloadedVersion });
  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushLog({ level: "error", source: "updater", label: "quitAndInstall-failed", detail: msg });
      sendToRenderer("updates:status", {
        state: "error",
        message: "Não foi possível iniciar a instalação. Fecha a app e volta a abrir para aplicar a atualização.",
      });
    }
  }, 700);
  return { ok: true };
});

// Manually start the download for an already-detected update (General settings
// modal flow, since autoDownload is off).
handle("updates:download", async () => {
  if (!app.isPackaged) return { ok: false, error: "Updates only run in the installed app." };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// --- Auth / session IPC ---
// Validates the typed credentials against the domain (an authenticated bind via
// Get-ADDomain in Test-ADCredential.ps1). On success the creds become the live
// session used by every AD op. The password is NEVER persisted or returned.
handle("auth:login", async (_e, rawPayload) => {
  const payload = rawPayload as { username?: string; password?: string };
  const username = (payload?.username ?? "").trim();
  const password = payload?.password ?? "";
  if (!username || !password) {
    return { ok: false, error: "Indica o utilizador e a palavra-passe." };
  }

  // Target the configured DC if one is set; otherwise auto-discover (empty).
  const server = readStoredConnection().server;
  const attempt: ADConnection = { server, username, password };

  // 15s ceiling so an unreachable DC fails fast at the login screen.
  const r = await runPS("Test-ADCredential.ps1", [], emitLog, attempt, 15000);
  if (!r.ok) {
    return { ok: false, error: r.error ?? "Não foi possível autenticar." };
  }

  const data = (r.data ?? {}) as { success?: boolean; domain?: string; dc?: string; displayName?: string; error?: string };
  if (data.success === false) {
    return { ok: false, error: data.error ?? "Credenciais inválidas." };
  }

  // Pin the DC we actually bound to. The successful bind used `server` (the
  // configured DC, e.g. pt-srv-dc02) — so keep it. We must NOT repin to the
  // domain's PDCEmulator (data.dc): it can be a DIFFERENT DC whose ADWS isn't
  // reachable from this client, which made login succeed but every later
  // Get-AD* call fail with ADServerDownException. Only fall back to the
  // discovered DC when no server was configured (pure auto-discovery).
  session = { server: server || data.dc || "", username, password };

  // Remember only the username (non-secret) for pre-fill next time.
  const settings = readSettings();
  if (settings.lastUsername !== username) writeSettings({ ...settings, lastUsername: username });

  pushLog({ level: "success", source: "app", label: "auth", detail: `Login ${username} @ ${data.domain ?? "domínio"}` });
  return { ok: true, username, displayName: data.displayName, domain: data.domain, dc: data.dc };
});

handle("auth:logout", () => {
  session = null;
  pushLog({ level: "info", source: "app", label: "auth", detail: "Logout / sessão terminada" });
  return { ok: true };
});

handle("auth:status", () => {
  const settings = readSettings();
  return {
    ok: true,
    authenticated: !!session,
    username: session?.username ?? "",
    lastUsername: settings.lastUsername,
  };
});

// Lightweight liveness probe for the sidebar status dot. Runs on the session
// creds; quiet (no emitLog) so it doesn't flood the Console every few seconds.
handle("auth:ping", async () => {
  if (!session) return { ok: false, error: "no session" };
  // This AD can take ~7s per call, so an 8s ceiling was borderline. Give the
  // probe generous headroom so a slow-but-healthy DC doesn't flap the dot red.
  const r = await runPS("Test-ADConnection.ps1", [], undefined, session, 20000);
  return { ok: r.ok, error: r.error };
});

// --- Settings IPC ---
handle("config:get-settings", () => readSettings());
handle("config:set-settings", (_e, rawPayload) => {
  const p = (rawPayload ?? {}) as Partial<AppSettings>;
  const current = readSettings();
  const next: AppSettings = {
    devMode: p.devMode !== undefined ? !!p.devMode : current.devMode,
    loginTimeoutMin: p.loginTimeoutMin !== undefined
      ? Math.min(60, Math.max(5, Number(p.loginTimeoutMin) || current.loginTimeoutMin))
      : current.loginTimeoutMin,
    lastUsername: p.lastUsername !== undefined ? String(p.lastUsername) : current.lastUsername,
  };
  writeSettings(next);
  return next;
});

// --- App / window IPC ---
handle("app:get-version", () => app.getVersion());
handle("app:startup-info", () => startupInfo);

// Frameless window controls driven by the renderer TitleBar. Raw ipcMain.on
// (fire-and-forget, no result) so they don't spam the Console.
ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on("window:close", () => mainWindow?.close());

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
