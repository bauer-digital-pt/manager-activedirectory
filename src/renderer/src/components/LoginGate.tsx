import { useEffect, useRef, useState } from "react";
import { Loader2, Lock, LogIn, User, AlertCircle, Server, ChevronDown } from "lucide-react";
import AuthShell from "./AuthShell";
import { login, type LoginResult } from "../lib/auth";
import { getInventoryConfig } from "../lib/inventoryConfig";
import { initials } from "../lib/initials";

// Off Windows the Manager has no local PowerShell/RSAT: it authenticates and reads
// through the inventory API (bind-as-user). Login normally uses the default/saved
// API address, but Definições → Inventário is unreachable before a session — so
// off Windows we expose an OPTIONAL, collapsed "connection" field to recover when
// the default is unreachable. On Windows this is hidden entirely (login uses PS).
const NON_WINDOWS = typeof window !== "undefined" && !!window.appAPI?.platform && window.appAPI.platform !== "win32";

interface LoginGateProps {
  /** Pre-filled username (remembered from a previous login on this PC). */
  lastUsername?: string;
  /** Relock after inactivity: username is fixed, only the password is asked. */
  locked?: boolean;
  onSuccess: (result: LoginResult) => void;
}

// Full-screen login. Shown on every launch (before the main app) and again on an
// inactivity relock. When a username is remembered (relock OR a previous
// logout/launch on this PC) we show a compact identity card — avatar + name +
// password only — with a "Não és tu?" escape hatch to sign in as someone else.
// The password is sent straight to the main process for validation and is never
// stored here. Layout comes from the shared AuthShell.
export default function LoginGate({ lastUsername = "", locked = false, onSuccess }: LoginGateProps) {
  const [username, setUsername] = useState(lastUsername);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Off Windows only (see NON_WINDOWS): an optional override for the inventory API
  // address the login binds against. Blank = use the saved/default address; a value
  // here overrides it. Prefilled from the saved config so it shows the current
  // target. `showConn` keeps the field collapsed until the operator needs it.
  const [baseUrl, setBaseUrl] = useState("");
  const [showConn, setShowConn] = useState(false);
  // Set when the user clicks "Não és tu?" to sign in with a different account —
  // drops the remembered identity and reveals the username field.
  const [switchUser, setSwitchUser] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!NON_WINDOWS) return;
    let alive = true;
    getInventoryConfig()
      .then((c) => { if (alive && c.baseUrl) setBaseUrl(c.baseUrl); })
      .catch(() => { /* leave blank; the field falls back to the default */ });
    return () => { alive = false; };
  }, []);

  // Compact identity mode: a remembered user (relock or a previous session on
  // this machine) and the user hasn't chosen to switch accounts.
  const showIdentity = (locked || !!lastUsername) && !switchUser;

  useEffect(() => {
    // In identity mode go straight to the password; otherwise the username.
    if (showIdentity) passwordRef.current?.focus();
    else usernameRef.current?.focus();
  }, [showIdentity]);

  const useAnotherAccount = () => {
    setSwitchUser(true);
    setUsername("");
    setPassword("");
    setError(null);
    // Focus runs via the effect once the field mounts, but nudge it too.
    setTimeout(() => usernameRef.current?.focus(), 0);
  };

  const submit = async () => {
    if (busy) return;
    setError(null);
    // In identity mode the username is the remembered one; otherwise the field.
    const user = showIdentity ? lastUsername : username;
    if (!user.trim() || !password) {
      setError("Indica o utilizador e a palavra-passe.");
      return;
    }
    setBusy(true);
    try {
      // Pass the address override only off Windows and only when the operator
      // typed one; blank keeps the saved/default address (the normal path).
      const override = NON_WINDOWS && baseUrl.trim() ? baseUrl.trim() : undefined;
      const res = await login(user, password, override);
      if (res.ok) {
        setPassword("");
        onSuccess(res);
      } else {
        setError(res.error ?? "Não foi possível autenticar.");
        // Off Windows a failure is often an unreachable/wrong API address, and
        // Settings can't be reached pre-login — surface the recovery field.
        if (NON_WINDOWS) setShowConn(true);
        setPassword("");
        passwordRef.current?.focus();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível autenticar.");
      if (NON_WINDOWS) setShowConn(true);
    } finally {
      setBusy(false);
    }
  };

  // Soft, glassy inputs that read well on the coloured panel.
  const inputCls =
    "w-full rounded-lg border border-white/15 bg-white/[0.07] px-3.5 py-2.5 pl-9 text-sm text-white transition-all placeholder:text-white/35 focus:border-white/30 focus:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/20 disabled:opacity-60";

  return (
    <AuthShell>
      <form className="w-full max-w-[380px]" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {showIdentity ? (
          <>
            <div className="mb-6 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-white ring-1 ring-white/15">
                {initials(lastUsername) || <User size={20} />}
              </div>
              <div className="min-w-0">
                <p className="text-xs text-white/50">{locked ? "Sessão bloqueada" : "Sessão iniciada como"}</p>
                <p className="truncate text-sm font-medium text-white">{lastUsername}</p>
              </div>
            </div>
            <h1 className="text-2xl font-semibold leading-tight text-white">Bem-vindo de volta</h1>
            <p className="mt-2 text-sm text-white/60">Introduz a palavra-passe para continuar.</p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold leading-tight text-white">Iniciar sessão</h1>
            <p className="mt-2 text-sm text-white/60">Autentica-te com a tua conta de domínio.</p>
          </>
        )}

        <div className="mt-8 space-y-4">
          {!showIdentity && (
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-white/70">Utilizador</label>
              <div className="relative">
                <User size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
                <input
                  ref={usernameRef}
                  value={username}
                  onChange={(e) => { setUsername(e.target.value); setError(null); }}
                  placeholder="ex: afonso.queiroz"
                  autoComplete="username"
                  disabled={busy}
                  className={inputCls}
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-white/70">Palavra-passe</label>
            <div className="relative">
              <Lock size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
              <input
                ref={passwordRef}
                type="password"
                name="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                placeholder="Introduz a palavra-passe"
                autoComplete="current-password"
                disabled={busy}
                className={inputCls}
              />
            </div>
          </div>

          {/* Off-Windows only: optional API-address override, collapsed by default.
              Blank keeps the saved/default address; this is the only pre-login way
              to point the app at the right API when the default is unreachable. */}
          {NON_WINDOWS && (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setShowConn((v) => !v)}
                disabled={busy}
                className="flex items-center gap-1.5 text-xs font-medium text-white/50 transition-colors hover:text-white/80 disabled:opacity-60"
              >
                <ChevronDown size={13} className={showConn ? "rotate-180 transition-transform" : "transition-transform"} />
                Ligação à API de inventário
              </button>
              {showConn && (
                <div className="relative">
                  <Server size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
                  <input
                    value={baseUrl}
                    onChange={(e) => { setBaseUrl(e.target.value); setError(null); }}
                    placeholder="http://10.4.4.69:8000"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    className={inputCls}
                  />
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-300/25 bg-red-500/10 px-3 py-2.5 text-sm text-red-100">
              <AlertCircle size={15} className="flex-shrink-0" />
              <span className="min-w-0">{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-[#4700a3] shadow-sm transition-colors hover:bg-white/90 disabled:opacity-60"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
            {busy ? "A autenticar…" : locked && showIdentity ? "Desbloquear" : "Entrar"}
          </button>

          {showIdentity && (
            <button
              type="button"
              onClick={useAnotherAccount}
              disabled={busy}
              className="w-full text-center text-xs text-white/50 transition-colors hover:text-white/80 disabled:opacity-60"
            >
              Não és tu? <span className="underline underline-offset-2">Iniciar sessão com outra conta</span>
            </button>
          )}
        </div>

        <p className="mt-8 text-xs text-white/40">Bauer Media Audio Portugal</p>
      </form>
    </AuthShell>
  );
}
