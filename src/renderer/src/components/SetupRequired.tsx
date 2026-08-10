import { useState, useEffect } from "react";
import {
  PackageX,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Terminal,
  Server,
  Copy,
  Check,
  Info,
  Loader2,
} from "lucide-react";
import StatusScreen, { type StatusAction } from "./StatusScreen";
import { adAPI, type InstallProgress } from "../adAPI";
import { cn } from "../lib/cn";

interface SetupRequiredProps {
  onRecheck: () => void;
  rechecking?: boolean;
  onContinue?: () => void;
  /** Escape hatch to the AD connection settings (e.g. RSAT missing locally but
   *  a remote AD is configured) — makes Settings reachable from the gate. */
  onOpenSettings?: () => void;
}

const PS_COMMAND =
  'Add-WindowsCapability -Online -Name "Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0"';
const SERVER_COMMAND = "Install-WindowsFeature RSAT-AD-PowerShell";

const UI_PATH = [
  "Definições",
  "Aplicações",
  "Funcionalidades opcionais",
  "Adicionar uma funcionalidade",
];

export default function SetupRequired({
  onRecheck,
  rechecking = false,
  onContinue,
  onOpenSettings,
}: SetupRequiredProps) {
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [installing, setInstalling] = useState(false);

  // Subscribe to streamed install progress; the effect returns the unsubscribe fn.
  useEffect(() => adAPI.onInstallProgress(setProgress), []);

  const runInstall = async () => {
    setProgress(null);
    setInstalling(true);
    const r = await adAPI.installModule();
    setInstalling(false);
    if (r.ok) setTimeout(onRecheck, 900);
  };

  // Shared "Verificar novamente" action (idle + error).
  const recheckAction: StatusAction = {
    label: rechecking ? "A verificar…" : "Verificar novamente",
    onClick: onRecheck,
    loading: rechecking,
    variant: "ghost",
  };
  const continueAction: StatusAction | null = onContinue
    ? { label: "Continuar mesmo assim", onClick: onContinue, variant: "ghost" }
    : null;
  const settingsAction: StatusAction | null = onOpenSettings
    ? { label: "Abrir definições", onClick: onOpenSettings, variant: "ghost" }
    : null;

  // --- State machine (order matters: done > error > installing > idle) ---
  const isDone = progress?.state === "done";
  const isError = progress?.state === "error";
  const isInstalling =
    !isDone && !isError && (installing || progress?.state === "installing");

  // ---------- INSTALLING ----------
  if (isInstalling) {
    const percent = progress?.state === "installing" ? progress.percent : 0;
    const label =
      (progress?.state === "installing" ? progress.message : undefined) ??
      "A instalar…";
    return (
      <StatusScreen
        tone="brand"
        eyebrow="AD Manager"
        badge={<Loader2 size={28} className="animate-spin" />}
        title="A instalar componentes…"
        subtitle="Isto pode demorar alguns minutos. Podes deixar a janela aberta — não é preciso fazer mais nada."
        progress={{ percent, label }}
        // Never a hard trap: allow leaving to the app while the install runs.
        actions={continueAction ? [continueAction] : undefined}
      >
        <p className="flex max-w-[52ch] items-start gap-2 text-xs leading-relaxed text-zinc-400">
          <Info size={14} className="mt-px shrink-0" />
          Vai transferir e instalar via Windows Update. Não feches a aplicação
          enquanto a instalação decorre.
        </p>
      </StatusScreen>
    );
  }

  // ---------- DONE ----------
  if (isDone) {
    const rebootRequired =
      progress?.state === "done" && progress.rebootRequired;
    return (
      <StatusScreen
        tone="success"
        eyebrow="AD Manager"
        badge={<CheckCircle2 size={30} strokeWidth={2.2} />}
        title="Componente instalado!"
        subtitle={
          rebootRequired
            ? "Reinicia o Windows para concluir a instalação."
            : "Tudo pronto — o módulo Active Directory está disponível."
        }
        progress={{ percent: 100, label: "Concluído" }}
      >
        <p className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 size={15} className="animate-spin" />
          A continuar…
        </p>
      </StatusScreen>
    );
  }

  // ---------- ERROR ----------
  if (isError) {
    const message =
      progress?.state === "error"
        ? progress.message
        : "Ocorreu um erro inesperado durante a instalação.";
    const actions: StatusAction[] = [
      { label: "Tentar novamente", onClick: runInstall, variant: "primary" },
      recheckAction,
      ...(settingsAction ? [settingsAction] : []),
      ...(continueAction ? [continueAction] : []),
    ];
    return (
      <StatusScreen
        tone="error"
        eyebrow="AD Manager"
        badge={<AlertTriangle size={28} strokeWidth={2} />}
        title="Não foi possível instalar automaticamente"
        subtitle={message}
        actions={actions}
      >
        <ManualSection title="Instalar manualmente" />
      </StatusScreen>
    );
  }

  // ---------- IDLE ----------
  const idleActions: StatusAction[] = [
    { label: "Instalar automaticamente", onClick: runInstall, variant: "primary" },
    recheckAction,
    ...(settingsAction ? [settingsAction] : []),
    ...(continueAction ? [continueAction] : []),
  ];
  return (
    <StatusScreen
      tone="brand"
      eyebrow="AD Manager"
      badge={<PackageX size={28} strokeWidth={2} />}
      title="Faltam componentes necessários"
      subtitle={
        <>
          Falta o módulo{" "}
          <span className="font-medium text-zinc-700">
            Active Directory (RSAT)
          </span>{" "}
          do Windows. Sem ele, o AD Manager não consegue comunicar com o Active
          Directory.
        </>
      }
      actions={idleActions}
    >
      <p className="mb-6 flex items-start gap-2 text-xs leading-relaxed text-zinc-400">
        <Info size={14} className="mt-px shrink-0" />
        Transfere e instala via Windows Update (~alguns minutos).
      </p>
      <ManualSection title="Preferes instalar manualmente?" />
    </StatusScreen>
  );
}

