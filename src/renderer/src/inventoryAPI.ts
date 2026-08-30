// Type-safe wrapper around window.inventoryAPI injected by the preload script.
//
// The inventory shapes live in src/shared/types.ts (single source of truth across
// main + renderer); re-exported here so pages can `import { InventoryAsset } from
// "../inventoryAPI"` alongside the client. Every call is a read-only GET against
// the internal pyexp-inventory API and returns the same { ok, data, error }
// envelope the AD calls use. Manager-only — never wired into the Agent installer.
import type {
  PSResult, InventoryHealth, InventoryAsset, AssetPublicLink, InventoryMember,
  InventorySourceDevice, Reconciliation, AssetMaintenance, MaintenanceStartBody,
  MaintenanceResult,
} from "../../shared/types";
export type {
  InventoryHealth, InventoryAsset, AssetPublicLink, InventoryMember,
  InventorySourceDevice, Reconciliation, MetricsSummary,
  ReconciliationCounts, OrphanedAsset, StaleDevice, MissingDevice, NewMember,
  AssetMaintenance, MaintenanceWorkOrder, MaintenanceStartBody, MaintenanceResult,
} from "../../shared/types";

declare global {
  interface Window {
    inventoryAPI: {
      // Reachability + identity probe against /healthz (open, no auth). Accepts an
      // optional override so Settings can test unsaved values before saving.
      test(override?: { baseUrl?: string }): Promise<PSResult<InventoryHealth>>;
      getAssets(): Promise<PSResult<InventoryAsset[]>>;
      // The coded public label URL for ONE asset, fetched on demand at print time
      // (kept off getAssets so the rate-limited per-asset lookup can't stall the list).
      getAssetPublicLink(assetId: string): Promise<PSResult<AssetPublicLink>>;
      // AD computer objects as the inventory API sees them (ldap3), snake_case.
      getADDevices(): Promise<PSResult<InventorySourceDevice[]>>;
      // ScreenConnect Access machines (same shape, source="screenconnect"). Returns
      // [] when ScreenConnect isn't configured server-side.
      getScreenConnectDevices(): Promise<PSResult<InventorySourceDevice[]>>;
      // Cross-check of AD vs EZOffice: orphaned / stale / missing findings.
      getReconciliation(): Promise<PSResult<Reconciliation>>;

      // --- EZOffice custody writes. Each is signed with the login session and
      // gated server-side on require_ad_login (ANY signed-in AD user — not admin).
      // The renderer already refetches the fleet after a write, so a bare { ok }
      // is enough; the updated asset is returned when the API provides it. ---
      // EZOffice members for the checkout picker. `query` is an optional server-side
      // filter; the checkout modal fetches all once and filters locally.
      getMembers(query?: string): Promise<PSResult<InventoryMember[]>>;
      // Assign the asset behind a device to an EZOffice member (checkout).
      checkout(assetId: string, memberId: string, comments?: string): Promise<PSResult<InventoryAsset>>;
      // Return a checked-out asset to available (checkin).
      checkin(assetId: string, comments?: string): Promise<PSResult<InventoryAsset>>;

      // --- Maintenance (EZOffice work orders). Same auth model as the custody
      // writes; startMaintenance is the only mutating one. ---
      // Tenant work-order type names for the "Começar manutenção" category dropdown.
      // [] when the Work Orders module is disabled server-side.
      getMaintenanceTypes(): Promise<PSResult<string[]>>;
      // The asset's current open work order (drives the read-only "Ver manutenção").
      getMaintenance(assetId: string): Promise<PSResult<AssetMaintenance>>;
      // Open a maintenance work order against the asset behind a device.
      startMaintenance(assetId: string, body: MaintenanceStartBody): Promise<PSResult<MaintenanceResult>>;
    };
  }
}

// --- Mock used when running in the browser (outside Electron) ---
import {
  mockAssets, mockAssetPublicLink, mockADSourceDevices, mockScreenConnectDevices,
  mockReconciliation, mockMembers,
} from "../../shared/fixtures";

const delay = (ms = 500) => new Promise<void>((r) => setTimeout(r, ms));

// Dev affordances (browser preview only):
//   ?invfail      — every read fails (exercises the inline error / retry card)
//   ?invempty     — every read returns empty data (exercises the "all in sync" state)
//   ?invwritefail — every custody write fails (exercises the checkout/checkin error toast)
function invFlag(name: string): boolean {
  return new URLSearchParams(location.search).has(name);
}
const INV_FAIL_ERROR =
  "Não foi possível contactar a API de inventário. Confirma o endereço em Definições → Inventário.";

// A zeroed reconciliation for the ?invempty preview — nothing out of sync.
function emptyReconciliation(): Reconciliation {
  return {
    ran_at: new Date().toISOString(),
    dry_run: true,
    counts: {
      assets_total: 0, members_total: 0, members_active: 0, devices_total: 0,
      missing_in_ezoffice: 0, missing_in_source: 0, users_orphaned: 0,
      orphaned_assets: 0, stale_devices: 0, errors: 0,
    },
    orphaned_assets: [], stale_devices: [], missing_in_ezoffice_devices: [],
    new_members: [], errors: [],
  };
}

