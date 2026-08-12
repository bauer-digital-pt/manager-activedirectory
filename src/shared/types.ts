// Types shared across the main, preload, and renderer processes.
//
// This module is the single source of truth for shapes that previously lived
// (and drifted) in more than one place — e.g. OnboardState, which once carried
// `preparedFor` in the renderer but not in main, so the field was silently
// dropped on persist. It must stay dependency-free (no DOM, no Node, no Electron
// imports) so both build contexts can consume it.
//
// Renderer-only shapes (PCStatus, DeviceOU, ConnectionInfo, LoginResult, …) are
// deliberately NOT here — they are not duplicated across the boundary. Each
// original module re-exports the shapes below, so existing imports keep working.

// --- Generic PS/IPC result envelope ---
export interface PSResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// --- Remote AD connection (plaintext, in-flight) ---
// The credentials handed to the PowerShell runner. The at-rest, safeStorage-
// encrypted variant (StoredConnection) stays private to the main process.
export interface ADConnection {
  server: string;
  username: string;
  password: string;
}

// --- AD directory read shapes ---
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

// --- PC onboarding ---
export type OnboardStep =
  | "regional" | "anyconnect" | "screenconnect" | "update" | "smlplayer" | "printers" | "domain";

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

// --- App settings (settings.json) ---
export interface AppSettings {
  devMode: boolean;
  loginTimeoutMin: number;
  lastUsername: string;
}

// --- Device onboarding config (device-config.json) ---
export interface DeviceConfig {
  // Department code -> destination OU folder Name (as listed by Get-DeviceOU-All.ps1).
  ouMap: Record<string, string>;
  anyConnectSource: string;
  screenConnectSource: string;
  // Department code -> list of printer names to configure on that department's PCs.
  // Each name maps to an add<NAME>.cmd script under the RICOHPCL6 folder.
  printerMap: Record<string, string[]>;
  // Base folder holding the printer add<NAME>.cmd scripts (RICOHPCL6). Empty =
  // the built-in NAS default applied at run time (see DevicesPage).
  printerSource: string;
  // SMLPlayer installer + the Main.ini copied into %APPDATA%\SMLPlayer7 after it.
  smlPlayerSource: string;
  smlPlayerIni: string;
}

// --- Startup / version info ---
export interface StartupInfo {
  version: string;
  justUpdated: boolean;
  previousVersion?: string;
}
