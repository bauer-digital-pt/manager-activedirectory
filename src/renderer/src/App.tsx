import { useState, useEffect, useCallback, useRef } from "react";
import { Toaster, toast } from "sonner";
import { AlertTriangle, Download, X } from "lucide-react";
import Sidebar from "./components/Sidebar";
import TitleBar from "./components/TitleBar";
import LoginGate from "./components/LoginGate";
import ErrorBoundary from "./components/ErrorBoundary";
import SetupRequired from "./components/SetupRequired";
import UpdateAvailable from "./components/UpdateAvailable";
import UsersPage from "./pages/Users/UsersPage";
import SettingsPage from "./pages/SettingsPage";
import ConsolePage from "./pages/ConsolePage";
import { adAPI } from "./adAPI";
import { updatesAPI, type UpdateStatus } from "./lib/updates";
import { getAuthStatus, logout, ping, type LoginResult } from "./lib/auth";
import { getSettings, type AppSettings, DEFAULT_SETTINGS } from "./lib/appSettings";
import logo from "./assets/bauer-media-logo.svg";

export type Page = "users" | "settings" | "console";

export default function App() {
  const [page, setPage] = useState<Page>("users");
  // null = still checking; true = RSAT module missing; false = available.
  const [moduleMissing, setModuleMissing] = useState<boolean | null>(null);
  const [continueAnyway, setContinueAnyway] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus>({ state: "none" });
  const [updateDismissed, setUpdateDismissed] = useState(false);       // full-screen dismissed
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  // True once we've released the user into the app via the splash timeout. Used
  // so a late-resolving module check can't yank a working session into the gate.
  const releasedRef = useRef(false);

  // --- Auth / session ---
  // Login is required on every launch, so `authed` starts false. `locked` marks
  // a re-lock after inactivity (only the password is re-requested).
  const [authed, setAuthed] = useState(false);
  const [locked, setLocked] = useState(false);
  const [lastUsername, setLastUsername] = useState("");
  const [displayName, setDisplayName] = useState("");

  // --- Settings ---
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const devMode = settings.devMode;

  // --- Connection status dot ---
  const [connOk, setConnOk] = useState<boolean | null>(null);
  // While a manual update check modal is open, suppress the full-screen takeover.
  const [suppressTakeover, setSuppressTakeover] = useState(false);

  // Load remembered username + settings up front.
  useEffect(() => {
    getAuthStatus().then((s) => setLastUsername(s.lastUsername || s.username || ""));
    getSettings().then(setSettings);
  }, []);

  const reloadSettings = useCallback(() => { getSettings().then(setSettings); }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "1") { e.preventDefault(); setPage("users"); }
      if (e.key === "2") { e.preventDefault(); setPage("settings"); }
      if (e.key === "3" && devMode) { e.preventDefault(); setPage("console"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [devMode]);

  // If dev mode is turned off while sitting on the Console, fall back to Users.
  useEffect(() => {
    if (!devMode && page === "console") setPage("users");
  }, [devMode, page]);

  // Check the RSAT ActiveDirectory module. An outright check failure is treated
  // as "not missing" so we never block the app on an ambiguous error.
  const checkModule = useCallback(async (opts?: { initial?: boolean }) => {
    try {
      const res = await adAPI.checkModule();
      const missing = res.ok && res.data ? res.data.available === false : false;
      setModuleMissing(missing);
      // If the startup splash already timed out and released the user into the
      // app, a late "missing" result must degrade to the dismissable banner —
      // never yank a working session into the full-screen gate mid-use.
      if (opts?.initial && missing && releasedRef.current) setContinueAnyway(true);
    } catch {
      setModuleMissing(false);
    }
  }, []);

  useEffect(() => {
    checkModule({ initial: true });
    // Safety net: never let the check hang the whole app on the splash. If the
    // module check hasn't resolved within a few seconds (e.g. a stuck IPC call),
    // fall through to the app so the sidebar — and Settings — stay reachable.
    const t = setTimeout(() => {
      setModuleMissing((m) => {
        if (m === null) {
          releasedRef.current = true;
          return false;
        }
        return m;
      });
    }, 3000);
    return () => clearTimeout(t);
  }, [checkModule]);

  const recheck = useCallback(async () => {
    setRechecking(true);
    await checkModule();
    setRechecking(false);
  }, [checkModule]);

  // Listen for auto-update status from the main process.
  useEffect(() => {
    const off = updatesAPI.onStatus((status) => setUpdate(status));
    return off;
  }, []);

  const onLoginSuccess = useCallback((res: LoginResult) => {
    setAuthed(true);
    setLocked(false);
    if (res.username) setLastUsername(res.username);
    setDisplayName(res.displayName || res.username || "");
    setConnOk(true);
  }, []);

  // Live connection status dot: probe periodically while logged in.
  useEffect(() => {
    if (!authed) { setConnOk(null); return; }
    let alive = true;
    const probe = () => ping().then((ok) => { if (alive) setConnOk(ok); });
    probe();
    const id = window.setInterval(probe, 15000);
    return () => { alive = false; window.clearInterval(id); };
  }, [authed]);

  // Inactivity relock: after `loginTimeoutMin` with no user activity, drop the
  // session (main process too) and return to the login screen with the username
  // pre-filled. Any activity resets the timer.
  useEffect(() => {
    if (!authed || locked) return;
    const ms = Math.min(60, Math.max(5, settings.loginTimeoutMin)) * 60_000;
    let timer: number;
    const doLock = () => { logout(); setAuthed(false); setLocked(true); setConnOk(null); };
    const reset = () => { window.clearTimeout(timer); timer = window.setTimeout(doLock, ms); };
    const events: (keyof WindowEventMap)[] = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"];
    events.forEach((ev) => window.addEventListener(ev, reset, { passive: true }));
    reset();
    return () => {
      window.clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, reset));
    };
  }, [authed, locked, settings.loginTimeoutMin]);

  // ── Screen selection ──────────────────────────────────────────────────────
  let content: React.ReactNode;

  if (moduleMissing === null) {
    // Still checking — a light splash avoids flashing the app (or a black window).
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-white">
        <img src={logo} alt="Bauer Media" className="h-12 w-12 animate-pulse opacity-90" />
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-sm font-medium tracking-wide text-zinc-500">AD Manager</span>
          <span className="text-xs text-zinc-400">A iniciar…</span>
        </div>
      </div>
    );
  } else if (moduleMissing && !continueAnyway) {
    // Module missing and not dismissed — RSAT setup is a precondition for login.
    content = (
      <SetupRequired
        onRecheck={recheck}
        rechecking={rechecking}
        onContinue={() => { setContinueAnyway(true); setBannerDismissed(false); }}
        onOpenSettings={() => { setContinueAnyway(true); setBannerDismissed(false); setPage("settings"); }}
      />
    );
  } else if (
    (update.state === "available" || update.state === "downloading" || update.state === "downloaded") &&
    !updateDismissed && !suppressTakeover
  ) {
    // An update is downloading/ready and not dismissed — full-screen notice.
    content = (
      <UpdateAvailable
        status={update}
        onInstall={() => updatesAPI.install()}
        onDismiss={() => setUpdateDismissed(true)}
      />
    );
  } else if (!authed) {
    // Login is required on every launch and again after an inactivity relock.
    content = (
      <LoginGate lastUsername={lastUsername} locked={locked} onSuccess={onLoginSuccess} />
    );
  } else {
    content = (
      <>
        {moduleMissing && continueAnyway && !bannerDismissed && (
          <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-sm">
            <AlertTriangle size={15} className="flex-shrink-0" />
            <span className="flex-1">
              O módulo <strong>ActiveDirectory (RSAT)</strong> não está instalado — as funções de AD não vão funcionar.
            </span>
            <button
              onClick={() => setContinueAnyway(false)}
              className="px-2.5 py-1 rounded-md bg-amber-100 hover:bg-amber-200 font-medium transition-colors"
            >
              Instalar
            </button>
            <button onClick={() => setBannerDismissed(true)} className="p-1 rounded hover:bg-amber-100 transition-colors">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Once the full-screen update notice is dismissed, a ready update stays reachable here. */}
        {update.state === "downloaded" && updateDismissed && !updateBannerDismissed && (
          <div className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white text-sm">
            <Download size={15} className="flex-shrink-0" />
            <span className="flex-1">
              Atualização {update.version ? `(${update.version}) ` : ""}pronta a instalar.
            </span>
            <button
              onClick={() => updatesAPI.install()}
              className="px-3 py-1 rounded-md bg-white/15 hover:bg-white/25 font-medium transition-colors"
            >
              Reiniciar e instalar
            </button>
            <button onClick={() => setUpdateBannerDismissed(true)} className="p-1 rounded hover:bg-white/15 transition-colors">
              <X size={14} />
            </button>
          </div>
        )}

        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            active={page}
            onNavigate={setPage}
            devMode={devMode}
            userName={displayName || lastUsername}
            connOk={connOk}
          />
          <main className="flex-1 overflow-hidden flex flex-col bg-white">
            {/* Keyed by page: a crash in one page shows a compact fallback (sidebar
                stays), and navigating to another page remounts a fresh boundary. */}
            <ErrorBoundary key={page} compact>
              {page === "users"    && <UsersPage    toast={toast} onOpenSettings={() => setPage("settings")} />}
              {page === "settings" && <SettingsPage toast={toast} onSettingsChange={reloadSettings} onUpdateModal={setSuppressTakeover} />}
              {page === "console"  && devMode && <ConsolePage />}
            </ErrorBoundary>
          </main>
        </div>
      </>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      <TitleBar />
      {content}
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}
