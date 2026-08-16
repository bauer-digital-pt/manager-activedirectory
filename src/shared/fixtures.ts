// One fake AD directory shared by both mock layers: the browser adAPI mock
// (src/renderer/src/adAPI.ts, used by `dev:browser`) and the Electron MOCK_PS
// ps-runner mock (src/main/ps-runner.ts). Keeping a single source means adding a
// test person shows up consistently in both, instead of the two lists drifting.
// Only ever loaded in dev/mock paths — never on a real AD.
import type {
  ADUser, ADUserLite, ADComputer,
  InventoryAsset, InventoryMember, InventorySourceDevice, Reconciliation,
} from "./types";

export interface MockPerson extends ADUser {
  // Category / child-OU under O365 this person belongs to (a DEFAULT_GROUPS key).
  group: string;
}

export const MOCK_PEOPLE: readonly MockPerson[] = [
  { group: "IT",        SamAccountName: "joao.silva",   DisplayName: "João Silva",    EmailAddress: "joao.silva@bmap.lis",   Enabled: true,  LockedOut: false, PasswordExpired: false, Title: "Técnico de IT",             Department: "IT",        employeeType: "Efetivo",   WhenCreated: mockLogonStamp(340), WhenChanged: mockLogonStamp(12) },
  { group: "IT",        SamAccountName: "maria.costa",  DisplayName: "Maria Costa",   EmailAddress: "maria.costa@bmap.lis",  Enabled: true,  LockedOut: true,  PasswordExpired: false, Title: "Helpdesk",                  Department: "IT",        employeeType: "Efetivo",   WhenCreated: mockLogonStamp(210), WhenChanged: mockLogonStamp(2)  },
  { group: "IT",        SamAccountName: "ana.ferreira", DisplayName: "Ana Ferreira",  EmailAddress: "ana.ferreira@bmap.lis", Enabled: false, LockedOut: false, PasswordExpired: false, Title: "Administrador de Sistemas", Department: "IT",        employeeType: "Prestador", WhenCreated: mockLogonStamp(900), WhenChanged: mockLogonStamp(260) },
  { group: "REDACAO",   SamAccountName: "pedro.sousa",  DisplayName: "Pedro Sousa",   EmailAddress: "pedro.sousa@bmap.lis",  Enabled: true,  LockedOut: false, PasswordExpired: true,  Title: "Jornalista",                Department: "Redação",   employeeType: "Efetivo",   WhenCreated: mockLogonStamp(120), WhenChanged: mockLogonStamp(1)  },
  { group: "REDACAO",   SamAccountName: "rita.lopes",   DisplayName: "Rita Lopes",    EmailAddress: "rita.lopes@bmap.lis",   Enabled: true,  LockedOut: false, PasswordExpired: false, Title: "Editor",                    Department: "Redação",   employeeType: "Prestador", WhenCreated: mockLogonStamp(80),  WhenChanged: mockLogonStamp(30) },
  { group: "COMERCIAL", SamAccountName: "tiago.gomes",  DisplayName: "Tiago Gomes",   EmailAddress: "tiago.gomes@bmap.lis",  Enabled: true,  LockedOut: false, PasswordExpired: false, Title: "Account Manager",           Department: "Comercial", employeeType: "Efetivo",   WhenCreated: mockLogonStamp(45),  WhenChanged: mockLogonStamp(5)  },
];

// A fresh, mutable {category -> ADUser[]} map for the browser mock, which mutates
// it in place (createUser, unlockUser, offboard, ?baduser). Rebuilt per call so
// each caller gets its own copy and the canonical MOCK_PEOPLE stays untouched.
export function mockUsersByGroup(): Record<string, ADUser[]> {
  const out: Record<string, ADUser[]> = {};
  for (const p of MOCK_PEOPLE) {
    const { group, ...user } = p;
    if (!out[group]) out[group] = [];
    out[group].push({ ...user });
  }
  return out;
}

