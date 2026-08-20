import { useState, useEffect, useCallback, useRef } from "react";
import {
  Laptop, RefreshCw, Check, AlertTriangle, ServerCrash, Loader2, Play,
  RotateCcw, Languages, ShieldCheck, Monitor, Network,
  Power, X, Pause, Printer, AppWindow, ArrowRight, ChevronLeft,
} from "lucide-react";
import type { ExternalToast } from "sonner";
import { adAPI, isBrowserMock, type PCStatus, type OnboardStep, type OnboardState, type ADUserLite } from "../adAPI";
import { getDeviceConfig, EMPTY_DEVICE_CONFIG, type DeviceConfig } from "../lib/deviceConfig";
import { setNavGuard } from "../lib/navGuard";
import SearchableSelect from "../components/SearchableSelect";
import { StepIcon, AuraBadge } from "../components/onboarding/StepIcon";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { focusRingDark } from "../components/ui/controls";
import { cn } from "../lib/cn";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

// Fallback installer sources — used when Settings → Dispositivos leaves them
// blank, so the automatic run always has something to install from.
const DEFAULT_ANYCONNECT = "\\\\pt-srv-nas\\IT\\Software\\Cisco Anyconnect\\anyconnect-win-4.10.08029-core-vpn-webdeploy-k9.msi";
const DEFAULT_SCREENCONNECT = "\\\\pt-srv-nas\\IT\\Software\\ScreenConnect\\ScreenConnect.ClientSetup.msi";
const DEFAULT_PRINTER_SOURCE = "\\\\pt-srv-nas\\IT\\Software\\Printers\\RICOHPCL6";
const DEFAULT_SMLPLAYER = "\\\\pt-srv-nas\\IT\\Software\\SMLPlayer\\SMLPlayer-7.11.9357-Install.exe";
const DEFAULT_SMLPLAYER_INI = "\\\\pt-srv-nas\\IT\\Software\\SMLPlayer\\Main.ini";

// Grace period before the single end-of-run reboot fires automatically.
const REBOOT_SECONDS = 30;

interface StepDef {
  key: OnboardStep;
  label: string;
  desc: string;
  icon: React.ElementType;
}

// Execution order: everything that doesn't force a reboot first (regional +
// installs), then the domain join/rename/move last — the machine reboots ONCE
// at the very end so all pending reboots collapse into one.
const STEPS: StepDef[] = [
  { key: "regional",      label: "Definições regionais",   desc: "SO em inglês, região Portugal, teclado português",          icon: Languages },
  { key: "anyconnect",    label: "Cisco AnyConnect",       desc: "Instalação silenciosa a partir do NAS",                     icon: ShieldCheck },
  { key: "screenconnect", label: "ScreenConnect",          desc: "Instalação silenciosa a partir do NAS",                     icon: Monitor },
  { key: "smlplayer",     label: "SMLPlayer",              desc: "Instalar, abrir/fechar e aplicar o Main.ini",               icon: AppWindow },
  { key: "printers",      label: "Impressoras",            desc: "Configurar as impressoras do departamento (RICOHPCL6)",     icon: Printer },
  { key: "domain",        label: "Domínio + nome + pasta", desc: "Juntar a bmap.lis, renomear e mover para a pasta correta",  icon: Network },
];

// The printers step is only relevant when the machine's department has printers
// selected in Settings; otherwise it's dropped from the run and the checklist.
function applicableSteps(printerCount: number): StepDef[] {
  return printerCount > 0 ? STEPS : STEPS.filter((s) => s.key !== "printers");
}

// The AD-computer description written during the domain step, from the chosen
// "prepared for" user. Empty string when no user was picked (→ description left
// untouched). Kept ASCII-safe on the label; the name itself may carry accents.
function preparedForDescription(pf?: { sam: string; name: string } | null): string {
  if (!pf || !pf.name) return "";
  return pf.sam ? `Preparado para ${pf.name} (${pf.sam})` : `Preparado para ${pf.name}`;
}

type Phase = "idle" | "running" | "paused" | "reboot" | "rebooting" | "done";
type StepState = { state: "idle" | "running" | "done" | "error"; message?: string };

// A run drives REAL, irreversible PowerShell against this machine (domain join,
// silent installs). This module-level flag guarantees only ONE
// onboarding loop is ever in flight — even across a remount. A per-instance ref
// can't do this: navigating away (ErrorBoundary is keyed by page) unmounts the
// component and React StrictMode double-mounts in dev, both of which would give
// a fresh ref that's blind to the previous instance's still-running loop.
let runInFlight = false;

// Whether a dimension is already satisfied on the live machine.
function stepDone(status: PCStatus | null, key: OnboardStep): boolean {
  if (!status) return false;
  switch (key) {
    case "regional":      return status.regional.compliant;
    case "anyconnect":    return status.software.anyConnect;
    case "screenconnect": return status.software.screenConnect;
    // No reliable per-machine compliance probe for these: they always run (once
    // per onboarding, tracked via the persisted `completed` list, not status).
    case "smlplayer":     return false;
    case "printers":      return false;
    case "domain":        return status.domain.compliant && status.name.compliant;
  }
}

