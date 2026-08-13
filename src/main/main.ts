import { app, BrowserWindow, ipcMain, safeStorage, Menu } from "electron";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import electronUpdater from "electron-updater";
import { runPS, type ADConnection, type LogEntry } from "./ps-runner";
import { DEFAULT_DC } from "../shared/constants";
import { BUILD_FLAVOR, FLAVOR_META } from "../shared/flavor";
import type { AppSettings, DeviceConfig, OnboardState, StartupInfo } from "../shared/types";
import {
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

// A small JSON-file store under the app's userData dir. Centralizes the
// resilient read (missing or corrupt file -> a normalized default, never a
// throw) and the pretty-printed write that every persisted config shares. Each
// store keeps its own `normalize`, so a malformed or older-shaped file can never
// reach the rest of the app. By contract `normalize(undefined)` yields the default.
function makeJsonStore<T>(filename: string, normalize: (raw: unknown) => T) {
  const path = join(app.getPath("userData"), filename);
  return {
    path,
    read(): T {
      try {
        if (existsSync(path)) return normalize(JSON.parse(readFileSync(path, "utf8")));
      } catch { /* fall through to default */ }
      return normalize(undefined);
    },
    write(value: T): void {
      writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
    },
  };
}

type GroupConfig = Record<string, unknown>;

const groupsStore = makeJsonStore<GroupConfig>("groups.json", (raw) =>
  raw && typeof raw === "object" ? (raw as GroupConfig) : {},
);
function readGroups(): GroupConfig { return groupsStore.read(); }
function writeGroups(config: GroupConfig): void { groupsStore.write(config); }

// --- Remote AD connection config ---
// Stored in connection.json. The password is encrypted at rest with Electron's
// safeStorage (OS keychain) and is never sent back to the renderer in clear text.
// The file lives at connectionStore.path (defined below).

// DEFAULT_DC (the fallback domain controller) is defined in src/shared/constants.ts.

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

const connectionStore = makeJsonStore<StoredConnection>("connection.json", (raw) => {
  const r = (raw ?? {}) as Partial<StoredConnection>;
  return {
    // migrateServer("") returns DEFAULT_DC, so a missing/blank server self-heals.
    server: migrateServer(typeof r.server === "string" ? r.server : ""),
    username: typeof r.username === "string" ? r.username : "",
    password: typeof r.password === "string" ? r.password : "",
  };
});
function readStoredConnection(): StoredConnection { return connectionStore.read(); }

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
// The file lives at settingsStore.path (defined below).

// Remembers the version this profile last ran, so the next launch can tell
// whether we just came back from an (auto-)update and greet the user.
const VERSION_PATH = join(app.getPath("userData"), "version.json");
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

const DEFAULT_SETTINGS: AppSettings = { devMode: false, loginTimeoutMin: 30, lastUsername: "" };

const settingsStore = makeJsonStore<AppSettings>("settings.json", (raw) => {
  const r = (raw ?? {}) as Partial<AppSettings>;
  return {
    devMode: !!r.devMode,
    loginTimeoutMin: Math.min(60, Math.max(5, Number(r.loginTimeoutMin) || DEFAULT_SETTINGS.loginTimeoutMin)),
    lastUsername: typeof r.lastUsername === "string" ? r.lastUsername : DEFAULT_SETTINGS.lastUsername,
  };
});
function readSettings(): AppSettings { return settingsStore.read(); }
function writeSettings(next: AppSettings): void { settingsStore.write(next); }

// --- Device onboarding config (device-config.json) ---
// Maps each department code to the destination folder (a sub-OU under O365 in the
// BMAP Devices tree) a freshly-onboarded PC should land in, plus the shared
// installer sources. Non-secret: stored in clear (paths/URLs, no credentials).
// Coerce a dept -> printer-names map, dropping non-string / empty entries.
function normalizePrinterMap(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        const list = v.filter((x): x is string => typeof x === "string" && !!x);
        if (list.length) out[k] = list;
      }
    }
  }
  return out;
}

