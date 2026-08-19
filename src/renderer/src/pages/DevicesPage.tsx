import type { ExternalToast } from "sonner";
import { IS_AGENT } from "../lib/flavor";
import PcOnboardingWizard from "./PcOnboardingWizard";
import DeviceListPage from "./DeviceListPage";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

// The "Devices" tab means two different things per installer:
//  • Agent  → the local-machine onboarding wizard (PcOnboardingWizard), the whole
//    reason the Agent exists. Drives REAL, irreversible PowerShell on this PC.
//  • Manager → a single, consolidated + enriched fleet list (DeviceListPage): the
//    union of every AD computer object and every EZOffice asset (peripherals
//    included), joined by name, with a rich per-device detail view. Reversible AD
//    writes (enable/disable) are gated behind a re-auth; everything else is read.
// Kept as one component so App.tsx's routing (Page id "devices", hotkey 2,
// HOME_PAGE, AgentShell sizing) is flavor-agnostic.
export default function DevicesPage(props: {
  toast: { success: ToastFn; error: ToastFn };
  /** Manager only — kiosk mode auto-refreshes the fleet list; ignored by the Agent wizard. */
  kiosk?: boolean;
  /** Threaded to the list → each row, to gate the enable/disable write behind a re-auth. */
  ensureFreshAuth?: () => Promise<boolean>;
  /** Agent wizard "Abrir Definições" → the "Dispositivos" tab (shared with the Manager list). */
  onOpenDeviceSettings?: () => void;
  /** Manager device-list error recovery → the "Conexões" tab (AD read failed). */
  onOpenConnectionSettings?: () => void;
  /** Manager device-list error recovery → the "Conexões" tab (inventory-API source failed). */
  onOpenInventorySettings?: () => void;
  /** Open the reconciliation dashboard (InventoryPage). */
  onOpenReconciliation?: () => void;
}) {
  if (IS_AGENT) return <PcOnboardingWizard {...props} />;

  return (
    <DeviceListPage
      toast={props.toast}
      kiosk={props.kiosk}
      ensureFreshAuth={props.ensureFreshAuth}
      onOpenConnectionSettings={props.onOpenConnectionSettings}
      onOpenInventorySettings={props.onOpenInventorySettings}
      onOpenReconciliation={props.onOpenReconciliation}
    />
  );
}
