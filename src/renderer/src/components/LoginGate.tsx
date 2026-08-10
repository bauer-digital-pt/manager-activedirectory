import { useEffect, useRef, useState } from "react";
import { Loader2, Lock, LogIn, User, AlertCircle } from "lucide-react";
import AuthShell from "./AuthShell";
import { login, type LoginResult } from "../lib/auth";
import { initials } from "../lib/initials";

interface LoginGateProps {
  /** Pre-filled username (remembered from a previous login). */
  lastUsername?: string;
  /** Relock after inactivity: username is fixed, only the password is asked. */
  locked?: boolean;
  onSuccess: (result: LoginResult) => void;
}

// Full-screen login. Shown on every launch (before the main app) and again on an
// inactivity relock. On a relock the username is fixed and only the password is
// requested. The password is sent straight to the main process for validation
// and is never stored here. Layout comes from the shared AuthShell.
export default function LoginGate({ lastUsername = "", locked = false, onSuccess }: LoginGateProps) {
  const [username, setUsername] = useState(lastUsername);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // On a relock (or when a username is already remembered) go straight to the
    // password field; otherwise focus the username field.
    if (locked || lastUsername) passwordRef.current?.focus();
    else usernameRef.current?.focus();
  }, [locked, lastUsername]);

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (!username.trim() || !password) {
      setError("Indica o utilizador e a palavra-passe.");
      return;
    }
    setBusy(true);
    try {
      const res = await login(username, password);
      if (res.ok) {
        setPassword("");
        onSuccess(res);
      } else {
        setError(res.error ?? "Não foi possível autenticar.");
        setPassword("");
        passwordRef.current?.focus();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível autenticar.");
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
        {locked ? (
          <>
            <div className="mb-6 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-white ring-1 ring-white/15">
                {initials(lastUsername) || <User size={20} />}
              </div>
              <div className="min-w-0">
                <p className="text-xs text-white/50">Sessão bloqueada</p>
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
          {!locked && (
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
            {busy ? "A autenticar…" : locked ? "Desbloquear" : "Entrar"}
          </button>
        </div>

        <p className="mt-8 text-xs text-white/40">Bauer Media Audio Portugal</p>
      </form>
    </AuthShell>
  );
}
