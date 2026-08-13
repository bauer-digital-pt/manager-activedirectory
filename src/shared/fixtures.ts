// One fake AD directory shared by both mock layers: the browser adAPI mock
// (src/renderer/src/adAPI.ts, used by `dev:browser`) and the Electron MOCK_PS
// ps-runner mock (src/main/ps-runner.ts). Keeping a single source means adding a
// test person shows up consistently in both, instead of the two lists drifting.
// Only ever loaded in dev/mock paths — never on a real AD.
import type { ADUser, ADUserLite, ADComputer } from "./types";

export interface MockPerson extends ADUser {
  // Category / child-OU under O365 this person belongs to (a DEFAULT_GROUPS key).
  group: string;
}

export const MOCK_PEOPLE: readonly MockPerson[] = [
  { group: "IT",        SamAccountName: "joao.silva",   DisplayName: "João Silva",    EmailAddress: "joao.silva@bmap.lis",   Enabled: true,  LockedOut: false, Title: "Técnico de IT",             Department: "IT",        employeeType: "Efetivo" },
  { group: "IT",        SamAccountName: "maria.costa",  DisplayName: "Maria Costa",   EmailAddress: "maria.costa@bmap.lis",  Enabled: true,  LockedOut: true,  Title: "Helpdesk",                  Department: "IT",        employeeType: "Efetivo" },
  { group: "IT",        SamAccountName: "ana.ferreira", DisplayName: "Ana Ferreira",  EmailAddress: "ana.ferreira@bmap.lis", Enabled: false, LockedOut: false, Title: "Administrador de Sistemas", Department: "IT",        employeeType: "Prestador" },
  { group: "REDACAO",   SamAccountName: "pedro.sousa",  DisplayName: "Pedro Sousa",   EmailAddress: "pedro.sousa@bmap.lis",  Enabled: true,  LockedOut: false, Title: "Jornalista",                Department: "Redação",   employeeType: "Efetivo" },
  { group: "REDACAO",   SamAccountName: "rita.lopes",   DisplayName: "Rita Lopes",    EmailAddress: "rita.lopes@bmap.lis",   Enabled: true,  LockedOut: false, Title: "Editor",                    Department: "Redação",   employeeType: "Efetivo" },
  { group: "COMERCIAL", SamAccountName: "tiago.gomes",  DisplayName: "Tiago Gomes",   EmailAddress: "tiago.gomes@bmap.lis",  Enabled: true,  LockedOut: false, Title: "Account Manager",           Department: "Comercial", employeeType: "Efetivo" },
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
