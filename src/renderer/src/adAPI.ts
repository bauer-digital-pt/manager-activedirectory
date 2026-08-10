// Type-safe wrapper around window.adAPI injected by the preload script

export interface ADGroup {
  Name: string;
  Description: string;
  GroupCategory: string;
  GroupScope: string;
}

export interface ADUser {
  SamAccountName: string;
  DisplayName: string;
  EmailAddress: string;
  Enabled: boolean;
  LockedOut: boolean;
  // Extended fields (populated when fetched with -Properties *)
  GivenName?: string;
  Surname?: string;
  Title?: string;
  Department?: string;
  Company?: string;
  Description?: string;
  StreetAddress?: string;
  City?: string;
  PostalCode?: string;
  Office?: string;
  DistinguishedName?: string;
  UserPrincipalName?: string;
}

interface PSResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// Streamed progress while installing the RSAT ActiveDirectory module.
export type InstallProgress =
  | { state: "installing"; percent: number; message?: string }
  | { state: "done"; percent: number; rebootRequired?: boolean }
  | { state: "error"; message: string; code?: number };

export interface InstallResult {
  ok: boolean;
  rebootRequired?: boolean;
  error?: string;
}

declare global {
  interface Window {
    adAPI: {
      getGroups(): Promise<PSResult<ADGroup[]>>;
      getGroupMembers(groupName: string): Promise<PSResult<ADUser[]>>;
      // params may include: firstName, lastName, username, password, groupName,
      // description, street, city, postalCode, changePasswordAtLogon,
      // passwordNeverExpires, jobTitle, department, company, email
      createUser(params: Record<string, string>): Promise<PSResult>;
      resetPassword(params: { username: string; newPassword: string }): Promise<PSResult>;
      unlockUser(username: string): Promise<PSResult>;
      addGroupPermission(params: { groupName: string; description: string }): Promise<PSResult>;
      removeGroup(groupName: string): Promise<PSResult>;
      testConnection(override?: { server: string; username: string; password?: string }): Promise<PSResult>;
      checkModule(): Promise<PSResult<{ available: boolean }>>;
      installModule(): Promise<InstallResult>;
      onInstallProgress(cb: (status: InstallProgress) => void): () => void;
    };
    consoleAPI?: {
      onLog(cb: (entry: unknown) => void): () => void;
      getHistory(): Promise<unknown[]>;
      clear(): Promise<void>;
      report(entry: { level?: string; source?: string; label?: string; detail?: string; data?: unknown }): void;
    };
  }
}

// --- Mock used when running in the browser (outside Electron) ---
import { getGroupConfig } from "./lib/groupsConfig";

const MOCK_USERS: Record<string, ADUser[]> = {
  IT: [
    { SamAccountName: "jsilva",    DisplayName: "João Silva",     EmailAddress: "jsilva@empresa.pt",    Enabled: true,  LockedOut: false },
    { SamAccountName: "mcosta",    DisplayName: "Maria Costa",    EmailAddress: "mcosta@empresa.pt",    Enabled: true,  LockedOut: true  },
    { SamAccountName: "aferreira", DisplayName: "Ana Ferreira",   EmailAddress: "aferreira@empresa.pt", Enabled: false, LockedOut: false },
  ],
  REDACAO: [
    { SamAccountName: "psousa",    DisplayName: "Pedro Sousa",    EmailAddress: "psousa@empresa.pt",    Enabled: true,  LockedOut: false },
    { SamAccountName: "rlopes",    DisplayName: "Rita Lopes",     EmailAddress: "rlopes@empresa.pt",    Enabled: true,  LockedOut: false },
  ],
  MARKETING: [
    { SamAccountName: "tgomes",    DisplayName: "Tiago Gomes",    EmailAddress: "tgomes@empresa.pt",    Enabled: true,  LockedOut: false },
  ],
};

const delay = (ms = 600) => new Promise<void>((r) => setTimeout(r, ms));

// --- Mock install state (browser preview only) ---
// Force the setup screen with ?setup, force a failed install with ?setupfail.
const installListeners = new Set<(s: InstallProgress) => void>();
const emitInstall = (s: InstallProgress) => installListeners.forEach((l) => l(s));
let mockModuleInstalled = false;

