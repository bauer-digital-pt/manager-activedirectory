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
function mockResponse(script: string, args: string[], conn?: ADConnection): { ok: boolean; data?: unknown; error?: string } {
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

    case "Test-ADConnection.ps1":
      return { ok: true, data: { success: true, domain: "bmap.lis", forest: "bmap.lis", dc: "dc01.bmap.lis" } };

    case "Test-ADCredential.ps1": {
      // Login validator. Creds arrive on `conn` (in mock mode they're never put
      // on the env). Password "wrong" simulates invalid credentials.
      const user = conn?.username ?? "";
      const pass = conn?.password ?? "";
      if (!user || !pass) return { ok: false, error: "Credenciais em falta." };
      if (pass === "wrong") return { ok: true, data: { success: false, error: "Credenciais inválidas." } };
      const bare = user.replace(/^.*\\/, "").replace(/@.*$/, "");
      const displayName = bare
        .split(/[.\-_]/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      return { ok: true, data: { success: true, domain: "bmap.lis", dc: "dc01.bmap.lis", displayName } };
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

// PowerShell output can carry a UTF-8 BOM and — when a BOM-less .ps1 with
// accented literals is misread as ANSI — stray raw control bytes that land
// inside JSON strings, which JSON.parse rejects ("bad control character").
// Strip the BOM and any C0 control chars except tab/newline/carriage-return so
// a script's JSON result still parses instead of falling back to a generic error.
function parseJsonLoose(raw: string): unknown {
  let out = "";
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    // Drop the UTF-8 BOM and C0 control chars except tab/newline/carriage
    // return — a BOM-less .ps1 misread as ANSI can leak raw control bytes into
    // JSON strings, which JSON.parse rejects ("bad control character").
    if (c === 0xfeff) continue;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    out += ch;
  }
  return JSON.parse(out.trim());
}

// ── Runner ─────────────────────────────────────────────────────────────────
export function runPS(
  script: string,
  args: string[] = [],
  log?: (entry: LogEntry) => void,
  conn?: ADConnection,
  // Hard ceiling so a hung PowerShell (e.g. `Get-Module -ListAvailable` stalling
  // on an unreachable network module path in a domain, or an unreachable DC)
  // never hangs the IPC — and therefore the UI — forever. The process is killed
  // and the call resolves with an actionable error the renderer already handles.
  timeoutMs = 30000,
  // Extra environment variables for the script (e.g. a managed user's password).
  // Passing secrets here instead of on `args` keeps them out of the process
  // command line (visible to other users / Sysmon / EDR) — the env of a process
  // is only readable by the owner and SYSTEM. These are never logged.
  extraEnv?: Record<string, string>
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (MOCK_MODE) {
    const ts = Date.now();
    // Small artificial delay to simulate real PS execution
    return new Promise((resolve) => setTimeout(() => {
      const result = mockResponse(script, args, conn);
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
    if (extraEnv) for (const [k, v] of Object.entries(extraEnv)) { if (v) env[k] = v; }

    execFile(
      "powershell.exe",
      psArgs,
      {
        encoding: "utf8",
        env,
        timeout: timeoutMs,
        // Don't flash a console window on every AD call.
        windowsHide: true,
        // A large group's member list can serialize to well over the 1 MB
        // default, which would otherwise fail the call with ENOBUFS.
        maxBuffer: 20 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
      const durationMs = Date.now() - ts;
      const exitCode = err?.code != null ? (err.code as number) : (err ? 1 : 0);
      const ok = !err;

      if (log) {
        log({ id: ts.toString(36), ts, script, args, stdout: stdout ?? "", stderr: stderr ?? "", exitCode, ok, durationMs, mocked: false });
      }

      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        // Timeout: execFile killed the process after `timeoutMs`.
        if (e.killed) {
          resolve({
            ok: false,
            error: `A operação demorou demasiado tempo (mais de ${Math.round(timeoutMs / 1000)}s) e foi cancelada. Verifica a ligação ao Active Directory e tenta novamente.`,
          });
          return;
        }
        // Output exceeded maxBuffer (extremely large directory response).
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ ok: false, error: "A resposta do Active Directory é demasiado grande para ser processada." });
          return;
        }
        let errorMessage: string | undefined;
        try {
          const parsed = parseJsonLoose(stdout ?? "") as { error?: string } | null;
          errorMessage = parsed?.error ?? undefined;
        } catch { /* ignore */ }
        resolve({ ok: false, error: friendlyError(errorMessage ?? (stderr || err.message)) });
        return;
      }

      try {
        resolve({ ok: true, data: parseJsonLoose(stdout) });
      } catch {
        resolve({ ok: true, data: stdout.trim() });
      }
    });
  });
}
