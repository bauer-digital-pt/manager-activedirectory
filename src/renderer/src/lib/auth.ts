// Login / session bridge.
//
// In Electron authAPI validates credentials against the domain and holds the
// session in the main process (the password never touches the renderer's disk).
// In the browser (dev/mock) authAPI is absent, so a local mock lets the login
// flow be exercised without a domain: any password authenticates except "wrong".

export interface LoginResult {
  ok: boolean;
  username?: string;
  displayName?: string;
  domain?: string;
  dc?: string;
  error?: string;
}

export interface AuthStatus {
  ok: boolean;
  authenticated: boolean;
  username: string;
  lastUsername: string;
}

const LS_LAST_USER = "admanager.lastUsername";

// Derive a display name from a username for the mock (afonso.queiroz → Afonso Queiroz).
function mockDisplayName(username: string): string {
  const bare = username.replace(/^.*\\/, "").replace(/@.*$/, "");
  return bare
    .split(/[.\-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const u = username.trim();
  if (!u || !password) return { ok: false, error: "Indica o utilizador e a palavra-passe." };

  if (window.authAPI?.login) {
    return window.authAPI.login({ username: u, password });
  }

  // Browser mock. Password "wrong" fails auth.
  // NOTE (v1.0.29): the Domain Admins access gate is temporarily disabled, so the
  // old `noadmin` rejection is gone too — any valid password logs in, matching
  // Test-ADCredential.ps1 ($EnforceDomainAdmin = $false).
  await new Promise((r) => setTimeout(r, 500));
  if (password === "wrong") return { ok: false, error: "Credenciais inválidas." };
  localStorage.setItem(LS_LAST_USER, u);
  return { ok: true, username: u, displayName: mockDisplayName(u), domain: "bmap.lis", dc: "dc01.bmap.lis" };
}

export async function logout(): Promise<void> {
  if (window.authAPI?.logout) { await window.authAPI.logout(); }
}

export async function getAuthStatus(): Promise<AuthStatus> {
  if (window.authAPI?.status) return window.authAPI.status();
  return { ok: true, authenticated: false, username: "", lastUsername: localStorage.getItem(LS_LAST_USER) ?? "" };
}

// Liveness probe for the connection dot. In the browser mock it's always "up".
export async function ping(): Promise<boolean> {
  if (window.authAPI?.ping) {
    const r = await window.authAPI.ping();
    return r.ok;
  }
  return true;
}