const deviceConfigStore = makeJsonStore<DeviceConfig>("device-config.json", (raw) => {
  const r = (raw ?? {}) as Partial<DeviceConfig>;
  return {
    ouMap: r.ouMap && typeof r.ouMap === "object" ? (r.ouMap as Record<string, string>) : {},
    anyConnectSource: typeof r.anyConnectSource === "string" ? r.anyConnectSource : "",
    screenConnectSource: typeof r.screenConnectSource === "string" ? r.screenConnectSource : "",
    printerMap: normalizePrinterMap(r.printerMap),
    printerSource: typeof r.printerSource === "string" ? r.printerSource : "",
    smlPlayerSource: typeof r.smlPlayerSource === "string" ? r.smlPlayerSource : "",
    smlPlayerIni: typeof r.smlPlayerIni === "string" ? r.smlPlayerIni : "",
  };
});
// Dev-only convenience: when PowerShell is mocked (MOCK_PS=1) and nothing has
// been configured yet, hand back a demo OU/printer mapping so the onboarding
// wizard is fully exercisable off a real domain. Without it every department
// reports "sem pasta definida" and the run can't start. Never hit in a real run.
const MOCK_PS = process.env.MOCK_PS === "1";
function demoDeviceConfig(): DeviceConfig {
  const ouMap: Record<string, string> = {};
  for (const d of ["ADM", "RCM", "CDD", "MKT", "NWS", "RTO", "COM", "DIG", "EVT", "HR", "IT", "LEG"]) {
    ouMap[d] = `OU=${d},OU=O365,OU=BMAP Devices,DC=bmap,DC=lis`;
  }
  return { ouMap, anyConnectSource: "", screenConnectSource: "", printerMap: { ADM: ["ADM"], IT: ["PRO", "MRK"] }, printerSource: "", smlPlayerSource: "", smlPlayerIni: "" };
}
function readDeviceConfig(): DeviceConfig {
  const cfg = deviceConfigStore.read();
  if (MOCK_PS && Object.keys(cfg.ouMap).length === 0) return demoDeviceConfig();
  return cfg;
}
function writeDeviceConfig(config: DeviceConfig): void { deviceConfigStore.write(config); }

// --- PC onboarding state (onboard-state.json) ---
// Persists the in-progress "fully automatic" onboarding wizard across the reboot
// that the domain-join step forces. When a run is active the app is registered to
// start on boot (setLoginItemSettings) so the operator only has to log back into
// Windows + the app; the renderer then resumes from `completed`. Non-secret: it
// holds the target name/OU/dept and which steps finished — NEVER a password.
// Sanitise on read too, not just on write: a corrupt or hand-edited file with
// valid JSON but wrong-typed fields (e.g. completed as a string) would otherwise
// reach the renderer and throw on completed.map(...), wedging resume with no
// in-app recovery. normalizeOnboardState coerces every field and returns null
// when the run isn't active (also what a missing file yields via normalize(undefined)).
const onboardStateStore = makeJsonStore<OnboardState | null>("onboard-state.json", normalizeOnboardState);
function readOnboardState(): OnboardState | null { return onboardStateStore.read(); }

// Coerce an arbitrary renderer payload into a well-formed state (or null when the
// run isn't active), so a malformed message can never poison the persisted file.
function normalizeOnboardState(raw: unknown): OnboardState | null {
  const p = (raw ?? {}) as Partial<OnboardState>;
  if (!p || !p.active) return null;
  const now = Date.now();
  return {
    active: true,
    dept: typeof p.dept === "string" ? p.dept : "",
    targetName: typeof p.targetName === "string" ? p.targetName : "",
    targetOU: typeof p.targetOU === "string" ? p.targetOU : "",
    anyConnectSource: typeof p.anyConnectSource === "string" ? p.anyConnectSource : "",
    screenConnectSource: typeof p.screenConnectSource === "string" ? p.screenConnectSource : "",
    printers: Array.isArray(p.printers) ? p.printers.filter((s): s is string => typeof s === "string" && !!s) : [],
    printerSource: typeof p.printerSource === "string" ? p.printerSource : "",
    smlPlayerSource: typeof p.smlPlayerSource === "string" ? p.smlPlayerSource : "",
    smlPlayerIni: typeof p.smlPlayerIni === "string" ? p.smlPlayerIni : "",
    completed: Array.isArray(p.completed) ? p.completed.filter((s): s is string => typeof s === "string") : [],
    preparedFor:
      p.preparedFor && typeof p.preparedFor === "object" &&
      typeof p.preparedFor.sam === "string" && typeof p.preparedFor.name === "string"
        ? { sam: p.preparedFor.sam, name: p.preparedFor.name }
        : undefined,
    startedAt: typeof p.startedAt === "number" ? p.startedAt : now,
    updatedAt: now,
  };
}

