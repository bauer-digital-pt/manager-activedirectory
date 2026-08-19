import { Wifi, WifiOff, Info } from "lucide-react";
import StatusScreen, { type StatusAction } from "./StatusScreen";
import { FLAVOR_UI } from "../lib/flavor";
import { EXPECTED_SSID } from "../lib/wifi";

interface WifiGateProps {
  /** The wrong network the machine is currently associated with (for display). */
  ssid: string | null;
  onRecheck: () => void;
  rechecking?: boolean;
}

// Full-screen pre-login gate: the machine is on a Wi-Fi network that is NOT the
// office one. Shown before the login form so nobody signs in over the wrong
// network. Recovery is entirely in the user's hands (switch Wi-Fi, then
// re-check) — there is no "continue anyway", by design.
export default function WifiGate({ ssid, onRecheck, rechecking = false }: WifiGateProps) {
  const recheckAction: StatusAction = {
    label: rechecking ? "A verificar…" : "Verificar novamente",
    onClick: onRecheck,
    loading: rechecking,
    variant: "primary",
  };

  return (
    <StatusScreen
      tone="error"
      eyebrow={FLAVOR_UI.eyebrow}
      badge={<WifiOff size={28} strokeWidth={2} />}
      title="Rede Wi-Fi incorreta"
      subtitle={
        <>
          Estás ligado a{" "}
          <span className="font-medium text-white">{ssid || "outra rede"}</span>. Para
          usar a aplicação, liga-te à rede{" "}
          <span className="font-medium text-white">{EXPECTED_SSID}</span> e verifica
          novamente.
        </>
      }
      actions={[recheckAction]}
    >
      <div className="flex flex-col gap-3">
        <p className="flex items-center gap-2 text-sm text-white/70">
          <Wifi size={15} className="shrink-0" />
          Rede necessária:{" "}
          <span className="font-medium text-white">{EXPECTED_SSID}</span>
        </p>
        <p className="flex max-w-[52ch] items-start gap-2 text-xs leading-relaxed text-white/55">
          <Info size={14} className="mt-px shrink-0" />
          Abre as definições de Wi-Fi do Windows, seleciona a rede{" "}
          <span className="font-medium text-white/75">{EXPECTED_SSID}</span> e depois
          clica em “Verificar novamente”.
        </p>
      </div>
    </StatusScreen>
  );
}
