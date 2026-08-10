import { execFile } from "child_process";
import { join } from "path";
import { app } from "electron";

// PowerShell scripts can't be run from inside app.asar (execFile needs a real
// file path), so they are shipped via electron-builder `extraResources` and
// resolved from resourcesPath when packaged. In dev they live in the source tree.
const SCRIPTS_DIR = app.isPackaged
  ? join(process.resourcesPath, "ps-scripts")
  : join(app.getAppPath(), "src", "main", "ps-scripts");

// Set MOCK_PS=1 in env to intercept all PS calls and return fake data
const MOCK_MODE = process.env.MOCK_PS === "1";

// Remote AD connection details. When set, they are forwarded to the PS scripts
// as environment variables (AD_SERVER / AD_USER / AD_PASSWORD) so the AD cmdlets
// target a remote domain controller with explicit credentials. When empty, the
// scripts fall back to the local domain and the current user's credentials.
export interface ADConnection {
  server: string;
  username: string;
  password: string;
}

export interface LogEntry {
  id: string;
  ts: number;
  script: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  ok: boolean;
  durationMs: number;
  mocked: boolean;
}

// ── Mock responses per script ──────────────────────────────────────────────
function mockResponse(script: string, args: string[]): { ok: boolean; data?: unknown; error?: string } {
  switch (script) {
    case "Get-ADGroup-All.ps1":
      return {
        ok: true,
        data: [
          "ADMINISTRACAO","CIDADE","COMERCIAL","COPERACOES","IT","M80",
          "MANUTENCAO","MARKETING","MULTIMEDIA","PUBLICIDADE","REDACAO","TECHOPS","TRAFEGO"
        ].map((n) => ({ Name: n, Description: "", GroupCategory: "Security", GroupScope: "Global" })),
      };

    case "Get-ADGroupMembers.ps1": {
      const group = args[0] ?? "IT";
      const members: Record<string, unknown[]> = {
        IT: [
          { SamAccountName: "joao.silva",    DisplayName: "João Silva",    EmailAddress: "joao.silva@bmap.lis",    Enabled: true,  LockedOut: false, Title: "Técnico de IT",    Department: "IT" },
          { SamAccountName: "maria.costa",   DisplayName: "Maria Costa",   EmailAddress: "maria.costa@bmap.lis",   Enabled: true,  LockedOut: true,  Title: "Helpdesk",         Department: "IT" },
          { SamAccountName: "ana.ferreira",  DisplayName: "Ana Ferreira",  EmailAddress: "ana.ferreira@bmap.lis",  Enabled: false, LockedOut: false, Title: "Administrador de Sistemas", Department: "IT" },
        ],
        REDACAO: [
          { SamAccountName: "pedro.sousa",   DisplayName: "Pedro Sousa",   EmailAddress: "pedro.sousa@bmap.lis",   Enabled: true,  LockedOut: false, Title: "Jornalista",       Department: "Redação" },
          { SamAccountName: "rita.lopes",    DisplayName: "Rita Lopes",    EmailAddress: "rita.lopes@bmap.lis",    Enabled: true,  LockedOut: false, Title: "Editor",           Department: "Redação" },
        ],
        COMERCIAL: [
          { SamAccountName: "tiago.gomes",   DisplayName: "Tiago Gomes",   EmailAddress: "tiago.gomes@bmap.lis",   Enabled: true,  LockedOut: false, Title: "Account Manager",  Department: "Comercial" },
        ],
      };
      return { ok: true, data: members[group] ?? [] };
    }

    case "New-ADUser.ps1": {
      const [firstName, lastName, username, , groupName] = args;
      // Simulate occasional failure for testing error paths
      if (username === "fail.test") {
        return { ok: false, error: "The object name has bad syntax. (Exception from HRESULT: 0x80072558)" };
      }
      return { ok: true, data: { success: true, username, displayName: `${firstName} ${lastName}`, group: groupName } };
    }

    case "Reset-ADPassword.ps1": {
      const [username] = args;
      if (username === "fail.test") {
        return { ok: false, error: "Access is denied." };
      }
      return { ok: true, data: { success: true, username } };
    }

    case "Unlock-ADUser.ps1": {
      const [username] = args;
      return { ok: true, data: { success: true, username } };
    }

    case "Add-ADGroup.ps1":
      return { ok: true, data: { success: true } };

    case "Remove-ADGroup.ps1":
      return { ok: true, data: { success: true } };

    default:
      return { ok: false, error: `[MOCK] No mock defined for script: ${script}` };
  }
}

// Turn the raw "module not found" PowerShell error into an actionable message.
function friendlyError(raw: string): string {
  const msg = raw ?? "";
  if (/ActiveDirectory/i.test(msg) && /(not loaded|no valid module|n[ãa]o foi carregad|was not loaded)/i.test(msg)) {
    return "O módulo ActiveDirectory (RSAT) não está instalado nesta máquina. Instala as RSAT: Active Directory (Definições do Windows → Aplicações → Funcionalidades opcionais) e reinicia a aplicação.";
  }
  return msg;
}

// ── Runner ─────────────────────────────────────────────────────────────────
export function runPS(
  script: string,
  args: string[] = [],
  log?: (entry: LogEntry) => void,
  conn?: ADConnection
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (MOCK_MODE) {
    const ts = Date.now();
    // Small artificial delay to simulate real PS execution
    return new Promise((resolve) => setTimeout(() => {
      const result = mockResponse(script, args);
      const stdout = result.ok ? JSON.stringify(result.data) : JSON.stringify({ success: false, error: result.error });
      const entry: LogEntry = {
        id: ts.toString(36),
        ts,
        script,
        args,
        stdout,
        stderr: "",
        exitCode: result.ok ? 0 : 1,
        ok: result.ok,
        durationMs: Date.now() - ts,
        mocked: true,
      };
      if (log) log(entry);
      resolve(result);
    }, 150 + Math.random() * 300));
  }

  return new Promise((resolve) => {
    const scriptPath = join(SCRIPTS_DIR, script);
    const psArgs = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args,
    ];

    const ts = Date.now();

    const env = { ...process.env };
    if (conn?.server)   env.AD_SERVER   = conn.server;
    if (conn?.username) env.AD_USER     = conn.username;
    if (conn?.password) env.AD_PASSWORD = conn.password;

    execFile("powershell.exe", psArgs, { encoding: "utf8", env }, (err, stdout, stderr) => {
      const durationMs = Date.now() - ts;
      const exitCode = err?.code != null ? (err.code as number) : (err ? 1 : 0);
      const ok = !err;

      if (log) {
        log({ id: ts.toString(36), ts, script, args, stdout: stdout ?? "", stderr: stderr ?? "", exitCode, ok, durationMs, mocked: false });
      }

      if (err) {
        let errorMessage: string | undefined;
        try {
          const parsed = JSON.parse((stdout ?? "").trim());
          errorMessage = parsed?.error ?? undefined;
        } catch { /* ignore */ }
        resolve({ ok: false, error: friendlyError(errorMessage ?? (stderr || err.message)) });
        return;
      }

      try {
        resolve({ ok: true, data: JSON.parse(stdout.trim()) });
      } catch {
        resolve({ ok: true, data: stdout.trim() });
      }
    });
  });
}
