import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("configAPI", {
  getGroups: () => ipcRenderer.invoke("config:get-groups"),
  setGroups: (groups: unknown) => ipcRenderer.invoke("config:set-groups", groups),
  getConnection: () => ipcRenderer.invoke("config:get-connection"),
  setConnection: (conn: unknown) => ipcRenderer.invoke("config:set-connection", conn),
  getSettings: () => ipcRenderer.invoke("config:get-settings"),
  setSettings: (settings: unknown) => ipcRenderer.invoke("config:set-settings", settings),
});

contextBridge.exposeInMainWorld("authAPI", {
  login: (creds: { username: string; password: string }) => ipcRenderer.invoke("auth:login", creds),
  logout: () => ipcRenderer.invoke("auth:logout"),
  status: () => ipcRenderer.invoke("auth:status"),
  ping: () => ipcRenderer.invoke("auth:ping"),
});

contextBridge.exposeInMainWorld("appAPI", {
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  getStartupInfo: () => ipcRenderer.invoke("app:startup-info"),
  platform: process.platform,
});

contextBridge.exposeInMainWorld("windowAPI", {
  minimize: () => ipcRenderer.send("window:minimize"),
  toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
  close: () => ipcRenderer.send("window:close"),
});

contextBridge.exposeInMainWorld("consoleAPI", {
  onLog: (cb: (entry: unknown) => void) => {
    const listener = (_e: unknown, entry: unknown) => cb(entry);
    ipcRenderer.on("console:log", listener);
    return () => ipcRenderer.removeListener("console:log", listener);
  },
  // Back-fill everything logged before the Console page mounted (startup module
  // check, group load, window loads, etc.).
  getHistory: () => ipcRenderer.invoke("console:get-history"),
  clear: () => ipcRenderer.invoke("console:clear"),
  // Report a renderer-side event (uncaught error, unhandled rejection) into the
  // shared activity log so it shows alongside main-process activity.
  report: (entry: unknown) => ipcRenderer.send("console:report", entry),
});

contextBridge.exposeInMainWorld("adAPI", {
  getGroups: () => ipcRenderer.invoke("ad:get-groups"),
  getGroupMembers: (groupName: string) => ipcRenderer.invoke("ad:get-group-members", groupName),
  createUser: (params: Record<string, string>) => ipcRenderer.invoke("ad:create-user", params),
  resetPassword: (params: { username: string; newPassword: string }) =>
    ipcRenderer.invoke("ad:reset-password", params),
  unlockUser: (username: string) => ipcRenderer.invoke("ad:unlock-user", username),
  addGroupPermission: (params: { groupName: string; description: string }) =>
    ipcRenderer.invoke("ad:add-group-permission", params),
  removeGroup: (groupName: string) => ipcRenderer.invoke("ad:remove-group", groupName),
  testConnection: (override?: unknown) => ipcRenderer.invoke("ad:test-connection", override),
  checkModule: () => ipcRenderer.invoke("ad:check-module"),
  installModule: () => ipcRenderer.invoke("ad:install-module"),
  onInstallProgress: (cb: (status: unknown) => void) => {
    const listener = (_e: unknown, status: unknown) => cb(status);
    ipcRenderer.on("ad:install-progress", listener);
    return () => ipcRenderer.removeListener("ad:install-progress", listener);
  },
});

contextBridge.exposeInMainWorld("updatesAPI", {
  check: () => ipcRenderer.invoke("updates:check"),
  download: () => ipcRenderer.invoke("updates:download"),
  install: () => ipcRenderer.invoke("updates:install"),
  onStatus: (cb: (status: unknown) => void) => {
    const listener = (_e: unknown, status: unknown) => cb(status);
    ipcRenderer.on("updates:status", listener);
    return () => ipcRenderer.removeListener("updates:status", listener);
  },
});