const mockAPI: Window["inventoryAPI"] = {
  test: async (override) => {
    await delay(400);
    if (invFlag("invfail")) return { ok: false, error: INV_FAIL_ERROR };
    if (override && override.baseUrl !== undefined && !override.baseUrl.trim()) {
      return { ok: false, error: "Falta o endereço da API de inventário." };
    }
    return {
      ok: true,
      data: {
        status: "ok", mode: "live", version: "mock", directory_enabled: false,
        cache_age_seconds: { assets: null, members: null, devices_ad: null, reconciliation: null },
      },
    };
  },
  getAssets: async () => {
    await delay();
    if (invFlag("invfail")) return { ok: false, error: INV_FAIL_ERROR };
    return { ok: true, data: invFlag("invempty") ? [] : mockAssets() };
  },
  getAssetPublicLink: async (assetId) => {
    await delay(300);
    if (invFlag("invfail")) return { ok: false, error: INV_FAIL_ERROR };
    // Mirror the on-demand API: resolve the single asset's coded public link (null
    // when the asset has no public page). This is where the QR URL comes from now —
    // the list read (getAssets) is deliberately QR-less.
    return { ok: true, data: { asset_id: assetId, qr_url: mockAssetPublicLink(assetId) } };
  },
  getADDevices: async () => {
    await delay();
    if (invFlag("invfail")) return { ok: false, error: INV_FAIL_ERROR };
    return { ok: true, data: invFlag("invempty") ? [] : mockADSourceDevices() };
  },
  getScreenConnectDevices: async () => {
    await delay();
    if (invFlag("invfail")) return { ok: false, error: INV_FAIL_ERROR };
    return { ok: true, data: invFlag("invempty") ? [] : mockScreenConnectDevices() };
  },
  getReconciliation: async () => {
    await delay(800);
    if (invFlag("invfail")) return { ok: false, error: INV_FAIL_ERROR };
    return { ok: true, data: invFlag("invempty") ? emptyReconciliation() : mockReconciliation() };
  },
  getMembers: async () => {
    await delay(400);
    if (invFlag("invfail")) return { ok: false, error: INV_FAIL_ERROR };
    // The checkout picker fetches all and filters locally, so query is ignored here.
    return { ok: true, data: mockMembers() };
  },
  checkout: async (assetId, memberId) => {
    await delay(600);
    if (!assetId) return { ok: false, error: "Falta o identificador do ativo." };
    if (!memberId) return { ok: false, error: "Falta o utilizador para atribuir o ativo." };
    if (invFlag("invwritefail")) return { ok: false, error: "Falha simulada ao fazer checkout do ativo." };
    return { ok: true };
  },
  checkin: async (assetId) => {
    await delay(600);
    if (!assetId) return { ok: false, error: "Falta o identificador do ativo." };
    if (invFlag("invwritefail")) return { ok: false, error: "Falha simulada ao fazer checkin do ativo." };
    return { ok: true };
  },
  getMaintenanceTypes: async () => {
    await delay(300);
    if (invFlag("invfail")) return { ok: false, error: INV_FAIL_ERROR };
    return {
      ok: true,
      data: ["Manutenção preventiva", "Reparação de hardware", "Substituição de peça", "Diagnóstico"],
    };
  },
  getMaintenance: async (assetId) => {
    await delay(300);
    if (invFlag("invfail")) return { ok: false, error: INV_FAIL_ERROR };
    // IT-01 (asset "1") is the fixture flagged in_maintenance — return a matching
    // open work order so "Ver manutenção" has something to show; others are idle.
    if (assetId === "1") {
      return {
        ok: true,
        data: {
          asset_id: assetId, ongoing: true,
          work_order: {
            id: 55, title: "Substituição de ecrã", state: "In Progress",
            priority: "High", description: "Ecrã com riscos; substituir painel.",
            created_on: "2026-08-20",
          },
        },
      };
    }
    return { ok: true, data: { asset_id: assetId, ongoing: false, work_order: null } };
  },
  startMaintenance: async (assetId, body) => {
    await delay(700);
    if (!assetId) return { ok: false, error: "Falta o identificador do ativo." };
    if (!body.title?.trim()) return { ok: false, error: "Falta o título da manutenção." };
    if (invFlag("invwritefail")) return { ok: false, error: "Falha simulada ao iniciar a manutenção." };
    return {
      ok: true,
      data: {
        ok: true, asset_id: assetId, action: "maintenance",
        work_order: { id: 99, title: body.title, state: body.start ? "In Progress" : "Open" },
      },
    };
  },
};

if (!window.inventoryAPI) {
  (window as Window).inventoryAPI = mockAPI;
}

export const inventoryAPI = {
  test:                (o?: { baseUrl?: string }) => window.inventoryAPI.test(o),
  getAssets:           () => window.inventoryAPI.getAssets(),
  getAssetPublicLink:  (assetId: string) => window.inventoryAPI.getAssetPublicLink(assetId),
  getADDevices:        () => window.inventoryAPI.getADDevices(),
  getScreenConnectDevices: () => window.inventoryAPI.getScreenConnectDevices(),
  getReconciliation:   () => window.inventoryAPI.getReconciliation(),
  getMembers:          (query?: string) => window.inventoryAPI.getMembers(query),
  checkout:            (assetId: string, memberId: string, comments?: string) =>
                         window.inventoryAPI.checkout(assetId, memberId, comments),
  checkin:             (assetId: string, comments?: string) =>
                         window.inventoryAPI.checkin(assetId, comments),
  getMaintenanceTypes: () => window.inventoryAPI.getMaintenanceTypes(),
  getMaintenance:      (assetId: string) => window.inventoryAPI.getMaintenance(assetId),
  startMaintenance:    (assetId: string, body: MaintenanceStartBody) =>
                         window.inventoryAPI.startMaintenance(assetId, body),
};
