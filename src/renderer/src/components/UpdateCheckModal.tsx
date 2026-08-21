import { useEffect, useRef, useState, useId } from "react";
import { Loader2, Sparkles, CheckCircle2, Download, AlertTriangle, X } from "lucide-react";
import { updatesAPI, type UpdateStatus } from "../lib/updates";
import { Button } from "./ui/Button";
import { useFocusTrap } from "../hooks/useFocusTrap";

// Small modal that owns the MANUAL "check for updates" flow from General
// settings. While it's open the parent suppresses the full-screen update
// takeover (see App), so the result stays inside this modal. It subscribes to
// the updater status stream and drives check → download → install.
type Phase =
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "available"; version?: string }
  | { kind: "downloading"; percent: number }
  | { kind: "downloaded"; version?: string }
  | { kind: "error"; message: string }
  | { kind: "unavailable" };

export default function UpdateCheckModal({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const titleId = useId();
  const primaryRef = useRef<HTMLButtonElement>(null);
  // The modal is always live while mounted (the parent conditionally renders it),
  // so trap focus + wire Escape → close. Focus the phase's primary action button
  // (Transferir / Reiniciar) on open and let Enter trigger it, so Enter doesn't
  // land on the header ✕ and merely close the dialog.
  const trapRef = useFocusTrap<HTMLDivElement>(true, {
    onEscape: onClose,
    onEnter: () => {
      if (phase.kind === "available") download();
      else if (phase.kind === "downloaded") updatesAPI.install();
    },
    initialFocus: primaryRef,
  });

  useEffect(() => {
    let done = false;

    const off = updatesAPI.onStatus((s: UpdateStatus) => {
      if (done && s.state === "none") return; // ignore a late "none" after resolution
      switch (s.state) {
        case "available":    setPhase({ kind: "available", version: s.version }); break;
        case "downloading":  setPhase({ kind: "downloading", percent: s.percent ?? 0 }); break;
        case "downloaded":   setPhase({ kind: "downloaded", version: s.version }); done = true; break;
        case "none":         setPhase({ kind: "none" }); break;
        case "error":        setPhase({ kind: "error", message: s.message ?? "Erro desconhecido." }); break;
      }
    });

    updatesAPI.check().then((r) => {
      // In the browser preview / non-packaged app the updater is unavailable.
      if (!r.ok && r.error === "unavailable") setPhase({ kind: "unavailable" });
      else if (!r.ok && r.error) setPhase({ kind: "error", message: r.error });
      // Otherwise the onStatus stream reports available/none/error.
    });

    return () => { done = true; off(); };
  }, []);

  const download = async () => {
    setPhase({ kind: "downloading", percent: 0 });
    const r = await updatesAPI.download();
    if (!r.ok) setPhase({ kind: "error", message: r.error ?? "Falha ao transferir." });
  };

  return (
    <div className="anim-overlay fixed inset-0 z-30 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="anim-modal w-full max-w-md rounded-2xl bg-white shadow-xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3.5">
          <h3 id={titleId} className="text-sm font-semibold text-zinc-900">Atualizações</h3>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Fechar"
            className="p-1 text-zinc-400 hover:text-zinc-700"
          >
            <X size={16} />
          </Button>
        </div>

        <div className="px-5 py-6">
          <Body phase={phase} onDownload={download} onInstall={() => updatesAPI.install()} primaryRef={primaryRef} />
        </div>
      </div>
    </div>
  );
}

function Body({
  phase,
  onDownload,
  onInstall,
  primaryRef,
}: {
  phase: Phase;
  onDownload: () => void;
  onInstall: () => void;
  primaryRef: React.RefObject<HTMLButtonElement>;
}) {
  switch (phase.kind) {
    case "checking":
      return (
        <Row icon={<Loader2 size={22} className="animate-spin text-brand" />} title="A procurar atualizações…" />
      );
    case "none":
      return (
        <Row icon={<CheckCircle2 size={22} className="text-emerald-500" />} title="Estás na versão mais recente" subtitle="Não há nada para atualizar." />
      );
    case "unavailable":
      return (
        <Row icon={<AlertTriangle size={22} className="text-amber-500" />} title="Indisponível aqui" subtitle="A procura de atualizações só funciona na aplicação instalada." />
      );
    case "available":
      return (
        <div className="space-y-4">
          <Row icon={<Sparkles size={22} className="text-brand" />} title="Nova versão disponível" subtitle={phase.version ? `Versão ${phase.version}` : undefined} />
          <Button ref={primaryRef} size="lg" onClick={onDownload} className="w-full">
            <Download size={15} /> Transferir atualização
          </Button>
        </div>
      );
    case "downloading":
      return (
        <div className="space-y-4">
          <Row icon={<Download size={22} className="text-brand" />} title="A transferir…" />
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-100">
            <div className="h-full rounded-full bg-brand transition-all duration-300" style={{ width: `${phase.percent}%` }} />
          </div>
          <p className="text-right font-mono text-xs tabular-nums text-zinc-500">{phase.percent}%</p>
        </div>
      );
    case "downloaded":
      return (
        <div className="space-y-4">
          <Row icon={<CheckCircle2 size={22} className="text-emerald-500" />} title="Atualização pronta" subtitle={phase.version ? `Versão ${phase.version} — reinicia para aplicar.` : "Reinicia para aplicar."} />
          <Button ref={primaryRef} size="lg" onClick={onInstall} className="w-full">
            Reiniciar e instalar
          </Button>
        </div>
      );
    case "error":
      return (
        <Row icon={<AlertTriangle size={22} className="text-red-500" />} title="Falha ao procurar atualizações" subtitle={phase.message} />
      );
  }
}

function Row({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex-shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-900">{title}</p>
        {subtitle && <p className="mt-0.5 text-sm text-zinc-500">{subtitle}</p>}
      </div>
    </div>
  );
}
