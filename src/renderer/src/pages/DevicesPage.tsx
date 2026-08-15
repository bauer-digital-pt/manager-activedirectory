import type { ExternalToast } from "sonner";
import { IS_AGENT } from "../lib/flavor";
import PcOnboardingWizard from "./PcOnboardingWizard";
import DeviceListPage from "./DeviceListPage";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

// The "Devices" tab means two different things per installer:
//  • Agent  → the local-machine onboarding wizard (PcOnboardingWizard), the whole
//    reason the Agent exists. Drives REAL, irreversible PowerShell on this PC.
//  • Manager → a read-only fleet list of every AD computer object (DeviceListPage),
//    with a per-device detail view. Never writes to AD.
// Kept as one component so App.tsx's routing (Page id "devices", hotkey 2,
// HOME_PAGE, AgentShell sizing) is flavor-agnostic.
export default function DevicesPage(props: {
  toast: { success: ToastFn; error: ToastFn };
  /** Agent wizard "Abrir Definições" → the "Dispositivos" tab (shared with the Manager list). */
  onOpenDeviceSettings?: () => void;
  /** Manager device-list error recovery → the "AD Connection" tab (AD read failed). */
  onOpenConnectionSettings?: () => void;
  /** Manager device-list error recovery → the "Inventário" tab (inventory-API source failed). */
  onOpenInventorySettings?: () => void;
}) {
  return IS_AGENT ? <PcOnboardingWizard {...props} /> : <DeviceListPage {...props} />;
}