const mockAPI: Window["adAPI"] = {
  getGroups: async () => {
    await delay();
    // Dev affordance: ?groupsfail simulates an unreachable/misconfigured AD.
    if (new URLSearchParams(location.search).has("groupsfail")) {
      return {
        ok: false,
        error:
          "Não foi possível contactar o servidor Active Directory. Confirma o endereço e as credenciais.",
      };
    }
    const config = await getGroupConfig();
    const data = Object.keys(config).map((n) => ({
      Name: n, Description: "", GroupCategory: "Security", GroupScope: "Global",
    }));
    // Dev affordance: ?baduser injects a malformed member (no DisplayName/Sam)
    // to prove the user row never crashes the app on bad AD data.
    if (new URLSearchParams(location.search).has("baduser") && data[0]) {
      MOCK_USERS[data[0].Name] = [
        ...(MOCK_USERS[data[0].Name] ?? []),
        { SamAccountName: undefined as unknown as string, DisplayName: undefined as unknown as string, EmailAddress: "", Enabled: true, LockedOut: false },
      ];
    }
    return { ok: true, data };
  },
  getGroupMembers: async (g) => { await delay(); return { ok: true, data: MOCK_USERS[g] ?? [] }; },
  createUser: async (p) => {
    await delay(900);
    if (!MOCK_USERS[p.groupName]) MOCK_USERS[p.groupName] = [];
    MOCK_USERS[p.groupName].push({ SamAccountName: p.username, DisplayName: `${p.firstName} ${p.lastName}`, EmailAddress: "", Enabled: true, LockedOut: false });
    return { ok: true };
  },
  resetPassword: async () => { await delay(); return { ok: true }; },
  unlockUser: async (u) => {
    await delay();
    for (const g of Object.values(MOCK_USERS)) {
      const user = g.find((x: ADUser) => x.SamAccountName === u);
      if (user) user.LockedOut = false;
    }
    return { ok: true };
  },
  addGroupPermission: async () => { await delay(); return { ok: true }; },
  removeGroup: async () => { await delay(); return { ok: true }; },
  testConnection: async (override) => {
    await delay(700);
    if (!override?.server) return { ok: false, error: "No server configured." };
    return { ok: true, data: { domain: "bmap.lis", forest: "bmap.lis", dc: override.server } };
  },
  checkModule: async () => {
    await delay(200);
    const forceMissing = new URLSearchParams(location.search).has("setup");
    return { ok: true, data: { available: mockModuleInstalled || !forceMissing } };
  },
  installModule: async () => {
    const shouldFail = new URLSearchParams(location.search).has("setupfail");
    emitInstall({ state: "installing", percent: 0, message: "A preparar a instalação…" });
    for (let p = 4; p <= 96; p += 4) {
      await delay(160);
      emitInstall({ state: "installing", percent: p, message: "A instalar componentes…" });
    }
    await delay(300);
    if (shouldFail) {
      const message =
        "O Windows Update / Funcionalidades Opcionais parece estar bloqueado por política nesta máquina " +
        "(erro 0x800f0954). Instala o RSAT manualmente com os passos abaixo, ou pede ao IT para permitir o " +
        "download de funcionalidades opcionais diretamente do Windows Update.";
      emitInstall({ state: "error", message });
      return { ok: false, error: message };
    }
    mockModuleInstalled = true;
    emitInstall({ state: "done", percent: 100 });
    return { ok: true };
  },
  onInstallProgress: (cb) => {
    installListeners.add(cb);
    return () => { installListeners.delete(cb); };
  },
};

if (!window.adAPI) {
  (window as Window).adAPI = mockAPI;
}

export const adAPI = {
  getGroups:            () => window.adAPI.getGroups(),
  getGroupMembers:      (g: string) => window.adAPI.getGroupMembers(g),
  createUser:           (p: Record<string, string>) => window.adAPI.createUser(p),
  resetPassword:        (p: { username: string; newPassword: string }) => window.adAPI.resetPassword(p),
  unlockUser:           (u: string) => window.adAPI.unlockUser(u),
  addGroupPermission:   (p: { groupName: string; description: string }) => window.adAPI.addGroupPermission(p),
  removeGroup:          (g: string) => window.adAPI.removeGroup(g),
  testConnection:       (o?: { server: string; username: string; password?: string }) => window.adAPI.testConnection(o),
  checkModule:          () => window.adAPI.checkModule(),
  installModule:        () => window.adAPI.installModule(),
  onInstallProgress:    (cb: (status: InstallProgress) => void) => window.adAPI.onInstallProgress(cb),
};
