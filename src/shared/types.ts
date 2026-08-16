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
  // Whether the account's password is currently expired. Both read paths derive
  // it live: PowerShell via Get-ADUser's `PasswordExpired` calculated property,
  // the inventory API via the 0x800000 bit on msDS-User-Account-Control-Computed.
  // Optional so an older API (or a record missing the field) reads as "unknown".
  PasswordExpired?: boolean;
  // Directory timestamps, pre-stringified as "yyyy-MM-dd HH:mm:ss" (PowerShell) or
  // ISO-8601 (inventory API). Power the Users page "Criação"/"Último update" sorts;
  // null/undefined when unset. WhenChanged is the account's last-modified time.
  WhenCreated?: string | null;
  WhenChanged?: string | null;
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

// A computer object listed by Get-ADComputer-All.ps1, powering the Manager's
// READ-ONLY device list (never written back). Covers the whole BMAP Devices tree.
export interface ADComputer {
  Name: string;
  DNSHostName?: string;
  // Windows/PowerShell always reports this; the inventory-API source (ldap3, Mac
  // fallback) carries no enabled flag, so it's left undefined there — callers must
  // treat undefined as "unknown", never as enabled.
  Enabled?: boolean;
  OperatingSystem?: string;
  OperatingSystemVersion?: string;
  // The AD-computer description — carries the "Preparado para <user>" text the
  // domain step stamps on during onboarding.
  Description?: string;
  DistinguishedName: string;
  // DN of the object set as ManagedBy (empty when unset).
  ManagedBy?: string;
  // Immediate parent OU folder under BMAP Devices -> O365 = the department.
  OU?: string;
  // Pre-stringified in the script as "yyyy-MM-dd HH:mm:ss" (a [datetime] would
  // otherwise serialize as /Date(ms)/); null when the attribute is unset.
  LastLogonDate?: string | null;
  WhenCreated?: string | null;
}

// --- PC onboarding ---
export type OnboardStep =
  | "regional" | "anyconnect" | "screenconnect" | "smlplayer" | "printers" | "domain";

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
  // Kiosk mode: a wall-mounted / always-on operator view. The session never
  // auto-logs-out on inactivity; Users + Devices auto-refresh so the live view
  // stays current; but privileged actions (reset/unlock/create) re-verify the
  // operator's password if it's been more than 10 minutes since the last auth.
  kioskMode: boolean;
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

// --- Inventory API (pyexp-inventory / InventorySystem) ---
// The internal, read-only HTTP API that reconciles EZOffice Inventory against AD,
// running on pt-srv-pyexp. The Manager consumes it over the LAN. There is NO token
// and NO service account: every request is signed with the user's own AD login
// (HTTP Basic) and the API binds to LDAP as that user. Manager-only — the Agent
// installer never talks to it.

// Persisted config (inventory.json). Only the address + master switch are stored;
// credentials come from the live login session, never from disk.
export interface InventoryConfig {
  // Base URL of the API, e.g. "https://10.4.0.20:8000" (trailing slash optional).
  baseUrl: string;
  // Master switch — when false the Manager surfaces nothing inventory-related.
  enabled: boolean;
}

// What config:get-inventory returns.
export interface InventoryConfigInfo {
  baseUrl: string;
  enabled: boolean;
}

// config:set-inventory payload.
export interface InventoryConfigPayload {
  baseUrl: string;
  enabled: boolean;
}

// Health probe (GET /healthz — open, no auth). `mode` is "live" for this build.
// directory_enabled + cache_age_seconds mirror the server's /healthz body; both
// optional so the type still fits an older API (or the test probe) that omits them.
export interface InventoryHealth {
  status: string;
  mode: string;
  version?: string;
  directory_enabled?: boolean;
  cache_age_seconds?: {
    assets: number | null;
    members: number | null;
    devices_ad: number | null;
    reconciliation: number | null;
  };
}

// EZOffice asset (GET /api/v1/assets) — snake_case, mirrors models.py EZAsset.
export interface InventoryAsset {
  asset_id: string;
  name: string;
  serial_number: string;
  category: string;
  status: string;
  purchased_on: string;
  assigned_user_email: string;
  exempt: boolean;
}

// EZOffice member (GET /api/v1/members) — mirrors models.py EZUser.
export interface InventoryMember {
  member_id: string;
  email: string;
  first_name: string;
  last_name: string;
  full_name: string;
  department: string;
  title: string;
  phone: string;
  active: boolean;
  exempt: boolean;
}

// AD-sourced device (GET /api/v1/devices/ad) — mirrors models.py SourceDevice.
// last_seen is ISO-8601 (or null when unset); source is the enum value ("ad").
export interface InventorySourceDevice {
  name: string;
  serial_number: string;
  platform: string;
  os_version: string;
  manufacturer: string;
  model: string;
  department: string;
  last_seen: string | null;
  assigned_user_email: string;
  logged_on_user: string;
  exempt: boolean;
  source: string;
}

// Reconciliation gauge counts. metrics-summary returns these flattened with ran_at.
export interface ReconciliationCounts {
  assets_total: number;
  members_total: number;
  members_active: number;
  devices_total: number;
  missing_in_ezoffice: number;
  missing_in_source: number;
  users_orphaned: number;
  orphaned_assets: number;
  stale_devices: number;
  errors: number;
}

// An EZOffice asset with no live AD device, or assigned to an inactive member.
export interface OrphanedAsset {
  name: string;
  serial_number: string;
  previous_user: string;
  reason: string; // "no source object" | "assigned to inactive user"
}

// An AD device whose last_seen is older than the stale window.
export interface StaleDevice {
  name: string;
  platform: string;
  last_seen: string | null;
  source: string;
}

// A would-be new EZOffice asset (device in AD, absent from EZOffice) — preview only.
export interface MissingDevice {
  name: string;
  serial_number: string;
  platform: string;
  source: string;
}

// A would-be new EZOffice member (user in AD, absent from EZOffice) — preview only.
export interface NewMember {
  email: string;
  display_name: string;
  source: string;
}

// Full reconciliation report (GET /api/v1/reconciliation). Read-only, dry-run: the
// "missing_*"/"new_*" lists are previews of what a sync WOULD create — nothing is
// ever written by the API.
export interface Reconciliation {
  ran_at: string;
  dry_run: boolean;
  counts: ReconciliationCounts;
  orphaned_assets: OrphanedAsset[];
  stale_devices: StaleDevice[];
  missing_in_ezoffice_devices: MissingDevice[];
  new_members: NewMember[];
  errors: string[];
}

// GET /api/v1/metrics-summary — ran_at + the gauge counts, flattened.
export type MetricsSummary = { ran_at: string } & ReconciliationCounts;
