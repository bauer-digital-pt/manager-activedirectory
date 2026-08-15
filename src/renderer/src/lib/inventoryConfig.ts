// Inventory API settings (the internal read-only pyexp-inventory API).
//
// Only the address + master switch are persisted — there is no token. Each read
// is signed with the live login session (see main.ts). In the browser (dev/mock)
// the address/switch fall back to localStorage.
import type { InventoryConfigInfo, InventoryConfigPayload } from "../../../shared/types";

export type { InventoryConfigInfo, InventoryConfigPayload } from "../../../shared/types";

const LS_KEY = "admanager.inventory";

// window.configAPI is declared globally in groupsConfig.ts.

export async function getInventoryConfig(): Promise<InventoryConfigInfo> {
  try {
    if (window.configAPI?.getInventory) {
      return await window.configAPI.getInventory();
    }
    const stored = localStorage.getItem(LS_KEY);
    if (stored) {
      const raw = JSON.parse(stored);
      return { baseUrl: raw.baseUrl ?? "", enabled: !!raw.enabled };
    }
  } catch { /* fall through */ }
  return { baseUrl: "", enabled: false };
}

export async function setInventoryConfig(payload: InventoryConfigPayload): Promise<InventoryConfigInfo> {
  if (window.configAPI?.setInventory) {
    return window.configAPI.setInventory(payload);
  }
  // Browser mock — persist the address + switch to localStorage.
  const next = {
    baseUrl: payload.baseUrl ?? "",
    enabled: !!payload.enabled,
  };
  localStorage.setItem(LS_KEY, JSON.stringify(next));
  return { baseUrl: next.baseUrl, enabled: next.enabled };
}
