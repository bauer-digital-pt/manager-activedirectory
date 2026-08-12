// Device onboarding configuration: which destination folder (a sub-OU under O365
// in the BMAP Devices tree) each department's PCs should land in, the shared
// Cisco AnyConnect / ScreenConnect installer sources, the per-department printer
// selection (RICOHPCL6 add<NAME>.cmd scripts), and the SMLPlayer sources. Mirrors
// groupsConfig.ts — reads from the Electron config bridge when present, else
// localStorage (so the browser preview is fully exercisable).
import type { DeviceConfig } from "../../../shared/types";

export type { DeviceConfig } from "../../../shared/types";

// The 12 device department codes, kept in sync with Get-PCStatus.ps1,
// Get-NextDeviceName.ps1 and Invoke-OnboardStep.ps1's name-validation regex.
export const DEVICE_DEPARTMENTS = [
  "ADM", "RCM", "CDD", "MKT", "NWS", "RTO", "COM", "DIG", "EVT", "HR", "IT", "LEG",
] as const;
export type DeviceDepartment = (typeof DEVICE_DEPARTMENTS)[number];

// The printers available under \\pt-srv-nas\IT\Software\Printers\RICOHPCL6, each
// installed by an add<NAME>.cmd script. Selected per department in Settings.
export const AVAILABLE_PRINTERS = [
  "ADM", "ANT", "ANT32b", "CID", "COM1", "COM2", "CORRADM", "GRED", "MRK", "PRO", "PRO32b", "RED",
] as const;

const LS_KEY = "admanager.deviceConfig";

export const EMPTY_DEVICE_CONFIG: DeviceConfig = {
  ouMap: {},
  anyConnectSource: "",
  screenConnectSource: "",
  printerMap: {},
  printerSource: "",
  smlPlayerSource: "",
  smlPlayerIni: "",
};

// Coerce arbitrary stored/bridged data into a well-formed config so a corrupt
// file or an older shape can never crash a consumer.
function normalize(raw: unknown): DeviceConfig {
  const p = (raw ?? {}) as Partial<DeviceConfig>;
  const ouMap: Record<string, string> = {};
  if (p.ouMap && typeof p.ouMap === "object") {
    for (const [k, v] of Object.entries(p.ouMap as Record<string, unknown>)) {
      if (typeof v === "string" && v) ouMap[k] = v;
    }
  }
  const printerMap: Record<string, string[]> = {};
  if (p.printerMap && typeof p.printerMap === "object") {
    for (const [k, v] of Object.entries(p.printerMap as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        const list = v.filter((x): x is string => typeof x === "string" && !!x);
        if (list.length) printerMap[k] = list;
      }
    }
  }
  return {
    ouMap,
    anyConnectSource: typeof p.anyConnectSource === "string" ? p.anyConnectSource : "",
    screenConnectSource: typeof p.screenConnectSource === "string" ? p.screenConnectSource : "",
    printerMap,
    printerSource: typeof p.printerSource === "string" ? p.printerSource : "",
    smlPlayerSource: typeof p.smlPlayerSource === "string" ? p.smlPlayerSource : "",
    smlPlayerIni: typeof p.smlPlayerIni === "string" ? p.smlPlayerIni : "",
  };
}

export async function getDeviceConfig(): Promise<DeviceConfig> {
  try {
    if (window.configAPI?.getDeviceConfig) {
      return normalize(await window.configAPI.getDeviceConfig());
    }
    const stored = localStorage.getItem(LS_KEY);
    if (stored) return normalize(JSON.parse(stored));
  } catch { /* fall through */ }
  return structuredClone(EMPTY_DEVICE_CONFIG);
}

export async function setDeviceConfig(config: DeviceConfig): Promise<void> {
  const clean = normalize(config);
  if (window.configAPI?.setDeviceConfig) { await window.configAPI.setDeviceConfig(clean); return; }
  localStorage.setItem(LS_KEY, JSON.stringify(clean));
}