function writeOnboardState(state: OnboardState | null): void {
  try {
    if (!state || !state.active) { clearOnboardState(); return; }
    onboardStateStore.write(state);
  } catch { /* best-effort */ }
}

function clearOnboardState(): void {
  // Compact inactive marker (not the store's pretty write) — readOnboardState
  // normalizes any {active:false} back to null, so the exact shape is moot.
  try { writeFileSync(onboardStateStore.path, JSON.stringify({ active: false }), "utf8"); } catch { /* best-effort */ }
}

// Keep the OS "start on boot" flag in lock-step with an active onboarding run, so
// a mid-flow reboot relaunches the app to resume — and nothing lingers after the
// run ends. Linux has no login-item support in Electron, so skip it there.
function syncLoginItem(active: boolean) {
  try {
    if (process.platform === "linux") return;
    app.setLoginItemSettings({ openAtLogin: active });
  } catch (e) {
    pushLog({ level: "warn", source: "app", label: "onboard", detail: "Nao foi possivel definir o arranque automatico: " + (e instanceof Error ? e.message : String(e)) });
  }
}

// Reboots this machine (Windows only) to complete the domain-join step. Detached
// so it survives the app quitting; the app is already registered to start on boot.
function rebootMachine() {
  if (process.platform !== "win32") {
    pushLog({ level: "warn", source: "app", label: "onboard", detail: "Reinicio automatico so esta disponivel no Windows." });
    return;
  }
  try {
    spawn("shutdown.exe", ["/r", "/t", "0"], { windowsHide: true, detached: true }).unref();
  } catch (e) {
    pushLog({ level: "error", source: "app", label: "onboard", detail: "Falha a reiniciar: " + (e instanceof Error ? e.message : String(e)) });
  }
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
  // The Agent is a slim per-PC installer: a single centered onboarding card, no
  // sidebar. Give it a small, tidy window instead of the Manager's full console.
  const isAgent = BUILD_FLAVOR === "agent";
  const win = new BrowserWindow({
    width: isAgent ? 760 : 1200,
    height: isAgent ? 820 : 750,
    minWidth: isAgent ? 600 : 900,
    minHeight: isAgent ? 680 : 600,
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
  wireWindowLogging(win);
  hardenWebContents(win.webContents);

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

// Harden a renderer: it only ever loads our own bundle — the Vite dev server in
// dev, a file:// URL in production. Deny any window/popup the page tries to open,
// and block navigation away from that origin, so an injected link or redirect
// can't repoint the window at remote/attacker-controlled content (which would run
// with this app's Node/preload bridge and admin rights). Applied to every window
// we create, including the detached Console.
function hardenWebContents(wc: Electron.WebContents) {
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e, url) => {
    const devOk = !!VITE_DEV_SERVER_URL && url.startsWith(VITE_DEV_SERVER_URL);
    if (!devOk && !url.startsWith("file://")) {
      e.preventDefault();
      pushLog({ level: "warn", source: "window", label: "navigation-blocked", detail: url });
    }
  });
}

// ── Detached Console window (Ctrl+Shift+C) ──────────────────────────────────
// A separate, deliberately unbranded diagnostics window that renders the same
// activity log as the Manager's Console page. It is its OWN OS window (real frame,
// generic "Console" title, dark chrome) so it reads as a standalone utility with
// no visible tie to the app — the only way to reach the log in the slim Agent.
// The renderer decides to show the console-only view from the "#console" hash.
let consoleWindow: BrowserWindow | null = null;

function openConsoleWindow() {
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    if (consoleWindow.isMinimized()) consoleWindow.restore();
    consoleWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 940,
    height: 640,
    minWidth: 560,
    minHeight: 360,
    title: "Console",
    backgroundColor: "#0f1117",
    // A normal OS frame (not the app's frameless custom title bar) reinforces the
    // "separate little app" feel and gives native minimize/close controls.
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  consoleWindow = win;
  hardenWebContents(win.webContents);
  win.setMenuBarVisibility(false);
  // Keep the generic title even if the loaded document tries to set its own.
  win.on("page-title-updated", (e) => e.preventDefault());
  win.on("closed", () => { consoleWindow = null; });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(`${VITE_DEV_SERVER_URL}#console`);
  } else {
    win.loadFile(join(__dirname, "../dist/index.html"), { hash: "console" });
  }

  pushLog({ level: "info", source: "app", label: "console-window", detail: "Detached Console opened" });
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
    detail: `${FLAVOR_META[BUILD_FLAVOR].productName} ${app.getVersion()} · ${process.platform} ${process.arch} · Electron ${process.versions.electron} · packaged=${app.isPackaged}`,
  });
  // Login now owns authentication. Purge any legacy service-account password left
  // encrypted at rest by earlier versions — creds are session-only from here on.
  clearLegacyStoredPassword();
  computeStartupInfo();
  installAppMenu();
  createWindow();
  setupAutoUpdates();
  // Reconcile the start-on-boot flag with the persisted onboarding state: if a run
  // was interrupted by the reboot, stay registered so it can resume; otherwise
  // make sure a stale flag from a finished run isn't left enabled.
  syncLoginItem(!!readOnboardState());
});

