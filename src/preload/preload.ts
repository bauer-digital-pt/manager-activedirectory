import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("configAPI", {
  getGroups: () => ipcRenderer.invoke("config:get-groups"),
  setGroups: (groups: unknown) => ipcRenderer.invoke("config:set-groups", groups),
  getConnection: () => ipcRenderer.invoke("config:get-connection"),
  setConnection: (conn: unknown) => ipcRenderer.invoke("config:set-connection", conn),
});

contextBridge.exposeInMainWorld("consoleAPI", {
  onLog: (cb: (entry: unknown) => void) => {
    ipcRenderer.on("console:log", (_e, entry) => cb(entry));
    return () => ipcRenderer.removeAllListeners("console:log");
  },
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
});

contextBridge.exposeInMainWorld("updatesAPI", {
  check: () => ipcRenderer.invoke("updates:check"),
  install: () => ipcRenderer.invoke("updates:install"),
  onStatus: (cb: (status: unknown) => void) => {
    const listener = (_e: unknown, status: unknown) => cb(status);
    ipcRenderer.on("updates:status", listener);
    return () => ipcRenderer.removeListener("updates:status", listener);
  },
});
