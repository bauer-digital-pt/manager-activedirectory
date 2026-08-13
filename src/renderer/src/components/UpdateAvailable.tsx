import { Sparkles, Download, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";
import StatusScreen, { type StatusAction } from "./StatusScreen";
import { type UpdateStatus } from "../lib/updates";
import { FLAVOR_UI } from "../lib/flavor";

interface UpdateAvailableProps {
  status: UpdateStatus;
  onInstall: () => void;
  onDismiss: () => void;
}

const EYEBROW = FLAVOR_UI.eyebrow;

export default function UpdateAvailable({
  status,
  onInstall,
  onDismiss,
}: UpdateAvailableProps) {
  if (status.state === "none") return null;

  const laterAction: StatusAction = {
    label: "Instalar mais tarde",
    onClick: onDismiss,
    variant: "ghost",
  };

  switch (status.state) {
    case "available":
      return (
        <StatusScreen
          tone="brand"
          eyebrow={EYEBROW}
          badge={<Sparkles size={28} strokeWidth={2} />}
          title="Nova versão disponível"
          subtitle={
            status.version ? "Versão " + status.version : "A obter a atualização…"
          }
          progress={{ percent: 0, label: "A iniciar transferência…" }}
          actions={[laterAction]}
        />
      );

    case "downloading":
      return (
        <StatusScreen
          tone="brand"
          eyebrow={EYEBROW}
          badge={<Download size={28} strokeWidth={2} />}
          title="A transferir atualização"
          subtitle="Podes continuar a usar a app — avisamos-te quando estiver pronta."
          progress={{ percent: status.percent ?? 0, label: "A transferir…" }}
          actions={[laterAction]}
        />
      );

    case "downloaded":
      return (
        <StatusScreen
          tone="success"
          eyebrow={EYEBROW}
          badge={<CheckCircle2 size={30} strokeWidth={2.2} />}
          title="Atualização pronta"
          subtitle={
            status.version
              ? "Versão " + status.version + " — reinicia para aplicar."
              : "Reinicia para aplicar."
          }
          actions={[
            { label: "Reiniciar e instalar", variant: "primary", onClick: onInstall },
            { label: "Mais tarde", variant: "ghost", onClick: onDismiss },
          ]}
        />
      );

    case "installing":
      // Non-dismissible: the app will quit + relaunch on its own once the silent
      // installer finishes. No actions, indeterminate bar (unknown duration).
      return (
        <StatusScreen
          tone="brand"
          eyebrow={EYEBROW}
          badge={<RefreshCw size={26} strokeWidth={2} className="animate-spin" />}
          title="A instalar a atualização"
          subtitle={
            (status.version ? "Versão " + status.version + ". " : "") +
            "A app vai fechar e reabrir sozinha — não é preciso fazer nada."
          }
          progress={{ percent: 100, label: "A aplicar…", indeterminate: true }}
        />
      );

    case "error":
      return (
        <StatusScreen
          tone="error"
          eyebrow={EYEBROW}
          badge={<AlertTriangle size={28} strokeWidth={2} />}
          title="Falha ao atualizar"
          subtitle={status.message ?? "Não foi possível transferir a atualização."}
          actions={[{ label: "Continuar", variant: "ghost", onClick: onDismiss }]}
        />
      );

    default:
      return null;
  }
}