// De-duplicated ADUserLite pool for the free-text Search-ADUser mock.
export function mockSearchPool(): ADUserLite[] {
  const seen = new Set<string>();
  const out: ADUserLite[] = [];
  for (const p of MOCK_PEOPLE) {
    if (seen.has(p.SamAccountName)) continue;
    seen.add(p.SamAccountName);
    out.push({ SamAccountName: p.SamAccountName, DisplayName: p.DisplayName, Enabled: p.Enabled });
  }
  return out;
}

// A fake device fleet for the Manager's read-only device list. Spans several
// departments, OS versions, and activity states (recent / stale / disabled /
// never-logged-on) so the list, filters, and status logic are all exercisable in
// both mock paths. Dates are relative to "now" so the stale/active split stays
// meaningful over time. Rebuilt per call so no caller mutates the canonical data.
function mockLogonStamp(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function mockDevices(): ADComputer[] {
  const dn = (name: string, ou: string) => `CN=${name},OU=${ou},OU=O365,OU=BMAP Devices,DC=bmap,DC=lis`;
  const userDn = (cn: string, ou: string) => `CN=${cn},OU=${ou},OU=O365,OU=BMAP USERS,DC=bmap,DC=lis`;
  const win11 = "10.0 (22631)";
  const win10 = "10.0 (19045)";
  return [
    { Name: "PT-LPT-IT-01",  DNSHostName: "pt-lpt-it-01.bmap.lis",  Enabled: true,  OperatingSystem: "Windows 11 Pro",         OperatingSystemVersion: win11, Description: "Preparado para Joao Silva (joao.silva)",   OU: "IT",  LastLogonDate: mockLogonStamp(1),   WhenCreated: mockLogonStamp(340), ManagedBy: userDn("Joao Silva", "IT"),  DistinguishedName: dn("PT-LPT-IT-01", "IT") },
    { Name: "PT-LPT-IT-02",  DNSHostName: "pt-lpt-it-02.bmap.lis",  Enabled: true,  OperatingSystem: "Windows 11 Pro",         OperatingSystemVersion: win11, Description: "Preparado para Maria Costa (maria.costa)", OU: "IT",  LastLogonDate: mockLogonStamp(6),   WhenCreated: mockLogonStamp(210), ManagedBy: userDn("Maria Costa", "IT"), DistinguishedName: dn("PT-LPT-IT-02", "IT") },
    { Name: "PT-LPT-MKT-01", DNSHostName: "pt-lpt-mkt-01.bmap.lis", Enabled: true,  OperatingSystem: "Windows 11 Pro",         OperatingSystemVersion: win11, Description: "",                                        OU: "MKT", LastLogonDate: mockLogonStamp(3),   WhenCreated: mockLogonStamp(120), ManagedBy: "",                          DistinguishedName: dn("PT-LPT-MKT-01", "MKT") },
    { Name: "PT-LPT-MKT-02", DNSHostName: "pt-lpt-mkt-02.bmap.lis", Enabled: true,  OperatingSystem: "Windows 10 Pro",         OperatingSystemVersion: win10, Description: "Preparado para Tiago Gomes (tiago.gomes)", OU: "MKT", LastLogonDate: mockLogonStamp(140), WhenCreated: mockLogonStamp(520), ManagedBy: "",                          DistinguishedName: dn("PT-LPT-MKT-02", "MKT") },
    { Name: "PT-LPT-RCM-01", DNSHostName: "pt-lpt-rcm-01.bmap.lis", Enabled: true,  OperatingSystem: "Windows 11 Pro",         OperatingSystemVersion: win11, Description: "",                                        OU: "RCM", LastLogonDate: mockLogonStamp(11),  WhenCreated: mockLogonStamp(80),  ManagedBy: "",                          DistinguishedName: dn("PT-LPT-RCM-01", "RCM") },
    { Name: "PT-LPT-COM-01", DNSHostName: "pt-lpt-com-01.bmap.lis", Enabled: false, OperatingSystem: "Windows 10 Pro",         OperatingSystemVersion: win10, Description: "Substituido; aguarda abate",              OU: "COM", LastLogonDate: mockLogonStamp(260), WhenCreated: mockLogonStamp(900), ManagedBy: "",                          DistinguishedName: dn("PT-LPT-COM-01", "COM") },
    { Name: "PT-LPT-NWS-01", DNSHostName: "pt-lpt-nws-01.bmap.lis", Enabled: true,  OperatingSystem: "Windows 11 Enterprise",  OperatingSystemVersion: win11, Description: "",                                        OU: "NWS", LastLogonDate: mockLogonStamp(2),   WhenCreated: mockLogonStamp(45),  ManagedBy: "",                          DistinguishedName: dn("PT-LPT-NWS-01", "NWS") },
    { Name: "PT-LPT-HR-01",  DNSHostName: "pt-lpt-hr-01.bmap.lis",  Enabled: true,  OperatingSystem: "Windows 11 Pro",         OperatingSystemVersion: win11, Description: "",                                        OU: "HR",  LastLogonDate: null,                WhenCreated: mockLogonStamp(4),   ManagedBy: "",                          DistinguishedName: dn("PT-LPT-HR-01", "HR") },
    { Name: "PT-LPT-ADM-01", DNSHostName: "pt-lpt-adm-01.bmap.lis", Enabled: true,  OperatingSystem: "Windows 10 Pro",         OperatingSystemVersion: win10, Description: "Preparado para Ana Ferreira (ana.ferreira)", OU: "ADM", LastLogonDate: mockLogonStamp(28), WhenCreated: mockLogonStamp(430), ManagedBy: userDn("Ana Ferreira", "ADM"), DistinguishedName: dn("PT-LPT-ADM-01", "ADM") },
  ];
}

/* -------------------------------------------------------------------------- */
/* Inventory API mock (pyexp-inventory / InventorySystem)                      */
/*                                                                             */
/* A small, self-consistent EZOffice↔AD world for the browser preview of the  */
/* inventory dashboard: some assets are in sync, one is assigned to an         */
/* inactive member, one has no matching device, two AD devices are missing     */
/* from EZOffice (one of them stale). The reconciliation is derived from these */
/* lists so the counts never drift from the per-item findings.                 */

// ISO-8601 stamp relative to now (matches the API's datetime serialisation).
function mockIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400000).toISOString();
}