// The local-machine onboarding wizard. Agent-flavor only — the Manager's
// "Dispositivos" tab renders the read-only fleet list (DeviceListPage) instead;
// DevicesPage dispatches between the two by flavor.
export default function PcOnboardingWizard({
  toast,
  onOpenDeviceSettings,
}: {
  toast: { success: ToastFn; error: ToastFn };
  /** Opens Settings on the "Dispositivos" tab (to fix a missing OU mapping). */
  onOpenDeviceSettings?: () => void;
}) {
  const [status, setStatus] = useState<PCStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<DeviceConfig>(EMPTY_DEVICE_CONFIG);

  const [phase, setPhase] = useState<Phase>("idle");
  // Which idle screen is showing: 1) intro (explanation + start), 2) config
  // (department + prepared-for). Once a run starts (phase leaves "idle") the
  // step-by-step status takes over. Only meaningful while phase === "idle".
  const [wizardStep, setWizardStep] = useState<"intro" | "config">("intro");
  const [dept, setDept] = useState("");
  // Previewed device name for the selected department — "o número deve aparecer
  // logo". Fetched as soon as the config step opens; re-confirmed at start.
  const [nextName, setNextName] = useState<string | null>(null);
  const [nextNameLoading, setNextNameLoading] = useState(false);
  const nameSeq = useRef(0);
  // Who the machine is being prepared for (optional) — written to the computer's
  // AD description during the domain step. Held as {sam,name} so the picker can
  // show the display name while the description carries both.
  const [preparedFor, setPreparedFor] = useState<{ sam: string; name: string } | null>(null);
  const [userResults, setUserResults] = useState<ADUserLite[]>([]);
  const [userSearching, setUserSearching] = useState(false);
  const [activeState, setActiveState] = useState<OnboardState | null>(null);
  const [results, setResults] = useState<Record<string, StepState>>({});
  const [currentStep, setCurrentStep] = useState<OnboardStep | null>(null);
  const [starting, setStarting] = useState(false);
  const [rebootCountdown, setRebootCountdown] = useState<number | null>(null);
  // Destructive-teardown confirmation ("Cancelar onboarding"). `cancelBusy` locks
  // the dialog while the persisted run is cleared and the PC re-probed.
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);

  // Set to abort the auto-run between steps (Cancelar). A ref so the running
  // loop sees the latest value without being restarted.
  const cancelRef = useRef(false);
  // Whether THIS instance is still mounted. The loop checks it so a run left in
  // flight when the page unmounts (navigation, relock, StrictMode) stops after
  // its current step instead of driving PowerShell from a dead instance.
  const mountedRef = useRef(true);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Debounced AD user search for the "prepared for" picker. searchSeq drops stale
  // responses (a slower earlier query resolving after a newer one).
  const searchTimer = useRef<number | null>(null);
  const searchSeq = useRef(0);
  const searchUsers = useCallback((query: string) => {
    const q = query.trim();
    const seq = ++searchSeq.current;
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    if (q.length < 2) { setUserResults([]); setUserSearching(false); return; }
    setUserSearching(true);
    searchTimer.current = window.setTimeout(async () => {
      const r = await adAPI.searchUsers(q);
      if (seq !== searchSeq.current || !mountedRef.current) return; // superseded / unmounted
      setUserResults(r.ok && Array.isArray(r.data) ? r.data : []);
      setUserSearching(false);
    }, 250);
  }, []);
  useEffect(() => () => { if (searchTimer.current) window.clearTimeout(searchTimer.current); }, []);

  const busy = phase === "running" || phase === "rebooting" || starting;

  const finalizeDone = useCallback(async (hadActiveState: boolean) => {
    // Onboarding complete — drop the persisted state (this also disables the
    // start-on-boot login item in main) so the machine won't try to resume.
    if (hadActiveState) await adAPI.clearOnboardState();
    setActiveState(null);
    setRebootCountdown(null);
    setCurrentStep(null);
    setPhase("done");
  }, []);

  // Runs the given steps in order, persisting progress after each one so a
  // reboot (or a crash) can resume exactly where it stopped. Stops on the first
  // failure (→ "paused", operator can retry) and enters the reboot phase once
  // every step is done. No cross-step re-probe: "se não reinicia, não atualiza".
  const runSteps = useCallback(async (state: OnboardState, steps: StepDef[]) => {
    // Never start a second loop over the same machine (remount / StrictMode).
    if (runInFlight) return;
    runInFlight = true;
    cancelRef.current = false;
    setPhase("running");
    try {
      let current = state;
      for (const s of steps) {
        if (!mountedRef.current) return;                                   // unmounted: stop, release lock
        if (cancelRef.current) { setCurrentStep(null); setPhase("paused"); return; }
        setCurrentStep(s.key);
        setResults((r) => ({ ...r, [s.key]: { state: "running" } }));
        let res: Awaited<ReturnType<typeof adAPI.onboardStep>>;
        try {
          res = await adAPI.onboardStep({
            step: s.key,
            newName: s.key === "domain" ? current.targetName : undefined,
            targetOU: s.key === "domain" ? current.targetOU : undefined,
            description: s.key === "domain" ? (preparedForDescription(current.preparedFor) || undefined) : undefined,
            anyConnectSource: current.anyConnectSource,
            screenConnectSource: current.screenConnectSource,
            printers: s.key === "printers" ? current.printers : undefined,
            printerSource: s.key === "printers" ? current.printerSource : undefined,
            smlPlayerSource: s.key === "smlplayer" ? current.smlPlayerSource : undefined,
            smlPlayerIni: s.key === "smlplayer" ? current.smlPlayerIni : undefined,
          });
        } catch (e) {
          res = { ok: false, error: e instanceof Error ? e.message : "Falhou." };
        }
        if (!res.ok) {
          const err = res.error ?? "Falhou.";
          setResults((r) => ({ ...r, [s.key]: { state: "error", message: err } }));
          setCurrentStep(null);
          setPhase("paused");
          toastRef.current.error(`${s.label}: ${err}`);
          return;
        }
        const msg = res.data?.message ?? "Concluído.";
        setResults((r) => ({ ...r, [s.key]: { state: "done", message: msg } }));
        const completed = current.completed.includes(s.key) ? current.completed : [...current.completed, s.key];
        const nextState: OnboardState = { ...current, completed, updatedAt: Date.now() };
        const saved = await adAPI.setOnboardState(nextState);
        current = saved ?? nextState;
        setActiveState(current);
      }
      // The loop only checks cancel/mount at the top of each iteration, so a
      // Cancelar (or an unmount) that lands DURING the final step would otherwise
      // be dropped and the auto-reboot armed anyway. Re-check before arming it.
      if (!mountedRef.current) return;
      if (cancelRef.current) { setCurrentStep(null); setPhase("paused"); return; }
      // Every step done → the machine needs exactly one reboot to apply the domain
      // join / rename / regional settings. Arm the auto-reboot countdown.
      setCurrentStep(null);
      setPhase("reboot");
      setRebootCountdown(REBOOT_SECONDS);
    } finally {
      runInFlight = false;
    }
  }, []);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const [sRes, state, cfg] = await Promise.all([
        adAPI.getPCStatus(force),
        adAPI.getOnboardState(),
        getDeviceConfig(),
      ]);
      setConfig(cfg);
      if (!sRes.ok || !sRes.data) {
        setError(sRes.error ?? "Não foi possível obter o estado deste PC.");
        setLoading(false);
        return;
      }
      const st = sRes.data;
      setStatus(st);
      setLoading(false);

      if (state?.active) {
        // Resume an onboarding that was in progress (typically after the reboot).
        setActiveState(state);
        setDept(state.dept);
        setPreparedFor(state.preparedFor ?? null);
        setResults(Object.fromEntries(state.completed.map((k) => [k, { state: "done" as const }])));
        const remaining = applicableSteps(state.printers?.length ?? 0)
          .filter((s) => !state.completed.includes(s.key) && !stepDone(st, s.key));
        if (remaining.length > 0) {
          // A previous instance's loop may still hold the module lock while it
          // finishes its current (un-cancelable) PowerShell step — e.g. the
          // operator confirmed the navGuard and left mid-step, then came back.
          // Show progress immediately (never fall back to the idle picker, whose
          // live "Iniciar" button would let them kick off a second, conflicting
          // run) and take over as soon as the lock frees, so the run genuinely
          // "retoma quando voltares" instead of stalling.
          setPhase("running");
          void (async () => {
            while (runInFlight) {
              if (!mountedRef.current) return;
              await new Promise((r) => setTimeout(r, 250));
            }
            if (mountedRef.current) void runSteps(state, remaining);
          })();
        } else if (st.onboarded) {
          await finalizeDone(true);
          toastRef.current.success("Onboarding concluído — este PC está pronto.");
        } else {
          // Every step recorded but the machine isn't compliant yet: a reboot is
          // still pending. Offer it manually (don't surprise-reboot on launch).
          setPhase("reboot");
          setRebootCountdown(null);
        }
      } else {
        setDept((d) => d || st.departments[0] || "");
        setPhase(st.onboarded ? "done" : "idle");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível obter o estado deste PC.");
      setLoading(false);
    }
  }, [runSteps, finalizeDone]);

  useEffect(() => { void load(); }, [load]);

  // Preview the device number as soon as the config step opens (or the chosen
  // department changes) so the operator sees "PT-LPT-<DEPT>-01" immediately
  // instead of a placeholder. The lowest free slot is re-confirmed at start;
  // this is a live preview. nameSeq drops stale responses.
  useEffect(() => {
    if (phase !== "idle" || wizardStep !== "config" || !dept) { setNextName(null); return; }
    const seq = ++nameSeq.current;
    setNextNameLoading(true);
    void (async () => {
      const r = await adAPI.getNextDeviceName(dept);
      if (seq !== nameSeq.current || !mountedRef.current) return; // superseded / unmounted
      setNextName(r.ok && r.data ? r.data.name : null);
      setNextNameLoading(false);
    })();
  }, [phase, wizardStep, dept]);

  // On unmount, tell any in-flight run to stop after its current step. The step
  // itself can't be aborted mid-PowerShell, but this prevents a dead instance
  // from marching on to the next step (and lets the module lock be released).
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; cancelRef.current = true; };
  }, []);

  // Warn before a sidebar navigation or logout unmounts this page, in two cases:
  //  • a run is in flight — the state is persisted and resumes on return, but
  //    "app assume o controlo" means it shouldn't be interrupted by accident;
  //  • the auto-reboot countdown is armed — leaving clears the timer, so the
  //    promised automatic reboot would silently never fire (it drops to manual).
  // Not guarded once the reboot is deferred (countdown null) or while idle/paused,
  // where leaving loses nothing time-sensitive. Cleared on unmount.
  const rebootArmed = phase === "reboot" && rebootCountdown !== null;
  const guardNav = busy || rebootArmed;
  useEffect(() => {
    if (!guardNav) { setNavGuard(null); return; }
    setNavGuard(() =>
      window.confirm(
        rebootArmed
          ? "Este PC vai reiniciar automaticamente para concluir o onboarding. Se saíres agora, o reinício automático é cancelado (podes reiniciar manualmente ao voltar). Sair mesmo assim?"
          : "O onboarding automático está a decorrer. Sair desta página não o cancela — retoma quando voltares. Sair mesmo assim?"
      )
    );
    return () => setNavGuard(null);
  }, [guardNav, rebootArmed]);

  // Auto-reboot countdown. Fires the reboot at zero; a null countdown means the
  // reboot is armed but manual (operator deferred it, or a resume found it pending).
  const doReboot = useCallback(async () => {
    setRebootCountdown(null);
    setPhase("rebooting");
    await adAPI.reboot();
    // On a real machine the OS is going down now; the app relaunches at next
    // login and resumes via load(). In the browser mock the process survives —
    // simulate the post-reboot resume so the flow is verifiable end-to-end.
    if (isBrowserMock) {
      await new Promise((r) => setTimeout(r, 800));
      const [sRes, state] = await Promise.all([adAPI.getPCStatus(true), adAPI.getOnboardState()]);
      if (sRes.ok && sRes.data) setStatus(sRes.data);
      if (sRes.ok && sRes.data?.onboarded) {
        await finalizeDone(!!state?.active);
        toastRef.current.success("Onboarding concluído — este PC está pronto.");
      } else {
        setPhase("paused");
      }
    }
  }, [finalizeDone]);

  useEffect(() => {
    if (phase !== "reboot" || rebootCountdown === null) return;
    // Freeze the auto-reboot while the "Cancelar onboarding" dialog is open, so
    // the operator can decide without the countdown firing underneath them. (The
    // old native window.confirm blocked the event loop and paused it implicitly;
    // the styled ConfirmDialog doesn't, so pause it explicitly.)
    if (confirmCancel) return;
    if (rebootCountdown <= 0) { void doReboot(); return; }
    const t = window.setTimeout(() => setRebootCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [phase, rebootCountdown, doReboot, confirmCancel]);

  const departments = status?.departments ?? [];

  // Printers for the machine's department drive whether the "Impressoras" step is
  // shown/run: an active run's captured list wins; otherwise the current config
  // for the selected department (so the checklist reacts to the dropdown).
  const printersForDept = activeState
    ? (activeState.printers ?? [])
    : (dept ? (config.printerMap?.[dept] ?? []) : []);
  const visibleSteps = applicableSteps(printersForDept.length);

  const startOnboarding = async () => {
    if (!dept || busy) return;
    const targetOU = config.ouMap[dept] ?? "";
    if (!targetOU) {
      toastRef.current.error(
        `O departamento ${dept} ainda não tem pasta de destino definida. Configura em Definições → Dispositivos.`,
        onOpenDeviceSettings ? { action: { label: "Abrir Definições", onClick: onOpenDeviceSettings } } : undefined,
      );
      return;
    }
    setStarting(true);
    try {
      // Number is looked up from AD — the lowest free slot (01, 02, 03…).
      const nameRes = await adAPI.getNextDeviceName(dept);
      if (!nameRes.ok || !nameRes.data) {
        toastRef.current.error(nameRes.error ?? "Não foi possível obter o número disponível na AD.");
        return;
      }
      const targetName = nameRes.data.name;
      const now = Date.now();
      const printers = config.printerMap?.[dept] ?? [];
      const applicable = applicableSteps(printers.length);
      const preDone = applicable.filter((s) => stepDone(status, s.key)).map((s) => s.key);
      const state: OnboardState = {
        active: true,
        dept,
        targetName,
        targetOU,
        anyConnectSource: config.anyConnectSource || DEFAULT_ANYCONNECT,
        screenConnectSource: config.screenConnectSource || DEFAULT_SCREENCONNECT,
        printers,
        printerSource: config.printerSource || DEFAULT_PRINTER_SOURCE,
        smlPlayerSource: config.smlPlayerSource || DEFAULT_SMLPLAYER,
        smlPlayerIni: config.smlPlayerIni || DEFAULT_SMLPLAYER_INI,
        preparedFor: preparedFor ?? undefined,
        completed: preDone,
        startedAt: now,
        updatedAt: now,
      };
      const saved = await adAPI.setOnboardState(state); // persists + enables start-on-boot
      const effective = saved ?? state;
      setActiveState(effective);
      setResults(Object.fromEntries(preDone.map((k) => [k, { state: "done" as const }])));
      const remaining = applicable.filter((s) => !preDone.includes(s.key));
      if (remaining.length === 0) {
        if (status?.onboarded) {
          await finalizeDone(true);
          toastRef.current.success("Este PC já cumpre todos os requisitos.");
        } else {
          setPhase("reboot");
          setRebootCountdown(REBOOT_SECONDS);
        }
        return;
      }
      await runSteps(effective, remaining);
    } finally {
      setStarting(false);
    }
  };

  const continueOnboarding = async () => {
    if (!activeState || busy) return;
    const remaining = applicableSteps(activeState.printers?.length ?? 0)
      .filter((s) => !activeState.completed.includes(s.key) && !stepDone(status, s.key));
    if (remaining.length === 0) { setPhase("reboot"); setRebootCountdown(REBOOT_SECONDS); return; }
    await runSteps(activeState, remaining);
  };

  // Pauses a resumable run — stops the loop after its current (un-abortable)
  // step; the operator can pick it back up with "Tentar novamente".
  const cancelRun = () => { cancelRef.current = true; };

  // Opens the destructive teardown confirmation; the actual clear runs in
  // performCancelOnboarding once the operator confirms.
  const cancelOnboarding = () => setConfirmCancel(true);

  const performCancelOnboarding = async () => {
    setCancelBusy(true);
    cancelRef.current = true;
    await adAPI.clearOnboardState();
    setActiveState(null);
    setPreparedFor(null);
    setRebootCountdown(null);
    setResults({});
    setCurrentStep(null);
    setWizardStep("intro");
    const r = await adAPI.getPCStatus(true);
    if (r.ok && r.data) { setStatus(r.data); setPhase(r.data.onboarded ? "done" : "idle"); }
    else setPhase("idle");
    setCancelBusy(false);
    setConfirmCancel(false);
    toastRef.current.success("Onboarding automático cancelado.");
  };

  // Per-step display state derived from the live status + this run's results.
  const displayState = (key: OnboardStep): StepState["state"] => {
    const r = results[key]?.state;
    if (r === "error") return "error";
    if (currentStep === key && phase === "running") return "running";
    if (r === "done" || stepDone(status, key)) return "done";
    return "idle";
  };

  const doneCount = visibleSteps.filter((s) => displayState(s.key) === "done").length;

  // Per-step views drive the progress bar and the recap list.
  const stepViews = visibleSteps.map((s) => ({ def: s, state: displayState(s.key), message: results[s.key]?.message }));
  // On the terminal "done" page the machine is compliant by definition, but a few
  // steps (SMLPlayer, printers) have no live compliance probe — coerce the recap
  // to fully done so a freshly-launched, already-onboarded PC doesn't show stale
  // "em espera" rows in its summary.
  const recapViews = phase === "done" ? stepViews.map((v) => ({ ...v, state: "done" as const })) : stepViews;
  const recapDone = recapViews.filter((v) => v.state === "done").length;
  // The step to feature (big) on the running page: the one actually executing,
  // else the first not-yet-done — covers the brief gap before the loop sets
  // currentStep, and the resume-after-reboot case.
  const activeStep =
    (currentStep ? visibleSteps.find((s) => s.key === currentStep) : null) ??
    visibleSteps.find((s) => displayState(s.key) !== "done") ??
    visibleSteps[visibleSteps.length - 1] ??
    null;
  const activeIndex = activeStep ? visibleSteps.findIndex((s) => s.key === activeStep.key) : 0;
  // "Exactly the action being taken" — the domain step names the concrete target.
  const activeActionLine = activeStep
    ? activeStep.key === "domain" && activeState?.targetName
      ? `A juntar ao domínio bmap.lis e a renomear para ${activeState.targetName}`
      : activeStep.desc
    : "";
  // The failed step to feature on the paused page.
  const failedView = stepViews.find((v) => v.state === "error") ?? null;

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden text-white">
      {/* Slim OOBE top bar — identity of the surface + a re-evaluate control.
          The brand mark itself lives on the AgentShell backdrop behind this. */}
      <div className="flex shrink-0 items-center justify-between px-8 pt-7 pb-2">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 text-white ring-1 ring-white/15">
            <Laptop size={18} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-white">Onboarding do PC</h2>
            <p className="text-xs text-white/50">Este computador (a sessão atual)</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading || busy}
          title="Reavaliar este PC"
          aria-label="Reavaliar este PC"
          className={cn(
            "inline-flex items-center justify-center rounded-lg border border-white/15 bg-white/[0.06] p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40",
            focusRingDark,
          )}
        >
          <RefreshCw size={15} className={cn((loading || busy) && "animate-spin")} />
        </button>
      </div>

      <div className="flex flex-1 overflow-y-auto px-6 pb-10">
        <div className="mx-auto my-auto w-full max-w-xl py-6">
          {loading ? (
            <div className="flex flex-col items-center gap-6 py-10">
              <div className="h-28 w-28 animate-pulse rounded-[28%] bg-white/[0.06]" />
              <div className="h-5 w-52 animate-pulse rounded-full bg-white/[0.06]" />
              <div className="h-3.5 w-72 animate-pulse rounded-full bg-white/[0.05]" />
            </div>
          ) : error ? (
            <StatusError message={error} onRetry={() => load(true)} />
          ) : status ? (
            <div key={`${phase}-${wizardStep}`} className="oobe-enter">
              {/* ── INTRO: a warm welcome + the whole plan, then a single start ── */}
              {phase === "idle" && wizardStep === "intro" && (
                <div className="flex flex-col items-center text-center">
                  <AuraBadge pulse size={124}>
                    <Laptop size={54} strokeWidth={1.5} />
                  </AuraBadge>
                  <h1 className="mt-7 text-2xl font-semibold leading-tight text-white">Vamos preparar este PC</h1>
                  <p className="mt-3 max-w-md text-sm leading-relaxed text-white/60">
                    A app trata de tudo automaticamente: definições regionais, aplicações essenciais
                    e a junção ao domínio. No fim o PC <strong className="font-semibold text-white/90">reinicia sozinho</strong> —
                    depois é só voltar a iniciar sessão e o resto continua.
                  </p>
                  <div className="mt-6 flex flex-wrap justify-center gap-2">
                    {STEPS.map((s) => (
                      <span key={s.key} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs text-white/70">
                        <s.icon size={13} className="text-white/50" /> {s.label}
                      </span>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setWizardStep("config")}
                    className={cn(
                      "group mt-9 inline-flex items-center justify-center gap-2 rounded-xl bg-white px-7 py-3 text-sm font-semibold text-brand shadow-lg shadow-black/20 transition-transform hover:scale-[1.02]",
                      focusRingDark,
                    )}
                  >
                    Começar <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
                  </button>
                </div>
              )}

              {/* ── CONFIG: department (+ live number) & who it's prepared for ── */}
              {phase === "idle" && wizardStep === "config" && (
                <div className="w-full">
                  <div className="text-center">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/40">Configuração</p>
                    <h1 className="mt-2 text-2xl font-semibold leading-tight text-white">Antes de começar</h1>
                    <p className="mt-2 text-sm text-white/55">Escolhe o departamento — o nome do PC aparece logo.</p>
                  </div>

                  <div className="mt-8 space-y-6 rounded-2xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-sm">
                    <div className="space-y-2.5">
                      <label className="text-xs font-semibold uppercase tracking-wider text-white/60">Departamento</label>
                      <div className="flex flex-wrap items-center gap-3">
                        <select
                          value={dept}
                          onChange={(e) => setDept(e.target.value)}
                          className="rounded-lg border border-white/15 bg-white/[0.07] px-3.5 py-2.5 text-sm text-white transition-all focus:border-white/30 focus:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/20 [&>option]:text-zinc-900"
                        >
                          {departments.length === 0 && <option value="">—</option>}
                          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                        <ArrowRight size={15} className="text-white/30" />
                        <code className="inline-flex items-center gap-1.5 rounded-lg bg-black/25 px-3 py-2.5 font-mono text-sm text-teal-200 ring-1 ring-white/10">
                          {nextNameLoading ? (
                            <><Loader2 size={12} className="animate-spin text-white/40" /><span className="text-white/40">a obter número…</span></>
                          ) : nextName ? (
                            nextName
                          ) : (
                            <>PT-LPT-{dept || "…"}-<span className="text-white/40">nº</span></>
                          )}
                        </code>
                      </div>
                      <p className="text-xs text-white/40">O número é o mais baixo disponível na AD (01, 02, 03…).</p>
                    </div>

                    {/* Who the machine is being prepared for — stamped onto the AD
                        computer object's description during the domain step. Optional. */}
                    <div className="space-y-2">
                      <label className="text-xs font-semibold uppercase tracking-wider text-white/60">Computador preparado para</label>
                      <SearchableSelect
                        className="max-w-md"
                        value={preparedFor?.sam ?? ""}
                        selectedLabel={preparedFor?.name}
                        onChange={(sam) => {
                          if (!sam) { setPreparedFor(null); return; }
                          const u = userResults.find((x) => x.SamAccountName === sam);
                          setPreparedFor({ sam, name: u?.DisplayName || preparedFor?.name || sam });
                        }}
                        options={userResults.map((u) => ({
                          value: u.SamAccountName,
                          label: u.DisplayName || u.SamAccountName,
                          sublabel: u.SamAccountName + (u.Enabled === false ? " · desativado" : ""),
                        }))}
                        onSearch={searchUsers}
                        loading={userSearching}
                        clearable
                        clearLabel="Sem utilizador"
                        placeholder="Procurar utilizador…"
                        searchPlaceholder="Nome ou username…"
                        emptyText="Escreve pelo menos 2 letras…"
                        disabled={busy}
                      />
                      <p className="text-xs text-white/40">
                        Opcional. Fica na descrição do computador na Active Directory
                        {preparedFor ? <> (<span className="font-medium text-white/60">{preparedForDescription(preparedFor)}</span>)</> : null}.
                      </p>
                    </div>
                  </div>

                  <div className="mt-6 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setWizardStep("intro")}
                      disabled={busy}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-lg px-3 py-2.5 text-sm font-medium text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50",
                        focusRingDark,
                      )}
                    >
                      <ChevronLeft size={15} /> Voltar
                    </button>
                    <button
                      type="button"
                      onClick={startOnboarding}
                      disabled={!dept || busy}
                      className={cn(
                        "ml-auto inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-brand shadow-lg shadow-black/20 transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100",
                        focusRingDark,
                      )}
                    >
                      {starting ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                      {starting ? "A iniciar…" : "Iniciar onboarding"}
                    </button>
                  </div>
                </div>
              )}

              {/* ── RUNNING: one step at a time, big and alive, with progress ── */}
              {phase === "running" && activeStep && (
                <RunningCard
                  views={stepViews}
                  active={activeStep}
                  index={activeIndex}
                  total={visibleSteps.length}
                  actionLine={activeActionLine}
                  onCancel={cancelRun}
                />
              )}

              {/* ── PAUSED: a step failed or the run was cancelled mid-way ── */}
              {phase === "paused" && (
                <PausedCard
                  views={stepViews}
                  failed={failedView}
                  doneCount={doneCount}
                  total={visibleSteps.length}
                  onContinue={continueOnboarding}
                  onCancel={cancelOnboarding}
                  busy={busy}
                />
              )}

              {/* ── REBOOT: all steps done, one reboot needed (+ recap) ── */}
              {phase === "reboot" && (
                <div className="flex flex-col items-center text-center">
                  {rebootCountdown !== null ? (
                    <RebootRing seconds={rebootCountdown} total={REBOOT_SECONDS} />
                  ) : (
                    <AuraBadge size={124}>
                      <Power size={52} strokeWidth={1.5} />
                    </AuraBadge>
                  )}
                  {/* Live region so the reboot state is announced ONCE on entering
                      this phase; the per-second countdown below is left visual-only
                      (no aria-live) so it isn't re-announced every tick. */}
                  <h1 role="status" aria-live="polite" className="mt-7 text-2xl font-semibold leading-tight text-white">
                    {rebootCountdown === null ? "Reinício pendente" : "Tudo pronto"}
                  </h1>
                  <p className="mt-3 max-w-md text-sm leading-relaxed text-white/60">
                    Os passos foram aplicados. O PC precisa de reiniciar para concluir a junção ao
                    domínio e a renomeação — depois inicia sessão outra vez e o onboarding termina sozinho.
                  </p>
                  {rebootCountdown !== null && (
                    <p className="mt-3 text-sm font-medium text-teal-200">A reiniciar automaticamente em {rebootCountdown}s…</p>
                  )}
                  <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={doReboot}
                      className={cn(
                        "inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-brand shadow-lg shadow-black/20 transition-transform hover:scale-[1.02]",
                        focusRingDark,
                      )}
                    >
                      <Power size={16} /> Reiniciar agora
                    </button>
                    {rebootCountdown !== null && (
                      <button
                        type="button"
                        onClick={() => setRebootCountdown(null)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-xl border border-white/15 px-5 py-3 text-sm font-medium text-white/80 transition-colors hover:bg-white/10",
                          focusRingDark,
                        )}
                      >
                        Adiar reinício
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={cancelOnboarding}
                    className={cn(
                      "mt-4 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white/40 transition-colors hover:text-white/80",
                      focusRingDark,
                    )}
                  >
                    <X size={13} /> Cancelar onboarding
                  </button>
                  <div className="mt-9 w-full text-left">
                    <RecapList views={recapViews} title="Passos aplicados" doneCount={recapDone} total={visibleSteps.length} />
                  </div>
                </div>
              )}

              {/* ── REBOOTING: the OS is going down (no-op off Windows) ── */}
              {phase === "rebooting" && (
                <div className="flex flex-col items-center text-center">
                  <AuraBadge pulse size={124}>
                    <Loader2 size={50} className="animate-spin" strokeWidth={1.6} />
                  </AuraBadge>
                  <h1 className="mt-7 text-2xl font-semibold leading-tight text-white">A reiniciar…</h1>
                  <p className="mt-3 max-w-md text-sm leading-relaxed text-white/60">
                    O PC vai reiniciar para concluir o onboarding. Volta a iniciar sessão no Windows
                    e na app — o resto continua sozinho.
                  </p>
                </div>
              )}

              {/* ── DONE: celebration + recap ── */}
              {phase === "done" && (
                <div className="flex flex-col items-center text-center">
                  <AuraBadge tone="success" burst size={124}>
                    <span className="oobe-pop inline-flex">
                      <svg width={58} height={58} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path className="oobe-draw" d="M5 12.5 10 17.5 19 7" style={{ ["--len" as string]: "26" }} />
                      </svg>
                    </span>
                  </AuraBadge>
                  <h1 className="mt-7 text-2xl font-semibold leading-tight text-white">Onboarding concluído</h1>
                  <p className="mt-3 max-w-md text-sm leading-relaxed text-white/60">
                    Este PC (<span className="font-medium text-white/90">{status.hostname}</span>) cumpre todos os requisitos.
                  </p>
                  <div className="mt-9 w-full text-left">
                    <RecapList views={recapViews} title="Resumo" doneCount={recapDone} total={visibleSteps.length} />
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* Destructive teardown confirmation (replaces the old window.confirm):
          clears the persisted run so the app stops resuming on its own. */}
      <ConfirmDialog
        open={confirmCancel}
        title="Cancelar onboarding"
        message="Cancelar o onboarding automático deste PC? O progresso já aplicado mantém-se, mas a app deixa de retomar sozinha."
        confirmLabel="Cancelar onboarding"
        cancelLabel="Voltar"
        tone="danger"
        busy={cancelBusy}
        onConfirm={performCancelOnboarding}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

// A step's view state, shared by the progress bar and the recap list.
type StepView = { def: StepDef; state: StepState["state"]; message?: string };

// Segmented progress bar — one segment per step, coloured by its state. Reads as
// "quanto falta" at a glance while keeping the focus on the single current step.
// Light-on-dark for the OOBE backdrop: teal = done, violet = running, the rest
// recede into a faint track.
function RunProgressBar({ views }: { views: StepView[] }) {
  return (
    <div className="flex items-center gap-1.5">
      {views.map(({ def, state }) => (
        <div
          key={def.key}
          className={cn(
            "h-1.5 flex-1 overflow-hidden rounded-full transition-colors",
            state === "done" ? "bg-teal-300"
              : state === "running" ? "relative bg-violet-300"
              : state === "error" ? "bg-amber-300"
              : "bg-white/12"
          )}
        >
          {state === "running" && <span className="oobe-sheen absolute inset-y-0 left-0 w-1/3 bg-white/60" />}
        </div>
      ))}
    </div>
  );
}

// RUNNING page — a single step, big and centred, its bespoke icon alive with the
// sonar aura + orbit, the exact action it's taking, and progress above. The
// immersive core of the OOBE.
function RunningCard({
  views, active, index, total, actionLine, onCancel,
}: {
  views: StepView[];
  active: StepDef;
  index: number;
  total: number;
  actionLine: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="mb-8 w-full space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold uppercase tracking-[0.14em] text-white/45">Passo {index + 1} de {total}</span>
          {/* Pauses (not tears down) a resumable run — the destructive teardown is
              the separate "Cancelar onboarding" on the paused/reboot pages. */}
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-white/15 px-2.5 py-1 font-medium text-white/60 transition-colors hover:bg-white/10 hover:text-white",
              focusRingDark,
            )}
          >
            <Pause size={12} /> Pausar
          </button>
        </div>
        <RunProgressBar views={views} />
      </div>
      <StepIcon step={active.key} state="running" size={132} />
      {/* Live region so the currently-executing step is announced as the run advances. */}
      <h1 role="status" aria-live="polite" className="mt-7 text-2xl font-semibold leading-tight text-white">{active.label}</h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-white/60">{actionLine}</p>
      <p className="mt-6 inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.06] px-3.5 py-1.5 text-xs font-medium text-white/70">
        A executar agora
        <span className="oobe-dot">.</span>
        <span className="oobe-dot" style={{ animationDelay: "0.2s" }}>.</span>
        <span className="oobe-dot" style={{ animationDelay: "0.4s" }}>.</span>
      </p>
    </div>
  );
}

// PAUSED page — the failed step, big, with its error and a retry.
function PausedCard({
  views, failed, doneCount, total, onContinue, onCancel, busy,
}: {
  views: StepView[];
  failed: StepView | null;
  doneCount: number;
  total: number;
  onContinue: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="mb-8 w-full space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold uppercase tracking-[0.14em] text-white/45">Onboarding em pausa</span>
          <span className="font-medium tabular-nums text-white/45">{doneCount}/{total}</span>
        </div>
        <RunProgressBar views={views} />
      </div>
      {failed
        ? <StepIcon step={failed.def.key} state="error" size={124} />
        : <AuraBadge tone="error" size={124}><AlertTriangle size={50} strokeWidth={1.6} /></AuraBadge>}
      <h1 className="mt-7 text-2xl font-semibold leading-tight text-white">{failed ? failed.def.label : "Um passo não terminou"}</h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-amber-200">{failed?.message ?? "Corrige o que for preciso e continua."}</p>
      <p className="mt-2 text-xs text-white/40">Os passos já concluídos não voltam a correr.</p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onContinue}
          disabled={busy}
          className={cn(
            "inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-brand shadow-lg shadow-black/20 transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100",
            focusRingDark,
          )}
        >
          <Play size={16} /> Tentar novamente
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-white/40 transition-colors hover:text-white/80",
            focusRingDark,
          )}
        >
          <X size={13} /> Cancelar onboarding
        </button>
      </div>
    </div>
  );
}

// The auto-reboot countdown as a shrinking ring around the power glyph — the
// OOBE equivalent of Windows Setup's "restarting in N seconds".
function RebootRing({ seconds, total }: { seconds: number; total: number }) {
  const r = 52;
  const circumference = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, seconds / total));
  return (
    <span className="relative inline-flex h-32 w-32 items-center justify-center">
      <svg viewBox="0 0 120 120" className="h-32 w-32 -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="5" />
        <circle
          cx="60" cy="60" r={r} fill="none"
          stroke="rgb(94,229,213)" strokeWidth="5" strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - frac)}
          style={{ transition: "stroke-dashoffset 1s linear" }}
        />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center text-white">
        <Power size={22} className="text-white/70" />
        <span className="mt-0.5 text-2xl font-semibold tabular-nums">{seconds}</span>
      </span>
    </span>
  );
}

