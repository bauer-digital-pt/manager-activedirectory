import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { spawn } from "child_process";
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
    backgroundColor: "#ffffff",
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
      sendToRenderer("ad:install-progress", { state: "error", message: error });
      resolve({ ok: false, error });
      return;
    }

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
      sendToRenderer("ad:install-progress", { state: "error", message: error });
      resolve({ ok: false, error });
    });

    dism.on("close", (code) => {
      if (code === 0 || code === 3010) {
        const rebootRequired = code === 3010;
        sendToRenderer("ad:install-progress", { state: "done", percent: 100, rebootRequired });
        resolve({ ok: true, rebootRequired });
      } else {
        const error = friendlyInstallError(buf, code);
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

// Installs the RSAT ActiveDirectory module via DISM, streaming progress to the
// renderer on "ad:install-progress". Resolves with the final outcome.
ipcMain.handle("ad:install-module", async () => {
  return installADModule();
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
