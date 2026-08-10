import { useEffect, useRef, useState } from "react";
import { Loader2, Lock, LogIn, User, AlertCircle } from "lucide-react";
import logo from "../assets/bauer-media-logo.svg";
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
// and is never stored here.
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

  const inputCls =
    "w-full px-3.5 py-2.5 text-sm bg-white border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all placeholder:text-zinc-300 disabled:bg-zinc-50 disabled:text-zinc-500";

  return (
    <div className="flex-1 w-full h-full flex overflow-hidden bg-white">
      {/* Brand hero panel (mirrors StatusScreen) */}
      <aside
        className="relative hidden shrink-0 flex-col justify-between overflow-hidden px-9 py-11 md:flex md:w-[38%] md:max-w-[420px] lg:px-11"
        style={{ background: "linear-gradient(152deg, #5713bd 0%, #4700a3 52%, #37007d 100%)" }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, rgba(255,255,255,0.30), transparent)" }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -left-20 bottom-4 h-64 w-64 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, rgba(31,209,189,0.22), transparent)" }}
        />
        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white shadow-sm">
            <img src={logo} alt="Bauer Media" className="h-7 w-7" />
          </div>
          <span className="text-base font-semibold tracking-wide text-white">AD Manager</span>
        </div>
        <div className="relative">
          <p className="text-sm font-medium text-white/90">Gestão de contas Active Directory</p>
          <p className="mt-1 text-xs text-white/55">Bauer Media Audio Portugal</p>
        </div>
      </aside>

      {/* Form column */}
      <main className="relative h-full min-w-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full w-full flex-col px-6 py-10 sm:px-10 lg:px-16">
          <div className="mb-8 flex items-center gap-2.5 md:hidden">
            <img src={logo} alt="Bauer Media" className="h-8 w-8" />
            <span className="text-sm font-medium tracking-wide text-zinc-400">AD Manager</span>
          </div>

          <form
            className="my-auto w-full max-w-[400px]"
            onSubmit={(e) => { e.preventDefault(); submit(); }}
          >
            {locked ? (
              <>
                <div className="mb-6 flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ backgroundColor: "#4700a3" }}>
                    {initials(lastUsername) || <User size={20} />}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-zinc-400">Sessão bloqueada</p>
                    <p className="truncate text-sm font-medium text-zinc-800">{lastUsername}</p>
                  </div>
                </div>
                <h1 className="text-2xl font-semibold leading-tight text-zinc-900">Bem-vindo de volta</h1>
                <p className="mt-2 text-sm text-zinc-500">Introduz a palavra-passe para continuar.</p>
              </>
            ) : (
              <>
                <h1 className="text-2xl font-semibold leading-tight text-zinc-900">Iniciar sessão</h1>
                <p className="mt-2 text-sm text-zinc-500">Autentica-te com a tua conta de domínio.</p>
              </>
            )}

            <div className="mt-8 space-y-4">
              {!locked && (
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wider text-zinc-700">Utilizador</label>
                  <div className="relative">
                    <User size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-300" />
                    <input
                      ref={usernameRef}
                      value={username}
                      onChange={(e) => { setUsername(e.target.value); setError(null); }}
                      placeholder="ex: afonso.queiroz"
                      autoComplete="username"
                      disabled={busy}
                      className={inputCls + " pl-9"}
                    />
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-700">Palavra-passe</label>
                <div className="relative">
                  <Lock size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-300" />
                  <input
                    ref={passwordRef}
                    type="password"
                    name="password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setError(null); }}
                    placeholder="Introduz a palavra-passe"
                    autoComplete="current-password"
                    disabled={busy}
                    className={inputCls + " pl-9"}
                  />
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-600">
                  <AlertCircle size={15} className="flex-shrink-0" />
                  <span className="min-w-0">{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={busy}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
                {busy ? "A autenticar…" : locked ? "Desbloquear" : "Entrar"}
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
