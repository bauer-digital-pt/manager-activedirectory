// Type-safe wrapper around window.adAPI injected by the preload script

export interface ADGroup {
  Name: string;
  Description: string;
  GroupCategory: string;
  GroupScope: string;
  // Category folders are OUs under O365 — the exact OU DN, when available.
  DistinguishedName?: string;
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
  employeeType?: string;
  Company?: string;
  Description?: string;
  StreetAddress?: string;
  City?: string;
  PostalCode?: string;
  Office?: string;
  DistinguishedName?: string;
  UserPrincipalName?: string;
}

// Minimal user shape returned by the free-text search (Search-ADUser.ps1) — just
// enough to identify and label a person in the "prepared for" picker.
export interface ADUserLite {
  SamAccountName: string;
  DisplayName: string;
  Enabled?: boolean;
}

interface PSResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// --- PC onboarding (the machine the app is running on) ---
export type OnboardStep =
  | "regional" | "anyconnect" | "screenconnect" | "update" | "smlplayer" | "printers" | "domain";

// Read-only snapshot of the local machine's onboarding state (Get-PCStatus.ps1).
export interface PCStatus {
  hostname: string;
  domain: { joined: boolean; name: string; compliant: boolean };
  name: { value: string; compliant: boolean; pattern: string };
  software: { anyConnect: boolean; screenConnect: boolean };
  windowsUpdate: { checked: boolean; pending: number; upToDate: boolean };
  regional: { osLanguage: string; locale: string; geoId: number; geo: string; keyboard: string; compliant: boolean };
  departments: string[];
  onboarded: boolean;
}

export interface OnboardStepData {
  success?: boolean;
  step?: string;
  rebootRequired?: boolean;
  message?: string;
  installed?: number;
  newName?: string;
}

export interface OnboardStepParams {
  step: OnboardStep;
  newName?: string;
  anyConnectSource?: string;
  screenConnectSource?: string;
  // Destination folder Name (a sub-OU under O365 in the BMAP Devices tree) the
  // domain step should place the computer in. Empty = default location.
  targetOU?: string;
  // Printer names to configure (printers step) + the base folder holding the
  // add<NAME>.cmd scripts (RICOHPCL6).
  printers?: string[];
  printerSource?: string;
  // SMLPlayer installer + the Main.ini copied into %APPDATA%\SMLPlayer7 (smlplayer step).
  smlPlayerSource?: string;
  smlPlayerIni?: string;
  // Free-text description stamped onto the computer's AD object (domain step),
  // e.g. "Preparado para João Silva (jsilva)". Empty = leave it untouched.
  description?: string;
}

// Destination folder options for the device OU map. Get-DeviceOU-All.ps1 mirrors
// the ADGroup shape (Name/Description/DistinguishedName), so we reuse the type.
export type DeviceOU = ADGroup;

// Result of the next-available-name lookup (Get-NextDeviceName.ps1).
export interface NextDeviceName {
  dept: string;
  number: string;
  name: string;
}

