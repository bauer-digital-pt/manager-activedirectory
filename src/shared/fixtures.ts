// One fake AD directory shared by both mock layers: the browser adAPI mock
// (src/renderer/src/adAPI.ts, used by `dev:browser`) and the Electron MOCK_PS
// ps-runner mock (src/main/ps-runner.ts). Keeping a single source means adding a
// test person shows up consistently in both, instead of the two lists drifting.
// Only ever loaded in dev/mock paths — never on a real AD.
import type { ADUser, ADUserLite } from "./types";

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