// EZOffice members mirror MOCK_PEOPLE by email; Ana Ferreira is inactive (she's
// also the disabled AD user), which drives the "assigned to inactive user" orphan.
export function mockMembers(): InventoryMember[] {
  const m = (
    member_id: string, email: string, first_name: string, last_name: string,
    department: string, title: string, active: boolean,
  ): InventoryMember => ({
    member_id, email, first_name, last_name, full_name: `${first_name} ${last_name}`,
    department, title, phone: "", active, exempt: false,
  });
  return [
    m("1", "joao.silva@bmap.lis",   "João",  "Silva",    "IT",        "Técnico de IT",             true),
    m("2", "maria.costa@bmap.lis",  "Maria", "Costa",    "IT",        "Helpdesk",                  true),
    m("3", "ana.ferreira@bmap.lis", "Ana",   "Ferreira", "IT",        "Administrador de Sistemas", false),
    m("4", "pedro.sousa@bmap.lis",  "Pedro", "Sousa",    "Redação",   "Jornalista",                true),
    m("5", "rita.lopes@bmap.lis",   "Rita",  "Lopes",    "Redação",   "Editor",                    true),
    m("6", "tiago.gomes@bmap.lis",  "Tiago", "Gomes",    "Comercial", "Account Manager",           true),
  ];
}

// EZOffice assets. IT-01/IT-02/ADM-01 have matching AD devices (in sync by
// serial); ADM-01 is assigned to the inactive Ana → orphan; MKT-01 has no
// matching device → "no source object" orphan.
export function mockAssets(): InventoryAsset[] {
  const a = (
    asset_id: string, name: string, serial_number: string, status: string, assigned_user_email: string,
  ): InventoryAsset => ({
    asset_id, name, serial_number, category: "Laptops", status,
    purchased_on: "", assigned_user_email, exempt: false,
  });
  return [
    a("1", "PT-LPT-IT-01",  "5CD1234ABC", "in use",    "joao.silva@bmap.lis"),
    a("2", "PT-LPT-IT-02",  "5CD5678DEF", "in use",    "maria.costa@bmap.lis"),
    a("3", "PT-LPT-ADM-01", "5CD9999XYZ", "in use",    "ana.ferreira@bmap.lis"),
    a("4", "PT-LPT-MKT-01", "5CDNOSRC00", "available", ""),
  ];
}