// One-time migration: earlier builds persisted the AD password (safeStorage) in
// connection.json. Login supersedes that, so strip the stored password while
// keeping server/username for pre-fill and DC targeting.
function clearLegacyStoredPassword() {
  try {
    const stored = readStoredConnection();
    if (stored.password) {
      connectionStore.write({ server: stored.server, username: stored.username, password: "" });
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
    return `É preciso executar o ${FLAVOR_META[BUILD_FLAVOR].productName} como administrador para instalar o componente. `
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
// Optional timeoutMs routes slow local operations (PC status probe, onboarding
// steps) through this same session + logging policy instead of calling runPS
// directly. The non-session probes (auth/connection tests) deliberately don't.
function ps(script: string, args: string[] = [], extraEnv?: Record<string, string>, timeoutMs?: number) {
  return runPS(script, args, emitLog, session ?? getConnection(), timeoutMs, extraEnv);
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
    params.employeeType ?? "",
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

// Free-text AD user search for the "prepared for" picker in PC onboarding. The
// query is a plain name/username (no secret) so it travels on the command line;
// the script sanitizes it and only embeds it in the AD filter via a variable.
handle("ad:search-users", async (_e, query) => {
  return ps("Search-ADUser.ps1", [(query as string) ?? ""]);
});

handle("ad:add-group-permission", async (_e, params) => {
  const p = params as { groupName: string; description: string };
  return ps("Add-ADGroup.ps1", [p.groupName, p.description]);
});

handle("ad:remove-group", async (_e, groupName) => {
  return ps("Remove-ADGroup.ps1", [groupName as string]);
});

// Offboard = disable the account + move it to the morgue OU. Two safety gates are
// enforced HERE, before any AD change: (1) the operator must re-type the exact
// username, and (2) re-confirm the admin password. The password is checked
// against the in-memory session (what they logged in with) — it never reaches
// PowerShell, the command line, or the log (redact() masks the "adminPassword"
// key). This makes an accidental or unattended offboard much harder.
handle("ad:offboard-user", async (_e, rawParams) => {
  const p = (rawParams ?? {}) as { username?: string; confirmUsername?: string; adminPassword?: string };
  const username = (p.username ?? "").trim();
  const confirmUsername = (p.confirmUsername ?? "").trim();
  const adminPassword = p.adminPassword ?? "";

  if (!username) return { ok: false, error: "Utilizador em falta." };
  if (!session) return { ok: false, error: "Sessão expirada. Volta a iniciar sessão e tenta de novo." };
  if (confirmUsername !== username) {
    return { ok: false, error: "O username de confirmação não corresponde ao utilizador a dar offboard." };
  }
  if (!adminPassword || adminPassword !== session.password) {
    return { ok: false, error: "Palavra-passe de administrador incorreta." };
  }

  return ps("Offboard-ADUser.ps1", [username]);
});

// --- PC onboarding (the machine this app is running on) ---

// The PC status probe (esp. the Windows Update COM search) is slow and, by
// design, stable within a session: onboarding actions change AD/registry state
// that only fully reflects after a reboot ("se nao reinicia tambem nao atualiza").
// So we memoize the last successful snapshot for the whole process lifetime and
// only re-probe when the caller forces it (the manual refresh button). A reboot
// restarts the process and naturally clears this — exactly the desired cadence.
let pcStatusCache: Awaited<ReturnType<typeof runPS>> | null = null;

// Read-only snapshot of the LOCAL machine's onboarding state. The Windows Update
// COM probe can be slow, so this gets a longer ceiling than a normal AD call.
handle("ad:pc-status", async (_e, rawParams) => {
  const p = (rawParams ?? {}) as { force?: boolean };
  if (!p.force && pcStatusCache) return pcStatusCache;
  const r = await ps("Get-PCStatus.ps1", [], undefined, 90000);
  // Cache only a successful probe, so a transient failure isn't pinned until the
  // next reboot; the next call re-probes.
  if (r.ok) pcStatusCache = r;
  return r;
});

// Executes ONE onboarding step on the local machine. Steps have very different
// runtimes (a large installer can take many minutes), so each gets its own
// timeout. The domain-join step reuses the session credentials (passed as
// AD_USER/AD_PASSWORD by runPS) for Add-Computer.
handle("ad:onboard-step", async (_e, rawParams) => {
  const p = (rawParams ?? {}) as {
    step?: string;
    newName?: string;
    anyConnectSource?: string;
    screenConnectSource?: string;
    targetOU?: string;
    printers?: string[];
    printerSource?: string;
    smlPlayerSource?: string;
    smlPlayerIni?: string;
    description?: string;
  };
  const step = (p.step ?? "").trim().toLowerCase();
  if (!step) return { ok: false, error: "Passo em falta." };

  const TIMEOUTS: Record<string, number> = {
    regional: 60_000,
    anyconnect: 10 * 60_000,
    screenconnect: 10 * 60_000,
    smlplayer: 15 * 60_000,
    printers: 10 * 60_000,
    domain: 3 * 60_000,
  };
  if (!(step in TIMEOUTS)) return { ok: false, error: `Passo desconhecido: ${step}` };

  // The domain step needs the operator's AD credentials; without a session the
  // join would fall back to the local Windows user and fail confusingly.
  if (step === "domain" && !session) {
    return { ok: false, error: "Sessão expirada. Volta a iniciar sessão e tenta de novo." };
  }

  // Printer names are a comma-joined ASCII list (e.g. "ADM,COM1"); paths carry no
  // secrets. Positional order MUST match Invoke-OnboardStep.ps1's param() block.
  const printers = Array.isArray(p.printers)
    ? p.printers.filter((s) => typeof s === "string" && s.trim()).join(",")
    : "";
  const args = [
    step,
    p.newName ?? "",
    p.anyConnectSource ?? "",
    p.screenConnectSource ?? "",
    p.targetOU ?? "",
    printers,
    p.printerSource ?? "",
    p.smlPlayerSource ?? "",
    p.smlPlayerIni ?? "",
    p.description ?? "",
  ];
  return ps("Invoke-OnboardStep.ps1", args, undefined, TIMEOUTS[step]);
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
  // A new session may see different AD state than the pre-login probe did; start
  // the PC status cache fresh so the onboarding checklist reflects this login.
  pcStatusCache = null;

  // Remember only the username (non-secret) for pre-fill next time.
  const settings = readSettings();
  if (settings.lastUsername !== username) writeSettings({ ...settings, lastUsername: username });

  pushLog({ level: "success", source: "app", label: "auth", detail: `Login ${username} @ ${data.domain ?? "domínio"}` });
  return { ok: true, username, displayName: data.displayName, domain: data.domain, dc: data.dc };
});

handle("auth:logout", () => {
  session = null;
  pcStatusCache = null;
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
  if (!r.ok) return { ok: false, error: r.error };
  // Test-ADConnection.ps1 always exits 0 and signals failure via data.success
  // (a non-zero exit would lose the real reason). So the exit code alone isn't
  // enough — a broken AD (RSAT missing, bad creds, fast DC error) would keep the
  // liveness dot green. Key the dot on the actual result.
  const data = (r.data ?? {}) as { success?: boolean; error?: string };
  return { ok: data.success !== false, error: data.error };
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
  connectionStore.write(next);
});

// Runs a test using the given values (if provided) instead of the saved ones,
// so the user can verify before saving. Falls back to saved config otherwise.
handle("ad:test-connection", async (_e, rawOverride) => {
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
  const r = await runPS("Test-ADConnection.ps1", [], emitLog, conn);
  if (!r.ok) return r;
  // The script always exits 0 and reports failure via data.success — so a wrong
  // password, missing RSAT, or a fast DC error would otherwise show "Connection
  // successful". Translate a false result into a real error (mirrors auth:login).
  const data = (r.data ?? {}) as { success?: boolean; error?: string };
  if (data.success === false) {
    return { ok: false, error: data.error ?? "Não foi possível ligar ao AD." };
  }
  return r;
});

// --- Device onboarding config IPC ---
handle("config:get-device-config", () => readDeviceConfig());
handle("config:set-device-config", (_e, rawPayload) => {
  const p = (rawPayload ?? {}) as Partial<DeviceConfig>;
  const current = readDeviceConfig();
  const next: DeviceConfig = {
    ouMap: p.ouMap && typeof p.ouMap === "object" ? (p.ouMap as Record<string, string>) : current.ouMap,
    anyConnectSource: p.anyConnectSource !== undefined ? String(p.anyConnectSource) : current.anyConnectSource,
    screenConnectSource: p.screenConnectSource !== undefined ? String(p.screenConnectSource) : current.screenConnectSource,
    printerMap: p.printerMap !== undefined ? normalizePrinterMap(p.printerMap) : current.printerMap,
    printerSource: p.printerSource !== undefined ? String(p.printerSource) : current.printerSource,
    smlPlayerSource: p.smlPlayerSource !== undefined ? String(p.smlPlayerSource) : current.smlPlayerSource,
    smlPlayerIni: p.smlPlayerIni !== undefined ? String(p.smlPlayerIni) : current.smlPlayerIni,
  };
  writeDeviceConfig(next);
  return next;
});

// Lists the destination folders (sub-OUs under O365 in the BMAP Devices tree) so
// Settings can offer them as options for the department -> OU map.
handle("ad:device-ous", async () => {
  return ps("Get-DeviceOU-All.ps1");
});

// Lists every computer object under the BMAP Devices tree (read-only) for the
// Manager's device list. Can return the whole fleet, so it gets a longer ceiling
// than a normal AD call (like the PC-status probe).
handle("ad:get-devices", async () => {
  return ps("Get-ADComputer-All.ps1", [], undefined, 60000);
});

// Computes the next available PT-LPT-<DEPT>-<NN> name (lowest free number).
handle("ad:next-device-name", async (_e, dept) => {
  return ps("Get-NextDeviceName.ps1", [String(dept ?? "")]);
});

// --- PC onboarding state IPC ---
// The renderer owns the wizard; main just persists its state across the domain
// reboot and keeps start-on-boot in sync so the run can resume automatically.
handle("onboard:get-state", () => readOnboardState());
handle("onboard:set-state", (_e, rawPayload) => {
  const next = normalizeOnboardState(rawPayload);
  writeOnboardState(next);
  syncLoginItem(!!next?.active);
  return next;
});
handle("onboard:clear-state", () => {
  clearOnboardState();
  syncLoginItem(false);
  // The run is over; let the next status call re-probe from scratch.
  pcStatusCache = null;
  return { ok: true };
});
handle("onboard:reboot", () => {
  pushLog({ level: "info", source: "app", label: "onboard", detail: "A reiniciar para concluir o onboarding…" });
  // Give the renderer a beat to finish persisting state / painting before we go.
  setTimeout(() => rebootMachine(), 500);
  return { ok: true };
});

// --- Console / activity log IPC ---
// Registered on raw ipcMain (not the logging `handle` wrapper) so reading or
// clearing the log doesn't itself generate log noise or recurse.
ipcMain.handle("console:get-history", () => getHistory());
ipcMain.handle("console:clear", () => { clearHistory(); });
// Open (or focus) the detached Console window. Raw ipcMain.on — fire-and-forget,
// no result, and it must not itself generate log noise.
ipcMain.on("console:open-window", () => openConsoleWindow());
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
