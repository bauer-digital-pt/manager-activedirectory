import type { DeviceConfig } from "./deviceConfig";
import type { AppSettings, InventoryConfigInfo, InventoryConfigPayload } from "../../../shared/types";

export type { AppSettings } from "../../../shared/types";

export interface GroupEntry {
  adGroups:   string[];
  jobTitles:  string[];
  department: string;
  // SamAccountName of the user this group copies group memberships from by
  // default. Pre-selected in the create-user wizard; "" / undefined = none.
  defaultTemplateUser?: string;
}

export type GroupConfig = Record<string, GroupEntry>;

export const DEFAULT_GROUPS: GroupConfig = {
  ADMINISTRACAO: { adGroups: [], department: "Administração",  jobTitles: ["Assistente Administrativo", "Coordenador Administrativo", "Diretor Administrativo", "Gestor de Recursos Humanos", "Secretária de Direção"] },
  CIDADE:        { adGroups: [], department: "Rádio Cidade",   jobTitles: ["Apresentador", "Editor", "Jornalista", "Pivot", "Produtor", "Repórter"] },
  COMERCIAL:     { adGroups: [], department: "Comercial",      jobTitles: ["Account Manager", "Coordenador Comercial", "Diretor Comercial", "Gestor de Contas", "Técnico Comercial"] },
  COPERACOES:    { adGroups: [], department: "Operações",      jobTitles: ["Coordenador de Operações", "Gestor de Operações", "Técnico de Operações"] },
  IT:            { adGroups: [], department: "IT",             jobTitles: ["Administrador de Sistemas", "Engenheiro de Infraestrutura", "Helpdesk", "Técnico de IT"] },
  M80:           { adGroups: [], department: "M80",            jobTitles: ["Apresentador", "Editor", "Jornalista", "Pivot", "Produtor", "Repórter"] },
  MANUTENCAO:    { adGroups: [], department: "Manutenção",     jobTitles: ["Eletricista", "Técnico de Manutenção", "Técnico de Instalações"] },
  MARKETING:     { adGroups: [], department: "Marketing",      jobTitles: ["Community Manager", "Coordenador de Marketing", "Designer", "Gestor de Marketing", "Social Media Manager"] },
  MULTIMEDIA:    { adGroups: [], department: "Multimédia",     jobTitles: ["Designer Gráfico", "Editor de Vídeo", "Motion Designer", "Operador de Câmara", "Técnico Multimédia"] },
  PUBLICIDADE:   { adGroups: [], department: "Publicidade",    jobTitles: ["Account Manager", "Diretor de Arte", "Gestor de Publicidade", "Técnico de Publicidade", "Traffic Manager"] },
  REDACAO:       { adGroups: [], department: "Redação",        jobTitles: ["Chefe de Redação", "Editor", "Jornalista", "Pivot", "Repórter"] },
  TECHOPS:       { adGroups: [], department: "TechOps",        jobTitles: ["Engenheiro de Broadcast", "Técnico de Broadcast", "Técnico de Emissão", "Técnico de Sistemas"] },
  TRAFEGO:       { adGroups: [], department: "Tráfego",        jobTitles: ["Coordenador de Tráfego", "Gestor de Tráfego", "Técnico de Tráfego"] },
};

const LS_KEY = "admanager.groupsConfig";

declare global {
  interface Window {
    configAPI?: {
      getGroups(): Promise<GroupConfig>;
      setGroups(config: GroupConfig): Promise<void>;
      getConnection(): Promise<{ server: string; username: string; hasPassword: boolean }>;
      setConnection(conn: { server: string; username: string; password?: string }): Promise<void>;
      getSettings(): Promise<AppSettings>;
      setSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
      getDeviceConfig(): Promise<DeviceConfig>;
      setDeviceConfig(config: Partial<DeviceConfig>): Promise<DeviceConfig>;
      getInventory(): Promise<InventoryConfigInfo>;
      setInventory(config: InventoryConfigPayload): Promise<InventoryConfigInfo>;
    };
    authAPI?: {
      login(creds: { username: string; password: string; baseUrl?: string }): Promise<{ ok: boolean; username?: string; displayName?: string; domain?: string; dc?: string; error?: string }>;
      logout(): Promise<{ ok: boolean }>;
      status(): Promise<{ ok: boolean; authenticated: boolean; username: string; lastUsername: string }>;
      ping(): Promise<{ ok: boolean; error?: string }>;
      reverify(password: string): Promise<{ ok: boolean; error?: string }>;
    };
    appAPI?: {
      getVersion(): Promise<string>;
      getStartupInfo?(): Promise<{ version: string; justUpdated: boolean; previousVersion?: string }>;
      getSsid?(): Promise<{ ok: boolean; data?: { connected: boolean; ssid: string | null; ssids?: string[] }; error?: string }>;
      // Present only in Electron: open an http/https URL in the default browser.
      openExternal?(url: string): Promise<{ ok: boolean; error?: string }>;
      platform: string;
    };
    windowAPI?: {
      minimize(): void;
      toggleMaximize(): void;
      close(): void;
    };
  }
}

// Migrate from old format where values were string[] (list of AD groups)
function migrate(raw: Record<string, unknown>): GroupConfig {
  const result: GroupConfig = {};
  for (const [key, val] of Object.entries(raw)) {
    if (Array.isArray(val)) {
      // Old format: string[] was the adGroups list
      const defaults = DEFAULT_GROUPS[key];
      result[key] = {
        adGroups:   val as string[],
        jobTitles:  defaults?.jobTitles  ?? [],
        department: defaults?.department ?? "",
        defaultTemplateUser: "",
      };
    } else if (val && typeof val === "object") {
      const entry = val as Partial<GroupEntry>;
      result[key] = {
        adGroups:   entry.adGroups   ?? [],
        jobTitles:  entry.jobTitles  ?? [],
        department: entry.department ?? "",
        defaultTemplateUser: entry.defaultTemplateUser ?? "",
      };
    }
  }
  return result;
}

export async function getGroupConfig(): Promise<GroupConfig> {
  try {
    if (window.configAPI) {
      const raw = await window.configAPI.getGroups();
      return migrate(raw as Record<string, unknown>);
    }
    const stored = localStorage.getItem(LS_KEY);
    if (stored) return migrate(JSON.parse(stored));
  } catch { /* fall through */ }
  return structuredClone(DEFAULT_GROUPS);
}

export async function setGroupConfig(config: GroupConfig): Promise<void> {
  if (window.configAPI) return window.configAPI.setGroups(config);
  localStorage.setItem(LS_KEY, JSON.stringify(config));
}