// AD-sourced devices. IT-01/IT-02/ADM-01 match assets by serial; RCM-01 and
// COM-01 have no matching asset (→ missing_in_ezoffice); COM-01 is also stale.
export function mockADSourceDevices(): InventorySourceDevice[] {
  const d = (
    name: string, serial_number: string, platform: string, daysAgo: number, assigned_user_email: string,
  ): InventorySourceDevice => ({
    name, serial_number, platform, os_version: "", manufacturer: "HP", model: "EliteBook",
    department: name.split("-")[2] ?? "", last_seen: mockIso(daysAgo),
    assigned_user_email, logged_on_user: "", exempt: false, source: "ad",
  });
  return [
    d("PT-LPT-IT-01",  "5CD1234ABC", "Windows 11 Pro", 1,   "joao.silva@bmap.lis"),
    d("PT-LPT-IT-02",  "5CD5678DEF", "Windows 11 Pro", 6,   "maria.costa@bmap.lis"),
    d("PT-LPT-ADM-01", "5CD9999XYZ", "Windows 10 Pro", 28,  "ana.ferreira@bmap.lis"),
    d("PT-LPT-RCM-01", "5CDMISS001", "Windows 11 Pro", 11,  ""),
    d("PT-LPT-COM-01", "5CDSTALE99", "Windows 10 Pro", 260, ""),
  ];
}

// A reconciliation derived from the three lists above, so the gauge counts always
// agree with the per-item findings the dashboard drills into.
export function mockReconciliation(): Reconciliation {
  const assets = mockAssets();
  const members = mockMembers();
  const devices = mockADSourceDevices();
  const orphaned_assets = [
    { name: "PT-LPT-ADM-01", serial_number: "5CD9999XYZ", previous_user: "ana.ferreira@bmap.lis", reason: "assigned to inactive user" },
    { name: "PT-LPT-MKT-01", serial_number: "5CDNOSRC00", previous_user: "", reason: "no source object" },
  ];
  const stale_devices = [
    { name: "PT-LPT-COM-01", platform: "Windows 10 Pro", last_seen: mockIso(260), source: "ad" },
  ];
  const missing_in_ezoffice_devices = [
    { name: "PT-LPT-RCM-01", serial_number: "5CDMISS001", platform: "Windows 11 Pro", source: "ad" },
    { name: "PT-LPT-COM-01", serial_number: "5CDSTALE99", platform: "Windows 10 Pro", source: "ad" },
  ];
  const new_members = [
    { email: "novo.colaborador@bmap.lis", display_name: "Novo Colaborador", source: "ad" },
  ];
  return {
    ran_at: mockIso(0),
    dry_run: true,
    counts: {
      assets_total: assets.length,
      members_total: members.length,
      members_active: members.filter((m) => m.active).length,
      devices_total: devices.length,
      missing_in_ezoffice: missing_in_ezoffice_devices.length,
      missing_in_source: orphaned_assets.filter((o) => o.reason === "no source object").length,
      users_orphaned: orphaned_assets.filter((o) => o.reason === "assigned to inactive user").length,
      orphaned_assets: orphaned_assets.length,
      stale_devices: stale_devices.length,
      errors: 0,
    },
    orphaned_assets,
    stale_devices,
    missing_in_ezoffice_devices,
    new_members,
    errors: [],
  };
}

// Title-case a username into a display name for the login mocks
// (afonso.queiroz -> "Afonso Queiroz"). Strips DOMAIN\ and @domain first.
export function titleCaseFromUsername(username: string): string {
  const bare = (username ?? "").replace(/^.*\\/, "").replace(/@.*$/, "");
  return bare
    .split(/[.\-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
