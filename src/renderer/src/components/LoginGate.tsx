import { useEffect, useRef, useState } from "react";
import { Loader2, Lock, LogIn, User, AlertCircle } from "lucide-react";
import logo from "../assets/bauer-media-logo.svg";
import loginHero from "../assets/login-hero.jpg";
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
//
// Layout: photo fills the whole surface (visible on the right); a coloured panel
// sits on the left with its right edge rounded *over* the photo, decorative
// blobs in the bottom-right corner, and the form centred within it.
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

  // Glassy inputs that read well on the coloured panel.
  const inputCls =
    "w-full rounded-lg border border-white/20 bg-white/10 px-3.5 py-2.5 pl-9 text-sm text-white transition-all placeholder:text-white/40 focus:border-white/40 focus:bg-white/15 focus:outline-none focus:ring-2 focus:ring-white/25 disabled:opacity-60";

  return (
    <div className="relative flex-1 w-full h-full overflow-hidden bg-[#1a0538]">
      {/* Photo — fills the whole surface; the coloured panel covers its left part. */}
      <img
        src={loginHero}
        alt=""
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
      />

      {/* Coloured panel on the left, rounded on the right edge over the photo. */}
      <aside
        className="relative z-10 flex h-full w-full flex-col overflow-hidden rounded-r-[2.5rem] shadow-2xl md:w-[56%] lg:w-[52%] xl:w-[48%]"
        style={{ background: "linear-gradient(152deg, #5713bd 0%, #4700a3 52%, #37007d 100%)" }}
      >
        {/* Decorative blobs, bottom-right corner. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div
            className="absolute -bottom-16 -right-10 h-72 w-72 rounded-full"
            style={{ background: "radial-gradient(closest-side, rgba(255,255,255,0.14), transparent)" }}
          />
          <div
            className="absolute bottom-10 right-16 h-40 w-40 rounded-full"
            style={{ background: "radial-gradient(closest-side, rgba(31,209,189,0.20), transparent)" }}
          />
          <div className="absolute -bottom-6 right-24 h-24 w-24 rounded-full border border-white/10" />
          <div className="absolute bottom-24 -right-4 h-16 w-16 rounded-full border border-white/10" />
        </div>

        {/* Brand mark, top-left. */}
        <div className="relative flex items-center gap-3 px-8 pt-8 sm:px-12 lg:px-16">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white shadow-sm">
            <img src={logo} alt="Bauer Media" className="h-7 w-7" />
          </div>
          <span className="text-base font-semibold tracking-wide text-white">AD Manager</span>
        </div>

        {/* Form, centred. */}
        <div className="relative flex flex-1 items-center px-8 sm:px-12 lg:px-16">
          <form
            className="w-full max-w-[380px]"
            onSubmit={(e) => { e.preventDefault(); submit(); }}
          >
            {locked ? (
              <>
                <div className="mb-6 flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-sm font-semibold text-white ring-1 ring-white/20">
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
                <div className="flex items-center gap-2 rounded-lg border border-red-300/30 bg-red-500/15 px-3 py-2.5 text-sm text-red-100">
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
        </div>
      </aside>
    </div>
  );
}
