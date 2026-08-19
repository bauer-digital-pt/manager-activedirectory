import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { Toaster, toast } from "sonner";
import { AlertTriangle, Download, X, ChevronLeft, Lock, Loader2, Fingerprint } from "lucide-react";
import { cn } from "./lib/cn";
import Sidebar from "./components/Sidebar";
import TitleBar from "./components/TitleBar";
import LoginGate from "./components/LoginGate";
import ErrorBoundary from "./components/ErrorBoundary";
import SetupRequired from "./components/SetupRequired";
import WifiGate from "./components/WifiGate";
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
import { getBiometricInfo, biometricPrompt, biometricLabel, type BiometricInfo } from "./lib/biometric";
import { getSettings, type AppSettings, DEFAULT_SETTINGS } from "./lib/appSettings";
import { getInventoryConfig } from "./lib/inventoryConfig";
import { confirmNav } from "./lib/navGuard";
import { getWifiStatus, isWrongWifi, type WifiStatus } from "./lib/wifi";
import { IS_AGENT, FLAVOR_UI } from "./lib/flavor";
import logo from "./assets/bauer-media-logo.svg";
import brandMark from "./assets/logo_2.png";

export type Page = "users" | "devices" | "inventory" | "settings" | "console";

// The three device views behind the single "Dispositivos" sidebar item:
//  • ad           — raw AD computer objects, no EZOffice overlay.
//  • ezoffice     — the EZOffice asset inventory (source of truth for hardware).
//  • consolidated — AD list enriched with the matching EZOffice asset (default).
export type DeviceView = "ad" | "ezoffice" | "consolidated";

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
  const [settingsTab, setSettingsTab] = useState<"general" | "groups" | "devices" | "connection">("general");
  // Which of the three device sub-views the "Dispositivos" item opens on.
  const [deviceView, setDeviceView] = useState<DeviceView>("consolidated");
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
  // Login is required on every launch, so `authed` starts false. Two lock tiers:
  //  • `softLocked` — first tier (inactivity ≥ loginTimeoutMin, or manual "Bloquear").
  //    The session STAYS ALIVE in memory; a full-screen overlay re-confirms identity
  //    (biometric OR password via reverify) without a full re-login.
  //  • `locked` — second tier: the session was fully dropped (a soft lock outlived
  //    fullTimeoutHours, or an explicit sign-out relock). LoginGate asks the password.
  const [authed, setAuthed] = useState(false);
  const [locked, setLocked] = useState(false);
  const [softLocked, setSoftLocked] = useState(false);
  // When the current soft lock began — the absolute (full-timeout) escalation is
  // measured from here, so it counts the walk-away, not activity behind the overlay.
  const softLockAtRef = useRef(0);
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

  // --- Wrong-Wi-Fi pre-login gate ---
  // Latest detected Wi-Fi status (null = undetermined → never blocks). `wifiChecking`
  // drives the "Verificar novamente" spinner on the gate.
  const [wifiStatus, setWifiStatus] = useState<WifiStatus | null>(null);
  const [wifiChecking, setWifiChecking] = useState(false);
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

  // Switch the active device sub-view (from the sidebar "Dispositivos" flyout).
  // Changing view while already on Devices needs no nav guard (Manager's device
  // list has no unsaved state); coming from elsewhere goes through the guard.
  const navigateDevice = useCallback((view: DeviceView) => {
    if (page !== "devices" && !confirmNav()) return;
    setDeviceView(view);
    if (page !== "devices") setPage("devices");
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
    // A re-auth is already pending (e.g. a stray double-dispatch): don't open a
    // second modal or overwrite the live resolver — abort this extra caller.
    if (reauthResolveRef.current) return false;
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
    setSoftLocked(false);
    setConnOk(null);
    setPage(HOME_PAGE);
  }, []);

  // Manual "Bloquear" (profile dropdown) — soft-lock immediately. The session
  // stays alive (no logout, no confirmNav: an in-progress wizard is preserved
  // behind the overlay); the lock screen re-confirms identity to resume. Works in
  // every mode, including kiosk (an explicit lock is always the operator's choice).
  const onLock = useCallback(() => {
    if (!authed || softLocked) return;
    softLockAtRef.current = Date.now();
    setSoftLocked(true);
  }, [authed, softLocked]);

  // Successful soft-lock unlock (biometric or password). The session was never
  // dropped, so just lift the overlay and open a fresh kiosk re-auth window (the
  // identity was just proven) — unifying the lock unlock with the re-auth gate.
  const onUnlock = useCallback(() => {
    lastAuthAtRef.current = Date.now();
    setSoftLocked(false);
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

  // Wrong-Wi-Fi gate: probe the associated SSID up front and on an interval, plus
  // whenever the window regains focus (so switching networks is picked up right
  // away). The POLL runs regardless of `authed` (cheap, and keeps the status warm
  // so the gate is instant at the login screen); the GATE itself only shows
  // pre-login (see the !authed branch below) so it never interrupts a logged-in
  // operator. Recovering the correct network drops the gate on the next probe.
  const probeWifi = useCallback(
    () => getWifiStatus().then(setWifiStatus).catch(() => setWifiStatus(null)),
    [],
  );
  useEffect(() => {
    probeWifi();
    const id = window.setInterval(probeWifi, 10000);
    const onFocus = () => probeWifi();
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [probeWifi]);

  const recheckWifi = useCallback(async () => {
    setWifiChecking(true);
    await probeWifi();
    setWifiChecking(false);
  }, [probeWifi]);

  // First tier — inactivity SOFT lock: after `loginTimeoutMin` with no activity,
  // cover the app with the lock screen but KEEP the session alive, so the operator
  // resumes with a biometric or password instead of a full re-login. Any activity
  // resets the timer. Kiosk mode opts out entirely — it "never logs out" and gates
  // sensitive actions with a re-auth prompt instead.
  useEffect(() => {
    if (!authed || locked || softLocked || settings.kioskMode) return;
    const ms = Math.min(60, Math.max(5, settings.loginTimeoutMin)) * 60_000;
    let timer: number;
    const doSoftLock = () => { softLockAtRef.current = Date.now(); setSoftLocked(true); };
    const reset = () => { window.clearTimeout(timer); timer = window.setTimeout(doSoftLock, ms); };
    const events: (keyof WindowEventMap)[] = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"];
    events.forEach((ev) => window.addEventListener(ev, reset, { passive: true }));
    reset();
    return () => {
      window.clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, reset));
    };
  }, [authed, locked, softLocked, settings.loginTimeoutMin, settings.kioskMode]);

  // Second tier — absolute (full) timeout: once soft-locked, the session may live
  // at most `fullTimeoutHours` (floor 48h) before it's FULLY dropped and a real
  // re-login is required. A biometric proves presence, never the password, so it
  // can't keep a stale session alive forever. Measured from the lock moment and
  // NOT reset by activity (the overlay is all that's on screen). Kiosk opts out.
  useEffect(() => {
    if (!softLocked || settings.kioskMode) return;
    const capMs = Math.min(720, Math.max(48, settings.fullTimeoutHours)) * 3_600_000;
    const remaining = Math.max(0, capMs - (Date.now() - softLockAtRef.current));
    const doFullLogout = () => {
      logout();
      setSoftLocked(false);
      setAuthed(false);
      setLocked(true);
      setConnOk(null);
      setPage(HOME_PAGE);
    };
    const timer = window.setTimeout(doFullLogout, remaining);
    return () => window.clearTimeout(timer);
  }, [softLocked, settings.kioskMode, settings.fullTimeoutHours]);

  // ── Screen selection ──────────────────────────────────────────────────────
  let content: React.ReactNode;

  // Only ever blocks on a positively-identified wrong network; undetermined
  // (off-Windows, IPC error, wired) resolves to false, so login proceeds.
  const wrongWifi = isWrongWifi(wifiStatus);

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
  } else if (!authed && wrongWifi) {
    // Wrong Wi-Fi takes precedence over every other PRE-LOGIN screen (setup,
    // update): AD work needs the office network, so warn immediately instead of
    // letting login fail cryptically ("sem sequer pedir login"). Applies to BOTH
    // flavors. Gated on !authed so it never yanks a logged-in operator out of an
    // in-progress onboarding wizard (whose state is component-local) — a network
    // blip mid-task surfaces as connection errors, not lost work.
    content = (
      <WifiGate ssid={wifiStatus?.ssid ?? null} onRecheck={recheckWifi} rechecking={wifiChecking} />
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
              view={deviceView}
              onNavigateDevice={navigateDevice}
              showViewTabs={inventoryEnabled}
              onOpenDeviceSettings={() => { setSettingsTab("devices"); navigate("settings"); }}
              onOpenConnectionSettings={() => { setSettingsTab("connection"); navigate("settings"); }}
              onOpenInventorySettings={() => { setSettingsTab("connection"); navigate("settings"); }}
              onOpenReconciliation={() => navigate("inventory")}
            />
          )}
          {page === "inventory" && <InventoryPage toast={toast} onOpenSettings={() => { setSettingsTab("connection"); navigate("settings"); }} />}
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
              userName={displayName || lastUsername}
              connOk={connOk}
              onLogout={onLogout}
              onLock={onLock}
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
          biometricEnabled={settings.biometricEnabled}
          onResult={resolveReauth}
        />
      )}
      {authed && softLocked && (
        <LockScreen
          username={displayName || lastUsername}
          biometricEnabled={settings.biometricEnabled}
          onUnlock={onUnlock}
          onLogout={onLogout}
        />
      )}
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}

