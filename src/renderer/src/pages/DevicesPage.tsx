import { useState, useEffect, useCallback, useRef } from "react";
import {
  Laptop, RefreshCw, Check, AlertTriangle, ServerCrash, Loader2, Play,
  RotateCcw, CheckCircle2, Languages, DownloadCloud, ShieldCheck, Monitor, Network,
} from "lucide-react";
import type { ExternalToast } from "sonner";
import { adAPI, type PCStatus, type OnboardStep } from "../adAPI";
import { cn } from "../lib/cn";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

// UNC installer sources live on the NAS (\\pt-srv-nas\<pasta>\<instalador>).
// They rarely change, so remember them locally between visits — pre-filled with
// the current known locations so the operator normally doesn't touch them.
const LS_ANY = "admanager.onboard.anyConnectSource";
const LS_SCR = "admanager.onboard.screenConnectSource";
const NAS_HINT = "\\\\pt-srv-nas\\";
const DEFAULT_ANYCONNECT = "\\\\pt-srv-nas\\IT\\Software\\Cisco Anyconnect\\anyconnect-win-4.10.08029-core-vpn-webdeploy-k9.msi";
const DEFAULT_SCREENCONNECT = "\\\\pt-srv-nas\\IT\\Software\\ScreenConnect\\ScreenConnect.ClientSetup.msi";

interface StepDef {
  key: OnboardStep;
  label: string;
  desc: string;
  icon: React.ElementType;
  needsName?: boolean;
  needsSource?: "anyConnect" | "screenConnect";
}

// Execution order for "Executar tudo": regional + update + installs first, then
// the domain join/rename last because it forces a reboot.
const STEPS: StepDef[] = [
  { key: "regional",      label: "Definições regionais", desc: "SO em inglês, região Portugal, teclado português", icon: Languages },
  { key: "update",        label: "Windows Update",       desc: "Instalar todas as atualizações pendentes",         icon: DownloadCloud },
  { key: "anyconnect",    label: "Cisco AnyConnect",     desc: "Instalação silenciosa a partir do NAS",            icon: ShieldCheck,  needsSource: "anyConnect" },
  { key: "screenconnect", label: "ScreenConnect",        desc: "Instalação silenciosa a partir do NAS",            icon: Monitor,      needsSource: "screenConnect" },
  { key: "domain",        label: "Domínio + nome do PC", desc: "Juntar a bmap.lis e renomear (requer reinício)",   icon: Network,      needsName: true },
];

type StepState = { state: "idle" | "running" | "done" | "error"; message?: string };

// Whether a dimension is already satisfied on the live machine.
function stepDone(status: PCStatus | null, key: OnboardStep): boolean {
  if (!status) return false;
  switch (key) {
    case "regional":      return status.regional.compliant;
    case "update":        return status.windowsUpdate.upToDate;
    case "anyconnect":    return status.software.anyConnect;
    case "screenconnect": return status.software.screenConnect;
    case "domain":        return status.domain.compliant && status.name.compliant;
  }
}