// The "fully automatic" PC onboarding wizard state, persisted by main across the
// domain-join reboot so the run can resume on next launch. Never holds a password.
export interface OnboardState {
  active: boolean;
  dept: string;
  targetName: string;
  targetOU: string;
  anyConnectSource: string;
  screenConnectSource: string;
  // Printers to configure on this machine (its department's selection) + the
  // RICOHPCL6 base folder and SMLPlayer sources — captured at start so the run
  // resumes with the same inputs even if Settings change mid-flow.
  printers: string[];
  printerSource: string;
  smlPlayerSource: string;
  smlPlayerIni: string;
  // The person this machine is being prepared for. Written onto the computer's AD
  // description during the domain step. Optional — older persisted states (and
  // runs where the operator skipped it) simply have no value.
  preparedFor?: { sam: string; name: string };
  completed: string[]; // step keys already done
  startedAt: number;
  updatedAt: number;
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
      // Free-text AD user search for the PC-onboarding "prepared for" picker.
      searchUsers(query: string): Promise<PSResult<ADUserLite[]>>;
      // Offboard: disable + move to the morgue OU. Guarded in main by a username
      // re-type and an admin-password re-confirmation.
      offboardUser(params: { username: string; confirmUsername: string; adminPassword: string }): Promise<PSResult>;
      addGroupPermission(params: { groupName: string; description: string }): Promise<PSResult>;
      removeGroup(groupName: string): Promise<PSResult>;
      // PC onboarding: read the local machine's state, then run steps one at a time.
      // Status is cached in main for the whole process life; pass force to re-probe.
      getPCStatus(force?: boolean): Promise<PSResult<PCStatus>>;
      onboardStep(params: OnboardStepParams): Promise<PSResult<OnboardStepData>>;
      // Destination folders for the device OU map, and the next free PC name.
      getDeviceOUs(): Promise<PSResult<DeviceOU[]>>;
      getNextDeviceName(dept: string): Promise<PSResult<NextDeviceName>>;
      // Persisted auto-onboarding wizard state (survives the domain reboot).
      getOnboardState(): Promise<OnboardState | null>;
      setOnboardState(state: OnboardState | null): Promise<OnboardState | null>;
      clearOnboardState(): Promise<{ ok: boolean }>;
      reboot(): Promise<{ ok: boolean }>;
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
    { SamAccountName: "jsilva",    DisplayName: "João Silva",     EmailAddress: "jsilva@empresa.pt",    Enabled: true,  LockedOut: false, Title: "Técnico de Sistemas",    Department: "IT",        employeeType: "Efetivo" },
    { SamAccountName: "mcosta",    DisplayName: "Maria Costa",    EmailAddress: "mcosta@empresa.pt",    Enabled: true,  LockedOut: true,  Title: "Técnico de Sistemas",    Department: "IT",        employeeType: "Efetivo" },
    { SamAccountName: "aferreira", DisplayName: "Ana Ferreira",   EmailAddress: "aferreira@empresa.pt", Enabled: false, LockedOut: false, Title: "Administrador de Redes", Department: "IT",        employeeType: "Prestador" },
  ],
  REDACAO: [
    { SamAccountName: "psousa",    DisplayName: "Pedro Sousa",    EmailAddress: "psousa@empresa.pt",    Enabled: true,  LockedOut: false, Title: "Jornalista",            Department: "Redação",   employeeType: "Efetivo" },
    { SamAccountName: "rlopes",    DisplayName: "Rita Lopes",     EmailAddress: "rlopes@empresa.pt",    Enabled: true,  LockedOut: false, Title: "Jornalista",            Department: "Redação",   employeeType: "Efetivo" },
  ],
  MARKETING: [
    { SamAccountName: "tgomes",    DisplayName: "Tiago Gomes",    EmailAddress: "tgomes@empresa.pt",    Enabled: true,  LockedOut: false, Title: "Gestor de Marca",       Department: "Marketing", employeeType: "Efetivo" },
  ],
};

const delay = (ms = 600) => new Promise<void>((r) => setTimeout(r, ms));