// Shared identity re-confirmation — the unified "prove it's you" flow used by BOTH
// the kiosk re-auth gate (ReAuthModal) and the soft-lock screen (LockScreen). Offers
// the OS biometric (when enabled AND available) OR the session password (reverify),
// then calls onVerified. Owns the fields, biometric probe, busy + error state, and a
// footer with a caller-supplied secondary action (Cancel / Terminar sessão). The
// surrounding chrome (modal vs full-screen) is the caller's.
function IdentityConfirm({
  biometricEnabled,
  reason,
  onVerified,
  secondaryLabel,
  onSecondary,
  autoPrompt = false,
}: {
  biometricEnabled: boolean;
  reason: string;
  onVerified: () => void;
  secondaryLabel: string;
  onSecondary: () => void;
  // Fire the OS biometric prompt automatically as soon as it's known available
  // (the lock screen: "come back → Touch ID"). A cancel/failure here is silent —
  // the button + password stay as the fallback, no scary error before any action.
  autoPrompt?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [bio, setBio] = useState<BiometricInfo>({ available: false, kind: null });
  const inputRef = useRef<HTMLInputElement>(null);
  // Guard so the auto-prompt fires at most once per mount.
  const autoPromptedRef = useRef(false);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (!biometricEnabled) { setBio({ available: false, kind: null }); return; }
    let alive = true;
    getBiometricInfo().then((info) => { if (alive) setBio(info); }).catch(() => {});
    return () => { alive = false; };
  }, [biometricEnabled]);

  const submitPassword = useCallback(async () => {
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await reverify(password);
      if (r.ok) {
        onVerified();
        return; // component unmounts; no need to clear busy
      }
      setError(r.error || "Palavra-passe incorreta.");
    } catch (e) {
      // reverify is a throw-free IPC call today, but never leave the form stuck
      // "busy" (the secondary action is the only way out then) if that changes.
      setError(e instanceof Error ? e.message : "Não foi possível confirmar a identidade.");
    }
    setBusy(false);
    setPassword("");
    inputRef.current?.focus();
  }, [password, busy, onVerified]);

  const runBiometric = useCallback(async (silent = false) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const r = await biometricPrompt(reason);
    if (r.ok) { onVerified(); return; }
    // An auto-prompt the operator didn't ask for shouldn't shout on cancel — just
    // fall back to the button + password. A manual attempt surfaces the reason.
    if (!silent) setError(r.error || "Verificação biométrica falhada.");
    setBusy(false);
  }, [busy, reason, onVerified]);

  // Lock screen: as soon as biometrics report available, prompt once automatically
  // so the operator gets Touch ID / Hello instead of reaching for the password.
  useEffect(() => {
    if (!autoPrompt || autoPromptedRef.current || !bio.available) return;
    autoPromptedRef.current = true;
    void runBiometric(true);
  }, [autoPrompt, bio.available, runBiometric]);

  return (
    <>
      {bio.available && (
        <button
          type="button"
          onClick={() => runBiometric()}
          disabled={busy}
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-4 py-2.5 text-sm font-medium text-violet-700 transition-colors hover:bg-violet-100 disabled:opacity-50"
        >
          <Fingerprint size={16} /> Usar {biometricLabel(bio.kind)}
        </button>
      )}
      <input
        ref={inputRef}
        type="password"
        value={password}
        autoComplete="current-password"
        disabled={busy}
        onChange={(e) => { setPassword(e.target.value); setError(""); }}
        // Stop keystrokes bubbling to window-level handlers behind the overlay
        // (UserRow's / the create-wizard's Enter/Escape listeners) — otherwise the
        // same Enter that confirms here re-fires the gated action underneath.
        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); submitPassword(); } }}
        placeholder="Palavra-passe"
        className={cn(
          "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none transition-colors focus:border-violet-400 focus:ring-2 focus:ring-violet-100 disabled:bg-zinc-50",
          bio.available ? "mt-3" : "mt-5",
        )}
      />
      {error && <p className="mt-2 text-xs font-medium text-red-600">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          // Never disabled: the secondary action must always be a way out, even
          // mid-verify (the caller clears any pending resolver on it).
          onClick={onSecondary}
          className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100"
        >
          {secondaryLabel}
        </button>
        <button
          type="button"
          onClick={submitPassword}
          disabled={busy || !password}
          className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          Confirmar
        </button>
      </div>
    </>
  );
}

