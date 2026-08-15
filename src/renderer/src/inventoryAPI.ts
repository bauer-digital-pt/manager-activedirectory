// Type-safe wrapper around window.inventoryAPI injected by the preload script.
//
// The inventory shapes live in src/shared/types.ts (single source of truth across
// main + renderer); re-exported here so pages can `import { InventoryAsset } from
// "../inventoryAPI"` alongside the client. Every call is a read-only GET against
// the internal pyexp-inventory API and returns the same { ok, data, error }
// envelope the AD calls use. Manager-only — never wired into the Agent installer.
import type {
  PSResult, InventoryHealth, InventoryAsset,
  InventorySourceDevice, Reconciliation,
} from "../../shared/types";
export type {
  InventoryHealth, InventoryAsset, InventoryMember,
  InventorySourceDevice, Reconciliation, MetricsSummary,
  ReconciliationCounts, OrphanedAsset, StaleDevice, MissingDevice, NewMember,
} from "../../shared/types";

declare global {
  interface Window {
    inventoryAPI: {
      // Reachability + identity probe against /healthz (open, no auth). Accepts an
      // optional override so Settings can test unsaved values before saving.
      test(override?: { baseUrl?: string }): Promise<PSResult<InventoryHealth>>;
      getAssets(): Promise<PSResult<InventoryAsset[]>>;
      // AD computer objects as the inventory API sees them (ldap3), snake_case.
      getADDevices(): Promise<PSResult<InventorySourceDevice[]>>;
      // Cross-check of AD vs EZOffice: orphaned / stale / missing findings.
      getReconciliation(): Promise<PSResult<Reconciliation>>;
    };
  }
}

// --- Mock used when running in the browser (outside Electron) ---
import {
  mockAssets, mockADSourceDevices, mockReconciliation,
} from "../../shared/fixtures";

const delay = (ms = 500) => new Promise<void>((r) => setTimeout(r, ms));

// Dev affordances (browser preview only):
//   ?invfail  — every read fails (exercises the inline error / retry card)
//   ?invempty — every read returns empty data (exercises the "all in sync" state)
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
  getADDevices: async () => {
    await delay();
    if (invFlag("invfail")) return { ok: false, error: INV_FAIL_ERROR };
    return { ok: true, data: invFlag("invempty") ? [] : mockADSourceDevices() };
  },
  getReconciliation: async () => {
    await delay(800);
    if (invFlag("invfail")) return { ok: false, error: INV_FAIL_ERROR };
    return { ok: true, data: invFlag("invempty") ? emptyReconciliation() : mockReconciliation() };
  },
};

if (!window.inventoryAPI) {
  (window as Window).inventoryAPI = mockAPI;
}

export const inventoryAPI = {
  test:              (o?: { baseUrl?: string }) => window.inventoryAPI.test(o),
  getAssets:         () => window.inventoryAPI.getAssets(),
  getADDevices:      () => window.inventoryAPI.getADDevices(),
  getReconciliation: () => window.inventoryAPI.getReconciliation(),
};
