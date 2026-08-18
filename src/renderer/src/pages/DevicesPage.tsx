import type { ExternalToast } from "sonner";
import { IS_AGENT } from "../lib/flavor";
import type { DeviceView } from "../App";
import PcOnboardingWizard from "./PcOnboardingWizard";
import DeviceListPage from "./DeviceListPage";
import EZOfficePage from "./EZOfficePage";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

// The "Devices" tab means two different things per installer:
//  • Agent  → the local-machine onboarding wizard (PcOnboardingWizard), the whole
//    reason the Agent exists. Drives REAL, irreversible PowerShell on this PC.
//  • Manager → a read-only fleet list of every AD computer object (DeviceListPage),
//    with a per-device detail view. Never writes to AD. Behind a single sidebar
//    item it fans out into three views (see DeviceView).
// Kept as one component so App.tsx's routing (Page id "devices", hotkey 2,
// HOME_PAGE, AgentShell sizing) is flavor-agnostic.
export default function DevicesPage(props: {
  toast: { success: ToastFn; error: ToastFn };
  /** Manager only — kiosk mode auto-refreshes the fleet list; ignored by the Agent wizard. */
  kiosk?: boolean;
  /** Which Manager device sub-view to render (AD / EZOffice / Consolidados). */
  view?: DeviceView;
  /** Switch the active sub-view from the in-page header tabs. */
  onNavigateDevice?: (view: DeviceView) => void;
  /** Show the AD/EZOffice/Consolidados header tabs (Manager + inventory enabled). */
  showViewTabs?: boolean;
  /** Agent wizard "Abrir Definições" → the "Dispositivos" tab (shared with the Manager list). */
  onOpenDeviceSettings?: () => void;
  /** Manager device-list error recovery → the "Conexões" tab (AD read failed). */
  onOpenConnectionSettings?: () => void;
  /** Manager device-list error recovery → the "Conexões" tab (inventory-API source failed). */
  onOpenInventorySettings?: () => void;
  /** Consolidated view → open the reconciliation dashboard (InventoryPage). */
  onOpenReconciliation?: () => void;
}) {
  if (IS_AGENT) return <PcOnboardingWizard {...props} />;

  const { view = "consolidated", onNavigateDevice, showViewTabs, onOpenReconciliation, toast, onOpenInventorySettings } = props;

  // The three views share an in-page tab switcher in their header (only when the
  // inventory API is on — otherwise there's just the raw AD list, no tabs).
  const tabs = showViewTabs && onNavigateDevice
    ? { view, onSelect: onNavigateDevice }
    : undefined;

  // The EZOffice asset inventory is its own list (source of truth for hardware),
  // not an AD list, so it renders a dedicated page rather than DeviceListPage.
  if (view === "ezoffice") {
    return <EZOfficePage toast={toast} tabs={tabs} onOpenSettings={onOpenInventorySettings} />;
  }

  // "ad" = raw AD objects (no EZOffice overlay); "consolidated" = AD enriched with
  // the matching EZOffice asset, plus a link to the reconciliation dashboard. With
  // no tabs (inventory off) it's just "Dispositivos"; with tabs the active tab is
  // the heading, so the static title only shows in the no-tabs case.
  return (
    <DeviceListPage
      toast={toast}
      kiosk={props.kiosk}
      variant={view === "ad" ? "ad" : "consolidated"}
      title={tabs ? undefined : "Dispositivos"}
      tabs={tabs}
      onOpenConnectionSettings={props.onOpenConnectionSettings}
      onOpenInventorySettings={onOpenInventorySettings}
      onOpenReconciliation={view === "consolidated" ? onOpenReconciliation : undefined}
    />
  );
}