// --- Mock PC-onboarding state (browser preview only) ---
// Mutable so running a step is reflected on the next status refresh.
// ?onboarded returns a fully-compliant machine; ?pcfail fails the status probe;
// ?stepfail fails every step.
const MOCK_DEPARTMENTS = ["ADM", "RCM", "CDD", "MKT", "NWS", "RTO", "COM", "DIG", "EVT", "HR", "IT", "LEG"];
const mockPC = {
  hostname: "DESKTOP-9F2K1B",
  domainJoined: false,
  domainName: "WORKGROUP",
  anyConnect: false,
  screenConnect: false,
  wuChecked: true,
  wuPending: 14,
  osLanguage: "pt-PT",
  locale: "pt-PT",
  geoId: 193,
  keyboard: "pt-PT",
};
function buildMockPCStatus(): PCStatus {
  const deptAlt = MOCK_DEPARTMENTS.join("|");
  const nameCompliant = new RegExp(`^PT-LPT-(${deptAlt})-\\d+$`).test(mockPC.hostname);
  const domainCompliant = mockPC.domainJoined && mockPC.domainName.toLowerCase() === "bmap.lis";
  const wuUpToDate = mockPC.wuChecked && mockPC.wuPending === 0;
  const regionalCompliant =
    mockPC.osLanguage.startsWith("en") && mockPC.geoId === 193 &&
    (mockPC.keyboard.startsWith("pt") || mockPC.locale.startsWith("pt"));
  return {
    hostname: mockPC.hostname,
    domain: { joined: mockPC.domainJoined, name: mockPC.domainName, compliant: domainCompliant },
    name: { value: mockPC.hostname, compliant: nameCompliant, pattern: "PT-LPT-<DEPT>-<NUMBER>" },
    software: { anyConnect: mockPC.anyConnect, screenConnect: mockPC.screenConnect },
    windowsUpdate: { checked: mockPC.wuChecked, pending: mockPC.wuPending, upToDate: wuUpToDate },
    regional: {
      osLanguage: mockPC.osLanguage, locale: mockPC.locale, geoId: mockPC.geoId,
      geo: mockPC.geoId === 193 ? "Portugal" : "", keyboard: mockPC.keyboard, compliant: regionalCompliant,
    },
    departments: MOCK_DEPARTMENTS,
    onboarded: domainCompliant && nameCompliant && mockPC.anyConnect && mockPC.screenConnect && wuUpToDate && regionalCompliant,
  };
}

// --- Mock device OUs + onboarding state (browser preview only) ---
// Destination folders under BMAP Devices → O365 that Settings maps departments to.
const MOCK_DEVICE_OUS: DeviceOU[] = [
  "ADMINISTRACAO", "MARKETING", "REDACAO", "COMERCIAL", "DIGITAL", "IT", "EVENTOS", "RECURSOS HUMANOS",
].map((n) => ({
  Name: n, Description: "", GroupCategory: "OU", GroupScope: "",
  DistinguishedName: `OU=${n},OU=O365,OU=BMAP Devices,DC=bmap,DC=lis`,
}));