// Kiosk re-auth prompt. Rendered as an overlay OVER the live app (the users/devices
// list stays visible behind it) — kiosk mode never logs out, it just re-confirms
// the operator before a sensitive action once the re-auth window has lapsed.
// Cancel aborts the action; a biometric or correct password verifies the session.
function ReAuthModal({
  username,
  biometricEnabled,
  onResult,
}: {
  username: string;
  biometricEnabled: boolean;
  onResult: (ok: boolean) => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-900/50 backdrop-blur-sm">
      <div
        className="anim-popover w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl"
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onResult(false); } }}
      >
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-100 text-violet-600">
            <Lock size={18} />
          </span>
          <div>
            <h2 className="text-base font-semibold text-zinc-800">Confirmar identidade</h2>
            <p className="text-xs text-zinc-500">
              {username ? `Sessão de ${username}` : "Sessão ativa"} · confirma para continuar
            </p>
          </div>
        </div>

        <IdentityConfirm
          biometricEnabled={biometricEnabled}
          reason="Confirma a tua identidade para continuar"
          onVerified={() => onResult(true)}
          secondaryLabel="Cancelar"
          onSecondary={() => onResult(false)}
        />
      </div>
    </div>
  );
}

// Soft-lock screen — first-tier inactivity lock (or a manual "Bloquear"). A full,
// opaque takeover over the live app: the session is STILL alive, so the operator
// resumes with a biometric or the password (reverify) rather than a full re-login.
// There's no "cancel" — the only ways out are unlock or an explicit sign-out.
function LockScreen({
  username,
  biometricEnabled,
  onUnlock,
  onLogout,
}: {
  username: string;
  biometricEnabled: boolean;
  onUnlock: () => void;
  onLogout: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-zinc-900/70 backdrop-blur-md">
      <div className="anim-popover w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-violet-100 text-violet-600">
            <Lock size={20} />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-800">Sessão bloqueada</h2>
            <p className="truncate text-xs text-zinc-500">
              {username ? `Sessão de ${username}` : "Sessão ativa"} · desbloqueia para continuar
            </p>
          </div>
        </div>

        <IdentityConfirm
          biometricEnabled={biometricEnabled}
          reason="Desbloqueia a sessão"
          onVerified={onUnlock}
          secondaryLabel="Terminar sessão"
          onSecondary={onLogout}
          autoPrompt
        />
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

// The Agent's slim-installer chrome — no sidebar. The onboarding surface
// ("devices") is a full-bleed, Windows-Setup-style experience: the Bauer purple
// gradient fills the screen with slow-drifting glow blobs and the brand mark
// pinned top-left, and the wizard renders light-on-dark directly over it (no
// card). Settings — reached via the wizard's deep-link or the hidden hotkeys —
// keeps a legible white card floated on the same backdrop, with a Back button
// since there's no sidebar to return with.
function AgentShell({ page, onBack, children }: { page: Page; onBack: () => void; children: React.ReactNode }) {
  const onboarding = page === "devices";
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-[#1a0538]">
      {/* Brand backdrop — the same identity as the login/status screens, spread
          full-bleed. The gradient is the base; drifting blobs give it life. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(152deg, rgba(87,19,189,0.86) 0%, rgba(71,0,163,0.92) 52%, rgba(55,0,125,0.96) 100%)",
        }}
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="oobe-blob absolute -top-24 -left-16 h-96 w-96 rounded-full"
          style={{ background: "radial-gradient(closest-side, rgba(255,255,255,0.10), transparent)", ["--bx" as string]: "40px", ["--by" as string]: "30px" }}
        />
        <div
          className="oobe-blob absolute -bottom-28 -right-16 h-[28rem] w-[28rem] rounded-full"
          style={{ background: "radial-gradient(closest-side, rgba(31,209,189,0.16), transparent)", ["--bx" as string]: "-36px", ["--by" as string]: "-28px", animationDelay: "3s" }}
        />
        <div
          className="oobe-blob absolute bottom-10 left-1/3 h-64 w-64 rounded-full"
          style={{ background: "radial-gradient(closest-side, rgba(120,60,220,0.28), transparent)", ["--bx" as string]: "24px", ["--by" as string]: "-40px", animationDelay: "6s" }}
        />
      </div>

      {/* Brand mark, top-left — anchors the surface to Bauer. */}
      <div className="relative z-10 flex shrink-0 items-center gap-3 px-8 pt-7">
        <img src={brandMark} alt="Bauer Media" className="h-8 w-auto" />
        {FLAVOR_UI.eyebrow && <span className="text-sm font-semibold tracking-wide text-white/90">{FLAVOR_UI.eyebrow}</span>}
      </div>

      {onboarding ? (
        // Full-bleed OOBE: the wizard owns the whole surface (it centers itself).
        <div className="relative z-10 flex flex-1 flex-col overflow-hidden">{children}</div>
      ) : (
        // Settings / console: a legible white card floated on the backdrop.
        <div className="relative z-10 flex flex-1 overflow-y-auto px-6 pb-8 pt-4">
          <div className="mx-auto my-auto flex max-h-full w-full max-w-[820px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-white shadow-2xl shadow-black/30">
            <div className="flex items-center border-b border-zinc-200 px-3 py-2">
              <button
                onClick={onBack}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
              >
                <ChevronLeft size={14} /> Voltar ao onboarding
              </button>
            </div>
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
