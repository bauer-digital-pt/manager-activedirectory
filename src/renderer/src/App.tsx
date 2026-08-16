import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { Toaster, toast } from "sonner";
import { AlertTriangle, Download, X, ChevronLeft, Lock, Loader2 } from "lucide-react";
import { cn } from "./lib/cn";
import Sidebar from "./components/Sidebar";
import TitleBar from "./components/TitleBar";
import LoginGate from "./components/LoginGate";
import ErrorBoundary from "./components/ErrorBoundary";
import SetupRequired from "./components/SetupRequired";
import UpdateAvailable from "./components/UpdateAvailable";
import UsersPage from "./pages/Users/UsersPage";
// Secondary pages are code-split so the initial bundle carries only the login
// shell + the default Users page. Each chunk loads on first navigation to it.
const DevicesPage = lazy(() => import("./pages/DevicesPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ConsolePage = lazy(() => import("./pages/ConsolePage"));
const InventoryPage = lazy(() => import("./pages/InventoryPage"));
import { adAPI } from "./adAPI";
import { updatesAPI, getStartupInfo, type UpdateStatus } from "./lib/updates";
import { getAuthStatus, logout, ping, reverify, type LoginResult } from "./lib/auth";
import { getSettings, type AppSettings, DEFAULT_SETTINGS } from "./lib/appSettings";
import { getInventoryConfig } from "./lib/inventoryConfig";
import { confirmNav } from "./lib/navGuard";
import { IS_AGENT, FLAVOR_UI } from "./lib/flavor";
import logo from "./assets/bauer-media-logo.svg";

export type Page = "users" | "devices" | "inventory" | "settings" | "console";

// Landing page per flavor: the Manager opens on Users; the Agent installer is the
// onboarding wizard, so it opens straight on Devices (no Users page at all).
const HOME_PAGE: Page = IS_AGENT ? "devices" : "users";

// Kiosk mode: how long a login/re-auth stays valid before the next sensitive
// action re-prompts for the password ("de 10 em 10 minutos pedem re-login").
const KIOSK_REAUTH_MS = 10 * 60_000;

export default function App() {
  const [page, setPage] = useState<Page>(HOME_PAGE);
  // Which Settings tab to open on. Devices deep-links to "devices" to fix an OU
  // mapping; reset to "general" whenever we leave Settings so a plain sidebar
  // click always lands on the first tab.
  const [settingsTab, setSettingsTab] = useState<"general" | "groups" | "devices" | "connection" | "inventory">("general");
  // Whether the inventory API is configured+enabled — gates the sidebar tab, the
  // hotkey, and the page. Manager-only; the Agent never surfaces the inventory.
  const [inventoryEnabled, setInventoryEnabled] = useState(false);
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

  // --- Kiosk re-auth ---
  // Kiosk mode never logs out (no inactivity relock, see below), but any sensitive
  // action re-confirms the operator's password if it's been more than KIOSK_REAUTH_MS
  // since the last login/re-auth. `lastAuthAtRef` stamps that moment; `reauth` opens
  // the inline modal; `reauthResolveRef` carries the pending ensureFreshAuth promise's
  // resolver so the caller (a UserRow action) unblocks with the modal's result.
  const lastAuthAtRef = useRef(0);
  const [reauth, setReauth] = useState(false);
  const reauthResolveRef = useRef<((ok: boolean) => void) | null>(null);

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
    if (!IS_AGENT) getInventoryConfig().then((c) => setInventoryEnabled(c.enabled)).catch(() => {});
  }, []);

  // Re-read app settings AND the inventory flag: the Settings inventory tab calls
  // onSettingsChange after a save, so toggling it there shows/hides the tab live.
  const reloadSettings = useCallback(() => {
    getSettings().then(setSettings);
    if (!IS_AGENT) getInventoryConfig().then((c) => setInventoryEnabled(c.enabled)).catch(() => {});
  }, []);

  // Central page switch: gives an in-progress flow (the create-user wizard) a
  // chance to veto navigation that would discard unsaved data. Used by the
  // sidebar, the number hotkeys, and the "open settings" entry points.
  const navigate = useCallback((p: Page) => {
    if (page === p) return;
    if (!confirmNav()) return;
    setPage(p);
  }, [page]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "1" && !IS_AGENT) { e.preventDefault(); navigate("users"); }
      if (e.key === "2") { e.preventDefault(); navigate("devices"); }
      if (e.key === "3" && !IS_AGENT && inventoryEnabled) { e.preventDefault(); navigate("inventory"); }
      if (e.key === "4") { e.preventDefault(); navigate("settings"); }
      // In-app Console page is a Manager dev tool. The Agent has no such page —
      // its diagnostics live in the detached Console window (Ctrl+Shift+C below).
      if (e.key === "5" && devMode && !IS_AGENT) { e.preventDefault(); navigate("console"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [devMode, inventoryEnabled, navigate]);

  // Open the detached, unbranded Console window. In Electron it's a separate OS
  // window (main process owns it); in the browser preview there's no such bridge,
  // so open a standalone tab on the same bundle with the "#console" hash.
  const openConsoleWindow = useCallback(() => {
    if (window.consoleAPI?.openWindow) {
      window.consoleAPI.openWindow();
    } else {
      window.open(`${location.pathname}${location.search}#console`, "_blank", "noopener,noreferrer,width=960,height=640");
    }
  }, []);

  // Ctrl+Shift+C — a deliberately obscure shortcut that pops the Console as its
  // own window, unattached to the app. Handled globally (even inside inputs, and
  // whether or not the user is logged in) since the modifier combo is unambiguous.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "C" || e.key === "c")) {
        e.preventDefault();
        openConsoleWindow();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openConsoleWindow]);

  // If dev mode is turned off while sitting on the Console, fall back home.
  useEffect(() => {
    if (!devMode && page === "console") setPage(HOME_PAGE);
  }, [devMode, page]);

  // Likewise, if the inventory is disabled (in Settings) while it's open, leave.
  useEffect(() => {
    if (!inventoryEnabled && page === "inventory") setPage(HOME_PAGE);
  }, [inventoryEnabled, page]);

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

  // Listen for auto-update status from the main process. A background update
  // check that fails (no network, GitHub unreachable) emits state:"error" — but
  // the user never asked for it, so don't turn that into a takeover. Only keep an
  // error when an update flow was already visible on screen (available →
  // downloading → downloaded → installing); otherwise fall back to "none".
  useEffect(() => {
    const off = updatesAPI.onStatus((status) => {
      setUpdate((prev) => {
        if (status.state === "error") {
          const flowWasVisible =
            prev.state === "available" ||
            prev.state === "downloading" ||
            prev.state === "downloaded" ||
            prev.state === "installing";
          if (!flowWasVisible) return { state: "none" };
        }
        return status;
      });
    });
    return off;
  }, []);

  // Kick off the install: flip to the custom "installing" takeover IMMEDIATELY
  // (so the window shows a branded screen instead of vanishing), then ask main
  // to run the silent installer. Main quits + relaunches once it finishes.
  const startInstall = useCallback(() => {
    setUpdateDismissed(false);
    setSuppressTakeover(false);
    setUpdate((u) => ({ state: "installing", version: "version" in u ? u.version : undefined }));
    void updatesAPI.install();
  }, []);

  // One-time "updated to vX" welcome shown right after an auto-update relaunch.
  useEffect(() => {
    getStartupInfo().then((info) => {
      if (info.justUpdated) {
        toast.success(`Atualizado para a versão ${info.version} 🎉`, { duration: 6000 });
      }
    });
  }, []);

  const onLoginSuccess = useCallback((res: LoginResult) => {
    // An inactivity relock reuses this same handler; only a FRESH login (not an
    // unlock) should reposition the user — otherwise every relock yanks them
    // back to Devices no matter where they were working.
    const wasRelock = locked;
    // A successful login (or kiosk re-auth) opens a fresh re-auth window.
    lastAuthAtRef.current = Date.now();
    setAuthed(true);
    setLocked(false);
    if (res.username) setLastUsername(res.username);
    setDisplayName(res.displayName || res.username || "");
    setConnOk(true);
    // Resume an interrupted PC onboarding: if the domain-join reboot dropped us
    // here mid-run, jump straight to Devices so the wizard picks up automatically.
    // Skip it on a relock — the run is persisted and DevicesPage resumes on its
    // own if the user was already there.
    if (!wasRelock) {
      adAPI.getOnboardState().then((s) => { if (s?.active) setPage("devices"); }).catch(() => {});
    }
  }, [locked]);

  // Gate a sensitive action behind a fresh password check. Outside kiosk mode there
  // IS no gate (the inactivity relock covers walk-aways), so it resolves true at
  // once. In kiosk mode it's free within the re-auth window; past it, the inline
  // modal opens and this promise settles with the operator's choice (true = verified,
  // false = cancelled → the caller aborts its action). Passed to UsersPage → UserRow.
  const ensureFreshAuth = useCallback(async (): Promise<boolean> => {
    if (!settings.kioskMode) return true;
    if (Date.now() - lastAuthAtRef.current < KIOSK_REAUTH_MS) return true;
    return new Promise<boolean>((resolve) => {
      reauthResolveRef.current = resolve;
      setReauth(true);
    });
  }, [settings.kioskMode]);

  // Settle the pending ensureFreshAuth promise from the modal. A verified result
  // stamps a new re-auth window; either way the modal closes and the caller resumes.
  const resolveReauth = useCallback((ok: boolean) => {
    if (ok) lastAuthAtRef.current = Date.now();
    setReauth(false);
    const resolve = reauthResolveRef.current;
    reauthResolveRef.current = null;
    resolve?.(ok);
  }, []);

  // Explicit sign-out from the sidebar: drop the session (main process too) and
  // return to a fresh login screen (not the relock flow) with the username kept
  // for convenience.
  const onLogout = useCallback(() => {
    // A logout also throws away an unsaved wizard — let the guard confirm first.
    if (!confirmNav()) return;
    logout();
    setAuthed(false);
    setLocked(false);
    setConnOk(null);
    setPage(HOME_PAGE);
  }, []);

  // The manual-update modal lives in Settings and suppresses the full-screen
  // update takeover while open; leaving Settings must clear that suppression so
  // a ready update can still surface.
  useEffect(() => {
    if (page !== "settings") { setSuppressTakeover(false); setSettingsTab("general"); }
  }, [page]);

  // Live connection status dot: probe periodically while logged in. Guard against
  // overlap — a ping can take up to the runner timeout, longer than the interval.
  useEffect(() => {
    if (!authed) { setConnOk(null); return; }
    let alive = true;
    let inFlight = false;
    const probe = () => {
      if (inFlight) return;
      inFlight = true;
      ping()
        .then((ok) => { if (alive) setConnOk(ok); })
        .finally(() => { inFlight = false; });
    };
    probe();
    const id = window.setInterval(probe, 15000);
    return () => { alive = false; window.clearInterval(id); };
  }, [authed]);

  // Inactivity relock: after `loginTimeoutMin` with no user activity, drop the
  // session (main process too) and return to the login screen with the username
  // pre-filled. Any activity resets the timer. Kiosk mode opts out entirely — it
  // "never logs out" and gates sensitive actions with a re-auth prompt instead.
  useEffect(() => {
    if (!authed || locked || settings.kioskMode) return;
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
  }, [authed, locked, settings.loginTimeoutMin, settings.kioskMode]);

  // ── Screen selection ──────────────────────────────────────────────────────
  let content: React.ReactNode;

  if (moduleMissing === null) {
    // Still checking — a light splash avoids flashing the app (or a black window).
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-white">
        <img src={logo} alt="Bauer Media" className="h-12 w-12 animate-pulse opacity-90" />
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-sm font-medium tracking-wide text-zinc-500">{FLAVOR_UI.eyebrow}</span>
          <span className="text-xs text-zinc-400">A iniciar…</span>
        </div>
      </div>
    );
  } else if (!IS_AGENT && moduleMissing && !continueAnyway) {
    // Module missing and not dismissed — RSAT setup is a precondition for login.
    // Agent runs on freshly-imaged PCs that legitimately lack RSAT (the domain
    // join needs no module; only the OU move degrades to a warning), so it never
    // hard-gates on it — the wizard opens straight away.
    content = (
      <SetupRequired
        onRecheck={recheck}
        rechecking={rechecking}
        onContinue={() => { setContinueAnyway(true); setBannerDismissed(false); }}
        onOpenSettings={() => { setContinueAnyway(true); setBannerDismissed(false); setPage("settings"); }}
      />
    );
  } else if (update.state === "installing") {
    // Installing is non-dismissible: the app quits + relaunches on its own.
    content = (
      <UpdateAvailable status={update} onInstall={startInstall} onDismiss={() => {}} />
    );
  } else if (
    !authed &&
    (update.state === "available" || update.state === "downloading" || update.state === "downloaded") &&
    !updateDismissed && !suppressTakeover
  ) {
    // Pre-login only: a full-screen notice while an update downloads/readies, so
    // we don't yank a logged-in user out of their work. Once authed, a ready
    // update is offered via the dismissable banner instead (see below).
    content = (
      <UpdateAvailable
        status={update}
        onInstall={startInstall}
        onDismiss={() => setUpdateDismissed(true)}
      />
    );
  } else if (update.state === "error" && !suppressTakeover) {
    // An update flow the user could see (download/install) failed — surface it on
    // the branded screen instead of leaving them staring at a stalled takeover.
    // Background-check errors were already filtered to "none" in onStatus, so this
    // only fires for a flow that was actually visible. Dismiss returns to the app.
    content = (
      <UpdateAvailable
        status={update}
        onInstall={startInstall}
        onDismiss={() => setUpdate({ state: "none" })}
      />
    );
  } else if (!authed) {
    // Login is required on every launch and again after an inactivity relock.
    content = (
      <LoginGate lastUsername={lastUsername} locked={locked} onSuccess={onLoginSuccess} />
    );
  } else {
    // The active page, wrapped once so both the Manager (sidebar) and Agent
    // (centered card) shells render the exact same content. Keyed by page: a
    // crash in one page shows a compact fallback and navigating remounts a fresh
    // boundary. Suspense catches the lazy secondary-page chunks; the eager Users
    // page renders synchronously and never suspends.
    const pageBody = (
      <ErrorBoundary key={page} compact>
        <Suspense fallback={<PageFallback />}>
          {page === "users"     && <UsersPage     toast={toast} onOpenSettings={() => navigate("settings")} kiosk={settings.kioskMode} ensureFreshAuth={ensureFreshAuth} />}
          {page === "devices"   && (
            <DevicesPage
              toast={toast}
              kiosk={settings.kioskMode}
              onOpenDeviceSettings={() => { setSettingsTab("devices"); navigate("settings"); }}
              onOpenConnectionSettings={() => { setSettingsTab("connection"); navigate("settings"); }}
              onOpenInventorySettings={() => { setSettingsTab("inventory"); navigate("settings"); }}
            />
          )}
          {page === "inventory" && <InventoryPage toast={toast} onOpenSettings={() => { setSettingsTab("inventory"); navigate("settings"); }} />}
          {page === "settings"  && <SettingsPage  toast={toast} onSettingsChange={reloadSettings} onUpdateModal={setSuppressTakeover} initialTab={settingsTab} />}
          {page === "console"   && devMode && <ConsolePage />}
        </Suspense>
      </ErrorBoundary>
    );

    content = (
      <>
        {moduleMissing && continueAnyway && !bannerDismissed && (
          <div className="anim-banner flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-sm">
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
          <div className="anim-banner flex items-center gap-2 px-4 py-2 bg-violet-600 text-white text-sm">
            <Download size={15} className="flex-shrink-0" />
            <span className="flex-1">
              Atualização {update.version ? `(${update.version}) ` : ""}pronta a instalar.
            </span>
            <button
              onClick={startInstall}
              className="px-3 py-1 rounded-md bg-white/15 hover:bg-white/25 font-medium transition-colors"
            >
              Reiniciar e instalar
            </button>
            <button onClick={() => setUpdateBannerDismissed(true)} className="p-1 rounded hover:bg-white/15 transition-colors">
              <X size={14} />
            </button>
          </div>
        )}

        {IS_AGENT ? (
          // Slim installer: no sidebar, just the onboarding wizard in a compact
          // card centered on the page (Settings is reachable via the wizard's
          // deep-link / the hidden number hotkeys, with a Back affordance).
          <AgentShell page={page} onBack={() => navigate("devices")}>
            {pageBody}
          </AgentShell>
        ) : (
          <div className="flex flex-1 overflow-hidden">
            <Sidebar
              active={page}
              onNavigate={navigate}
              devMode={devMode}
              inventoryEnabled={inventoryEnabled}
              userName={displayName || lastUsername}
              connOk={connOk}
              onLogout={onLogout}
            />
            <main className="flex-1 overflow-hidden flex flex-col bg-white">
              {/* Keyed by page so a fresh element mounts on every sidebar
                  navigation — a light cross-fade marks the page change without
                  the desktop-app feel of an instant hard cut. */}
              <div key={page} className="anim-page flex flex-1 flex-col overflow-hidden">
                {pageBody}
              </div>
            </main>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      <TitleBar />
      {content}
      {reauth && (
        <ReAuthModal
          username={displayName || lastUsername}
          onResult={resolveReauth}
        />
      )}
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}

// Kiosk re-auth prompt. Rendered as an overlay OVER the live app (the users/devices
// list stays visible behind it) — kiosk mode never logs out, it just re-confirms
// the operator before a sensitive action once the re-auth window has lapsed.
// Cancel aborts the action; a correct password verifies against the live session.
function ReAuthModal({ username, onResult }: { username: string; onResult: (ok: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = useCallback(async () => {
    if (!password || busy) return;
    setBusy(true);
    setError("");
    const r = await reverify(password);
    if (r.ok) {
      onResult(true);
      return; // modal unmounts; no need to clear busy
    }
    setBusy(false);
    setPassword("");
    setError(r.error || "Palavra-passe incorreta.");
    inputRef.current?.focus();
  }, [password, busy, onResult]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-900/50 backdrop-blur-sm">
      <div
        className="anim-popover w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl"
        onKeyDown={(e) => { if (e.key === "Escape") onResult(false); }}
      >
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-100 text-violet-600">
            <Lock size={18} />
          </span>
          <div>
            <h2 className="text-base font-semibold text-zinc-800">Confirmar identidade</h2>
            <p className="text-xs text-zinc-500">
              {username ? `Sessão de ${username}` : "Sessão ativa"} · confirma a palavra-passe para continuar
            </p>
          </div>
        </div>

        <input
          ref={inputRef}
          type="password"
          value={password}
          autoComplete="current-password"
          disabled={busy}
          onChange={(e) => { setPassword(e.target.value); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="Palavra-passe"
          className="mt-5 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none transition-colors focus:border-violet-400 focus:ring-2 focus:ring-violet-100 disabled:bg-zinc-50"
        />
        {error && <p className="mt-2 text-xs font-medium text-red-600">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onResult(false)}
            disabled={busy}
            className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !password}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            Confirmar
          </button>
        </div>
      </div>
    </div>
  );
}

// Shown for the brief moment a code-split page chunk is loading.
function PageFallback() {
  return (
    <div className="flex flex-1 items-center justify-center bg-white">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-200 border-t-violet-500" />
    </div>
  );
}

// The Agent's slim-installer chrome: a single card floated in the middle of the
// page, no sidebar. The card sizes to its content and centers vertically, but
// caps at the viewport (scrolling internally) so a long onboarding run still
// fits. Settings — reached via the wizard's deep-link or the hidden hotkeys —
// gets a wider card and a Back button, since there's no sidebar to return with.
function AgentShell({ page, onBack, children }: { page: Page; onBack: () => void; children: React.ReactNode }) {
  const wide = page !== "devices";
  return (
    <div className="flex flex-1 overflow-y-auto bg-gradient-to-b from-zinc-100 to-zinc-200/60 px-6 py-8">
      <div
        className={cn(
          "mx-auto my-auto flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xl shadow-zinc-900/10",
          wide ? "max-w-[820px]" : "max-w-[600px]",
        )}
      >
        {page !== "devices" && (
          <div className="flex items-center border-b border-zinc-200 px-3 py-2">
            <button
              onClick={onBack}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
            >
              <ChevronLeft size={14} /> Voltar ao onboarding
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
