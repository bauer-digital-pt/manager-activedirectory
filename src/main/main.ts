import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import electronUpdater from "electron-updater";
import { runPS, type ADConnection } from "./ps-runner";

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
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
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

  autoUpdater.on("update-available", (info) =>
    sendToRenderer("updates:status", { state: "available", version: info.version }));
  autoUpdater.on("update-not-available", () =>
    sendToRenderer("updates:status", { state: "none" }));
  autoUpdater.on("download-progress", (p) =>
    sendToRenderer("updates:status", { state: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) =>
    sendToRenderer("updates:status", { state: "downloaded", version: info.version }));
  autoUpdater.on("error", (err) =>
    sendToRenderer("updates:status", { state: "error", message: String(err?.message ?? err) }));

  autoUpdater.checkForUpdates().catch(() => { /* offline / no releases yet */ });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// --- IPC handlers ---

function emitLog(entry: import("./ps-runner").LogEntry) {
  if (!mainWindow) return;
  mainWindow.webContents.send("console:log", entry);
}

function ps(script: string, args: string[] = []) {
  return runPS(script, args, emitLog, getConnection());
}

ipcMain.handle("ad:get-groups", async () => {
  return ps("Get-ADGroup-All.ps1");
});

ipcMain.handle("ad:get-group-members", async (_e, groupName: string) => {
  return ps("Get-ADGroupMembers.ps1", [groupName]);
});

ipcMain.handle("ad:create-user", async (_e, params: Record<string, string>) => {
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

ipcMain.handle("ad:reset-password", async (_e, params: { username: string; newPassword: string }) => {
  return ps("Reset-ADPassword.ps1", [params.username, params.newPassword]);
});

ipcMain.handle("ad:unlock-user", async (_e, username: string) => {
  return ps("Unlock-ADUser.ps1", [username]);
});

ipcMain.handle("ad:add-group-permission", async (_e, params: { groupName: string; description: string }) => {
  return ps("Add-ADGroup.ps1", [params.groupName, params.description]);
});

ipcMain.handle("ad:remove-group", async (_e, groupName: string) => {
  return ps("Remove-ADGroup.ps1", [groupName]);
});

// Reports whether the RSAT ActiveDirectory module is installed on this machine.
ipcMain.handle("ad:check-module", async () => {
  return ps("Check-ADModule.ps1");
});

// --- Update IPC ---
ipcMain.handle("updates:check", async () => {
  if (!app.isPackaged) return { ok: false, error: "Updates only run in the installed app." };
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r?.updateInfo?.version };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle("updates:install", () => {
  autoUpdater.quitAndInstall();
});

// --- Config IPC ---
ipcMain.handle("config:get-groups", () => readGroups());
ipcMain.handle("config:set-groups", (_e, groups: Record<string, unknown>) => { writeGroups(groups); });

// --- Connection IPC ---
// Never returns the password itself — only whether one is stored.
ipcMain.handle("config:get-connection", () => {
  const stored = readStoredConnection();
  return { server: stored.server, username: stored.username, hasPassword: !!stored.password };
});

ipcMain.handle("config:set-connection", (_e, payload: { server: string; username: string; password?: string }) => {
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
ipcMain.handle("ad:test-connection", (_e, override?: { server: string; username: string; password?: string }) => {
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