// Compact recap of every step, shown on the reboot + done pages ("resumo").
// Glassy rows on the dark backdrop; each row carries its bespoke step glyph.
function RecapList({
  views, title, doneCount, total,
}: {
  views: StepView[];
  title: string;
  doneCount: number;
  total: number;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-white/45">{title}</p>
        <span className="text-xs font-medium tabular-nums text-white/45">{doneCount}/{total}</span>
      </div>
      <ul className="divide-y divide-white/[0.06]">
        {views.map(({ def, state }) => {
          const done = state === "done";
          const errored = state === "error";
          return (
            <li key={def.key} className="flex items-center gap-3 px-4 py-2.5">
              <StepIcon step={def.key} state={done ? "done" : errored ? "error" : "idle"} size={30} />
              <span className="flex-1 text-sm text-white/85">{def.label}</span>
              {done ? (
                <Check size={16} className="text-teal-300" />
              ) : errored ? (
                <AlertTriangle size={14} className="text-amber-300" />
              ) : (
                <span className="text-xs text-white/25">—</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StatusError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <AuraBadge tone="error" size={104}>
        <ServerCrash size={44} strokeWidth={1.7} />
      </AuraBadge>
      <h3 className="mt-6 text-lg font-semibold text-white">Não foi possível avaliar este PC</h3>
      <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-white/55">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className={cn(
          "mt-6 inline-flex items-center gap-1.5 rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-brand shadow-lg shadow-black/20 transition-transform hover:scale-[1.02]",
          focusRingDark,
        )}
      >
        <RotateCcw size={15} /> Tentar novamente
      </button>
    </div>
  );
}