export default function DevicesPage({
  toast,
}: {
  toast: { success: ToastFn; error: ToastFn };
}) {
  const [status, setStatus] = useState<PCStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Target name config (PT-LPT-<DEPT>-<NUMBER>).
  const [dept, setDept] = useState("");
  const [num, setNum] = useState("");

  // Installer UNC sources, remembered locally.
  const [anyConnectSource, setAnyConnectSource] = useState(() => localStorage.getItem(LS_ANY) ?? DEFAULT_ANYCONNECT);
  const [screenConnectSource, setScreenConnectSource] = useState(() => localStorage.getItem(LS_SCR) ?? DEFAULT_SCREENCONNECT);
  useEffect(() => { localStorage.setItem(LS_ANY, anyConnectSource); }, [anyConnectSource]);
  useEffect(() => { localStorage.setItem(LS_SCR, screenConnectSource); }, [screenConnectSource]);

  const [results, setResults] = useState<Record<string, StepState>>({});
  const [runningAll, setRunningAll] = useState(false);
  const [rebootNeeded, setRebootNeeded] = useState(false);

  const toastRef = useRef(toast);
  toastRef.current = toast;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adAPI.getPCStatus();
      if (r.ok && r.data) {
        setStatus(r.data);
        // Default the department dropdown to the first known code once.
        setDept((d) => d || r.data!.departments[0] || "");
      } else {
        setError(r.error ?? "Não foi possível obter o estado deste PC.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível obter o estado deste PC.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const departments = status?.departments ?? [];
  const numClean = num.replace(/\D/g, "");
  const nameValid = !!dept && /^\d+$/.test(numClean);
  const newName = nameValid ? `PT-LPT-${dept}-${numClean}` : "";

  // A step is runnable only when its prerequisites are met.
  const canRunStep = useCallback(
    (key: OnboardStep): boolean => {
      if (key === "domain") return nameValid;
      if (key === "anyconnect") return anyConnectSource.trim().length > 0 && anyConnectSource.trim() !== NAS_HINT;
      if (key === "screenconnect") return screenConnectSource.trim().length > 0 && screenConnectSource.trim() !== NAS_HINT;
      return true;
    },
    [nameValid, anyConnectSource, screenConnectSource]
  );

  const busy = runningAll || Object.values(results).some((r) => r.state === "running");

  // Runs a single step and refreshes the machine status afterwards. Returns
  // false if it failed (so "run all" can stop the chain).
  const runStep = useCallback(
    async (key: OnboardStep): Promise<boolean> => {
      setResults((r) => ({ ...r, [key]: { state: "running" } }));
      try {
        const res = await adAPI.onboardStep({
          step: key,
          newName: key === "domain" ? newName : undefined,
          anyConnectSource: anyConnectSource.trim(),
          screenConnectSource: screenConnectSource.trim(),
        });
        if (res.ok) {
          const msg = res.data?.message ?? "Concluído.";
          setResults((r) => ({ ...r, [key]: { state: "done", message: msg } }));
          if (res.data?.rebootRequired) setRebootNeeded(true);
          toastRef.current.success(msg);
          return true;
        }
        const err = res.error ?? "Falhou.";
        setResults((r) => ({ ...r, [key]: { state: "error", message: err } }));
        toastRef.current.error(err);
        return false;
      } catch (e) {
        const err = e instanceof Error ? e.message : "Falhou.";
        setResults((r) => ({ ...r, [key]: { state: "error", message: err } }));
        toastRef.current.error(err);
        return false;
      }
    },
    [newName, anyConnectSource, screenConnectSource]
  );

  const runOne = useCallback(
    async (key: OnboardStep) => {
      if (busy) return;
      await runStep(key);
      // Re-read the live state so the checklist reflects reality.
      const r = await adAPI.getPCStatus();
      if (r.ok && r.data) setStatus(r.data);
    },
    [busy, runStep]
  );

  const pending = STEPS.filter((s) => !stepDone(status, s.key));
  const missingPrereqs = pending.filter((s) => !canRunStep(s.key));

  const runAll = useCallback(async () => {
    if (busy || pending.length === 0 || missingPrereqs.length > 0) return;
    setRunningAll(true);
    try {
      for (const s of pending) {
        const ok = await runStep(s.key);
        if (!ok) break; // stop the chain on the first failure
      }
    } finally {
      setRunningAll(false);
      const r = await adAPI.getPCStatus();
      if (r.ok && r.data) setStatus(r.data);
    }
  }, [busy, pending, missingPrereqs.length, runStep]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-zinc-200 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-50 text-violet-600">
            <Laptop size={17} />
          </div>
          <div>
            <h2 className="text-base font-semibold text-zinc-900">Onboarding do PC</h2>
            <p className="text-xs text-zinc-400">Este computador (a sessão atual)</p>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading || busy}
          title="Reavaliar este PC"
          className="inline-flex items-center justify-center p-1.5 text-zinc-500 bg-zinc-50 border border-zinc-200 rounded-md hover:bg-zinc-100 hover:text-zinc-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw size={14} className={cn((loading || busy) && "animate-spin")} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading ? (
          <div className="space-y-3 max-w-3xl">
            <div className="h-20 bg-zinc-50 rounded-xl animate-pulse" />
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-16 bg-zinc-50 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <StatusError message={error} onRetry={load} />
        ) : status ? (
          <div className="max-w-3xl space-y-5">
            {/* Machine identity + verdict */}
            <div className="rounded-xl border border-zinc-200 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-zinc-900 truncate">{status.hostname}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {status.domain.joined
                      ? <>No domínio <span className="font-medium text-zinc-700">{status.domain.name}</span></>
                      : "Fora do domínio"}
                  </p>
                </div>
                {status.onboarded ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                    <CheckCircle2 size={13} /> Já onboarded
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
                    <AlertTriangle size={13} /> Por onboarding
                  </span>
                )}
              </div>
              {status.onboarded && (
                <p className="mt-3 text-xs leading-relaxed text-zinc-500">
                  Este PC cumpre todos os requisitos de onboarding. Não há nada a fazer — o resumo
                  abaixo confirma cada verificação.
                </p>
              )}
            </div>

            {/* Configuration (only relevant while there's still work to do) */}
            {!status.onboarded && (
              <div className="rounded-xl border border-zinc-200 p-4 space-y-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Configuração</p>

                {/* Target name */}
                <div>
                  <label className="text-sm font-medium text-zinc-700">Nome do PC</label>
                  <p className="text-xs text-zinc-400 mb-2">Padrão PT-LPT-&lt;DEPARTAMENTO&gt;-&lt;NÚMERO&gt;</p>
                  <div className="flex items-center gap-2">
                    <select
                      value={dept}
                      onChange={(e) => setDept(e.target.value)}
                      className="px-3 py-1.5 text-sm bg-zinc-50 border border-zinc-200 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400"
                    >
                      {departments.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                    <input
                      inputMode="numeric"
                      placeholder="Nº"
                      value={numClean}
                      onChange={(e) => setNum(e.target.value)}
                      className="w-20 px-3 py-1.5 text-sm bg-zinc-50 border border-zinc-200 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400"
                    />
                    <span className="text-sm text-zinc-400">→</span>
                    <code className={cn(
                      "px-2.5 py-1.5 text-sm rounded-md font-mono",
                      nameValid ? "bg-violet-50 text-violet-700" : "bg-zinc-100 text-zinc-400"
                    )}>
                      {newName || "PT-LPT-…"}
                    </code>
                  </div>
                </div>

                {/* Installer sources */}
                <div className="grid gap-3 sm:grid-cols-2">
                  <SourceField
                    label="Instalador AnyConnect"
                    value={anyConnectSource}
                    onChange={setAnyConnectSource}
                  />
                  <SourceField
                    label="Instalador ScreenConnect"
                    value={screenConnectSource}
                    onChange={setScreenConnectSource}
                  />
                </div>
              </div>
            )}

            {/* Checklist / summary */}
            <div className="rounded-xl border border-zinc-200 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  {status.onboarded ? "Resumo" : "Passos"}
                </p>
                {!status.onboarded && (
                  <button
                    onClick={runAll}
                    disabled={busy || pending.length === 0 || missingPrereqs.length > 0}
                    title={
                      missingPrereqs.length > 0
                        ? `Em falta: ${missingPrereqs.map((s) => s.label).join(", ")}`
                        : undefined
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-violet-600 text-white rounded-md hover:bg-violet-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-violet-600"
                  >
                    {runningAll ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                    Executar tudo
                  </button>
                )}
              </div>
              <ul className="divide-y divide-zinc-50">
                {STEPS.map((s) => (
                  <StepRow
                    key={s.key}
                    def={s}
                    done={stepDone(status, s.key)}
                    detail={stepDetail(status, s.key, newName)}
                    result={results[s.key]}
                    canRun={canRunStep(s.key)}
                    busy={busy}
                    onboarded={status.onboarded}
                    onRun={() => runOne(s.key)}
                  />
                ))}
              </ul>
            </div>

            {rebootNeeded && (
              <div className="flex items-start gap-2.5 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                <span>
                  Um ou mais passos exigem <strong>reinício</strong> para ficarem totalmente aplicados
                  (definições regionais e/ou a junção ao domínio). Reinicia o PC quando terminares.
                </span>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

// A one-line description of the current state of a dimension, shown under its label.
function stepDetail(status: PCStatus, key: OnboardStep, targetName: string): string {
  switch (key) {
    case "regional": {
      const r = status.regional;
      return `SO: ${r.osLanguage || "?"} · região: ${r.geo || r.geoId} · teclado: ${r.keyboard || "?"}`;
    }
    case "update":
      if (!status.windowsUpdate.checked) return "Não foi possível verificar o Windows Update";
      return status.windowsUpdate.upToDate
        ? "Sem atualizações pendentes"
        : `${status.windowsUpdate.pending} atualização(ões) pendente(s)`;
    case "anyconnect":
      return status.software.anyConnect ? "Instalado" : "Não instalado";
    case "screenconnect":
      return status.software.screenConnect ? "Instalado" : "Não instalado";
    case "domain": {
      const okDomain = status.domain.compliant;
      const okName = status.name.compliant;
      if (okDomain && okName) return `${status.hostname} · ${status.domain.name}`;
      const parts: string[] = [];
      parts.push(okDomain ? `no domínio ${status.domain.name}` : "fora do domínio bmap.lis");
      parts.push(okName ? "nome conforme" : targetName ? `renomear → ${targetName}` : "nome não conforme");
      return parts.join(" · ");
    }
  }
}

function StepRow({
  def, done, detail, result, canRun, busy, onboarded, onRun,
}: {
  def: StepDef;
  done: boolean;
  detail: string;
  result?: StepState;
  canRun: boolean;
  busy: boolean;
  onboarded: boolean;
  onRun: () => void;
}) {
  const Icon = def.icon;
  const running = result?.state === "running";
  const errored = result?.state === "error";
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className={cn(
        "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg",
        done ? "bg-emerald-50 text-emerald-600" : errored ? "bg-red-50 text-red-500" : "bg-zinc-100 text-zinc-500"
      )}>
        {done ? <Check size={16} /> : <Icon size={16} />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-zinc-800">{def.label}</p>
        <p className={cn("text-xs truncate", errored ? "text-red-500" : "text-zinc-400")}>
          {errored ? result?.message : done ? detail : def.desc}
        </p>
      </div>
      <div className="flex-shrink-0">
        {done ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
            <Check size={13} /> Concluído
          </span>
        ) : onboarded ? null : running ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-violet-600">
            <Loader2 size={13} className="animate-spin" /> A executar…
          </span>
        ) : (
          <button
            onClick={onRun}
            disabled={busy || !canRun}
            title={canRun ? undefined : "Preenche a configuração necessária primeiro"}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              errored
                ? "border-red-200 text-red-600 hover:bg-red-50"
                : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 hover:text-zinc-800"
            )}
          >
            {errored ? <RotateCcw size={12} /> : <Play size={12} />}
            {errored ? "Tentar de novo" : "Executar"}
          </button>
        )}
      </div>
    </li>
  );
}

function SourceField({
  label, value, onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-zinc-700">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`${NAS_HINT}pasta\\instalador.msi`}
        spellCheck={false}
        className="mt-1 w-full px-3 py-1.5 text-sm font-mono bg-zinc-50 border border-zinc-200 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400"
      />
    </label>
  );
}

function StatusError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 ring-1 ring-amber-200/70">
        <ServerCrash size={26} strokeWidth={2} />
      </div>
      <h3 className="mt-5 text-base font-semibold text-zinc-900">Não foi possível avaliar este PC</h3>
      <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-zinc-500">{message}</p>
      <button
        onClick={onRetry}
        className="mt-6 inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700"
      >
        <RotateCcw size={15} /> Tentar novamente
      </button>
    </div>
  );
}