// Persisted across reloads so the resume-on-launch path is testable in the browser.
// ?resume seeds an in-progress run (regional+update done) to exercise resume.
const MOCK_ONBOARD_KEY = "mock.onboardState";
function mockReadOnboardState(): OnboardState | null {
  try {
    const raw = localStorage.getItem(MOCK_ONBOARD_KEY);
    if (raw) { const s = JSON.parse(raw); return s && s.active ? (s as OnboardState) : null; }
  } catch { /* ignore */ }
  if (new URLSearchParams(location.search).has("resume")) {
    return {
      active: true, dept: "MKT", targetName: "PT-LPT-MKT-02", targetOU: "MARKETING",
      anyConnectSource: "", screenConnectSource: "",
      printers: ["MRK", "COM1"], printerSource: "", smlPlayerSource: "", smlPlayerIni: "",
      preparedFor: { sam: "tgomes", name: "Tiago Gomes" },
      completed: ["regional", "update"],
      startedAt: Date.now(), updatedAt: Date.now(),
    };
  }
  return null;
}
function mockWriteOnboardState(state: OnboardState | null): void {
  try {
    if (!state || !state.active) localStorage.removeItem(MOCK_ONBOARD_KEY);
    else localStorage.setItem(MOCK_ONBOARD_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

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
    MOCK_USERS[p.groupName].push({
      SamAccountName: p.username, DisplayName: `${p.firstName} ${p.lastName}`, EmailAddress: p.email ?? "",
      Enabled: true, LockedOut: false, Title: p.jobTitle || undefined, Department: p.department || undefined,
      employeeType: p.employeeType || undefined,
    });
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
  searchUsers: async (query) => {
    await delay(300);
    const q = (query ?? "").trim().toLowerCase();
    if (q.length < 2) return { ok: true, data: [] };
    // Flatten every mock category's members, dedupe by username, then substring-match.
    const seen = new Set<string>();
    const all: ADUserLite[] = [];
    for (const g of Object.values(MOCK_USERS)) {
      for (const u of g) {
        if (!u.SamAccountName || seen.has(u.SamAccountName)) continue;
        seen.add(u.SamAccountName);
        all.push({ SamAccountName: u.SamAccountName, DisplayName: u.DisplayName, Enabled: u.Enabled });
      }
    }
    const data = all
      .filter((u) => u.DisplayName?.toLowerCase().includes(q) || u.SamAccountName.toLowerCase().includes(q))
      .slice(0, 25);
    return { ok: true, data };
  },
  offboardUser: async ({ username, confirmUsername, adminPassword }) => {
    await delay(700);
    // Mirror the main-process safety gates so the flow is exercisable in dev.
    if (confirmUsername !== username) return { ok: false, error: "O username de confirmação não corresponde." };
    // Mock admin password: anything except "wrong" passes (matches the login mock).
    if (!adminPassword || adminPassword === "wrong") return { ok: false, error: "Palavra-passe de administrador incorreta." };
    // Moved to the morgue → drop it from its category list so a refresh reflects it.
    for (const g of Object.keys(MOCK_USERS)) {
      MOCK_USERS[g] = MOCK_USERS[g].filter((x: ADUser) => x.SamAccountName !== username);
    }
    return { ok: true };
  },
  addGroupPermission: async () => { await delay(); return { ok: true }; },
  removeGroup: async () => { await delay(); return { ok: true }; },
  getPCStatus: async (_force) => {
    await delay(500);
    const q = new URLSearchParams(location.search);
    if (q.has("pcfail")) return { ok: false, error: "Não foi possível obter o estado do PC." };
    if (q.has("onboarded")) {
      return {
        ok: true,
        data: {
          hostname: "PT-LPT-IT-07",
          domain: { joined: true, name: "bmap.lis", compliant: true },
          name: { value: "PT-LPT-IT-07", compliant: true, pattern: "PT-LPT-<DEPT>-<NUMBER>" },
          software: { anyConnect: true, screenConnect: true },
          windowsUpdate: { checked: true, pending: 0, upToDate: true },
          regional: { osLanguage: "en-US", locale: "pt-PT", geoId: 193, geo: "Portugal", keyboard: "pt-PT", compliant: true },
          departments: MOCK_DEPARTMENTS,
          onboarded: true,
        },
      };
    }
    return { ok: true, data: buildMockPCStatus() };
  },
  onboardStep: async ({ step, newName, targetOU, description }) => {
    await delay(1200);
    if (new URLSearchParams(location.search).has("stepfail")) {
      return { ok: false, error: "Falha simulada ao executar este passo." };
    }
    switch (step) {
      case "regional":
        mockPC.osLanguage = "en-US"; mockPC.geoId = 193; mockPC.keyboard = "pt-PT";
        return { ok: true, data: { success: true, step, rebootRequired: true, message: "Definições regionais aplicadas." } };
      case "anyconnect":
        mockPC.anyConnect = true;
        return { ok: true, data: { success: true, step, message: "Cisco AnyConnect instalado." } };
      case "screenconnect":
        mockPC.screenConnect = true;
        return { ok: true, data: { success: true, step, message: "ScreenConnect instalado." } };
      case "update":
        mockPC.wuPending = 0;
        return { ok: true, data: { success: true, step, installed: 14, rebootRequired: true, message: "Atualizações instaladas." } };
      case "smlplayer":
        return { ok: true, data: { success: true, step, message: "SMLPlayer instalado; aberto/fechado e Main.ini aplicado." } };
      case "printers":
        return { ok: true, data: { success: true, step, message: "Impressoras configuradas." } };
      case "domain": {
        if (!newName) return { ok: false, error: "Nome em falta." };
        mockPC.domainJoined = true; mockPC.domainName = "bmap.lis"; mockPC.hostname = newName;
        const extra = `${targetOU ? ` (pasta ${targetOU})` : ""}${description ? ` — ${description}` : ""}`;
        return { ok: true, data: { success: true, step, newName, rebootRequired: true, message: `Juntado ao domínio bmap.lis e renomeado${extra}.` } };
      }
      default:
        return { ok: false, error: `Passo desconhecido: ${step}` };
    }
  },
  getDeviceOUs: async () => { await delay(400); return { ok: true, data: MOCK_DEVICE_OUS }; },
  getNextDeviceName: async (dept) => {
    await delay(400);
    const d = (dept || "").trim().toUpperCase();
    if (!MOCK_DEPARTMENTS.includes(d)) return { ok: false, error: `Departamento inválido: ${d}.` };
    // No AD in the browser mock: the lowest free slot is simply 01.
    return { ok: true, data: { dept: d, number: "01", name: `PT-LPT-${d}-01` } };
  },
  getOnboardState: async () => { await delay(120); return mockReadOnboardState(); },
  setOnboardState: async (state) => { await delay(120); mockWriteOnboardState(state); return state; },
  clearOnboardState: async () => { await delay(120); mockWriteOnboardState(null); return { ok: true }; },
  reboot: async () => {
    await delay(120);
    // No real reboot in the browser: simulate the post-reboot machine so a resume
    // sees the domain join / rename that the domain step applied.
    mockPC.domainJoined = true; mockPC.domainName = "bmap.lis";
    return { ok: true };
  },
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

// True when running outside Electron (the browser preview uses the mock above).
// Detected via the config bridge, which only the preload injects.
export const isBrowserMock = typeof window.configAPI === "undefined";

if (!window.adAPI) {
  (window as Window).adAPI = mockAPI;
}

export const adAPI = {
  getGroups:            () => window.adAPI.getGroups(),
  getGroupMembers:      (g: string) => window.adAPI.getGroupMembers(g),
  createUser:           (p: Record<string, string>) => window.adAPI.createUser(p),
  resetPassword:        (p: { username: string; newPassword: string }) => window.adAPI.resetPassword(p),
  unlockUser:           (u: string) => window.adAPI.unlockUser(u),
  searchUsers:          (q: string) => window.adAPI.searchUsers(q),
  offboardUser:         (p: { username: string; confirmUsername: string; adminPassword: string }) => window.adAPI.offboardUser(p),
  addGroupPermission:   (p: { groupName: string; description: string }) => window.adAPI.addGroupPermission(p),
  removeGroup:          (g: string) => window.adAPI.removeGroup(g),
  getPCStatus:          (force?: boolean) => window.adAPI.getPCStatus(force),
  onboardStep:          (p: OnboardStepParams) => window.adAPI.onboardStep(p),
  getDeviceOUs:         () => window.adAPI.getDeviceOUs(),
  getNextDeviceName:    (dept: string) => window.adAPI.getNextDeviceName(dept),
  getOnboardState:      () => window.adAPI.getOnboardState(),
  setOnboardState:      (s: OnboardState | null) => window.adAPI.setOnboardState(s),
  clearOnboardState:    () => window.adAPI.clearOnboardState(),
  reboot:               () => window.adAPI.reboot(),
  testConnection:       (o?: { server: string; username: string; password?: string }) => window.adAPI.testConnection(o),
  checkModule:          () => window.adAPI.checkModule(),
  installModule:        () => window.adAPI.installModule(),
  onInstallProgress:    (cb: (status: InstallProgress) => void) => window.adAPI.onInstallProgress(cb),
};