/* -------------------------------------------------------------------------- */

type Method = "windows" | "powershell";

function ManualSection({ title }: { title: string }) {
  const [method, setMethod] = useState<Method>("windows");
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(PS_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* área de transferência indisponível — ignorar silenciosamente */
    }
  };

  const segments: { id: Method; label: string }[] = [
    { id: "windows", label: "Windows (interface)" },
    { id: "powershell", label: "PowerShell" },
  ];

  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-5 text-left">
      <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>

      {/* Segmented switch — shows one method at a time */}
      <div className="mt-3 inline-flex rounded-lg bg-zinc-100 p-0.5">
        {segments.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setMethod(id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              method === id
                ? "bg-white text-zinc-900 shadow-sm"
                : "text-zinc-500 hover:text-zinc-700",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {method === "windows" ? (
        <div className="mt-4">
          <p className="text-sm text-zinc-500">
            Abre as Definições do Windows e segue este caminho:
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {UI_PATH.map((step, i) => (
              <span key={step} className="flex items-center gap-1.5">
                <span className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-600">
                  {step}
                </span>
                {i < UI_PATH.length - 1 && (
                  <ArrowRight size={13} className="text-zinc-300" />
                )}
              </span>
            ))}
          </div>
          <p className="mt-3 text-sm leading-relaxed text-zinc-500">
            Procura e instala{" "}
            <span className="font-medium text-zinc-700">
              “RSAT: Ferramentas dos Serviços de Domínio Active Directory e dos
              Serviços de Diretório Lightweight”
            </span>
            .
          </p>
        </div>
      ) : (
        <div className="mt-4">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
            <Terminal size={15} className="text-zinc-400" />
            PowerShell{" "}
            <span className="font-normal text-zinc-400">(como administrador)</span>
          </div>
          <p className="mt-1.5 text-sm text-zinc-500">Executa o comando:</p>

          <div className="mt-2.5 flex items-stretch gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded-md border border-zinc-200 bg-white px-3 py-2.5 font-mono text-xs leading-relaxed text-zinc-700 sm:text-sm">
              {PS_COMMAND}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copiar comando"
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 self-start rounded-md border px-2.5 py-2 text-xs font-medium transition-colors",
                copied
                  ? "border-zinc-200 bg-white text-zinc-700"
                  : "border-zinc-200 bg-white text-zinc-500 hover:text-zinc-700",
              )}
            >
              {copied ? (
                <>
                  <Check size={14} strokeWidth={2.4} style={{ color: "#1fd1bd" }} />
                  Copiado!
                </>
              ) : (
                <>
                  <Copy size={14} />
                  Copiar
                </>
              )}
            </button>
          </div>

          <div className="mt-2.5 flex items-start gap-2 text-xs text-zinc-400">
            <Server size={14} className="mt-px shrink-0" />
            <span className="leading-relaxed">
              No Windows Server, usa antes{" "}
              <code className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 font-mono text-[0.72rem] text-zinc-500">
                {SERVER_COMMAND}
              </code>
              .
            </span>
          </div>
        </div>
      )}

      <p className="mt-4 text-xs leading-relaxed text-zinc-400">
        Depois de instalar, clica em{" "}
        <span className="font-medium text-zinc-600">“Verificar novamente”</span>.
      </p>
    </div>
  );
}
