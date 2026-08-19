// Wi-Fi network gate. Before any login, the app confirms the machine is on the
// office wireless network. If it's actively connected to a DIFFERENT Wi-Fi, we
// block with a full-screen warning instead of showing the login form.
//
// Policy (single source of truth — `isWrongWifi`): block ONLY on a positively
// identified wrong SSID. Wired, no Wi-Fi adapter, an undetectable network, or an
// IPC failure all resolve to "not wrong" → login proceeds. We never trap the user
// on uncertainty; we only stop a clearly-wrong association.
import type { WifiStatus } from "../../../shared/types";

export type { WifiStatus } from "../../../shared/types";

// The only wireless network the app is allowed to run on. Compared
// case-insensitively (Windows SSIDs are case-sensitive but users aren't).
export const EXPECTED_SSID = "WiFiBMAP";

// `window.appAPI` (incl. the optional `getSsid`) is declared globally in
// lib/groupsConfig.ts — no re-declaration here to avoid a merge conflict.

// True when we can prove the machine is on the WRONG Wi-Fi. Everything else
// (not connected, exact match on ANY connected interface, or `null` =
// undetermined) is allowed. Checking every associated SSID means a second
// wireless NIC on a guest network can't lock out a user who IS on WiFiBMAP.
export function isWrongWifi(status: WifiStatus | null): boolean {
  if (!status || !status.connected) return false;
  const names = (status.ssids && status.ssids.length ? status.ssids : status.ssid ? [status.ssid] : [])
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0) return false;
  const expected = EXPECTED_SSID.toLowerCase();
  return !names.some((n) => n.toLowerCase() === expected);
}

// Browser preview only: `?wrongwifi` simulates a bad network so the WifiGate can
// be verified without a packaged build; `?wifi=Name` forces a specific SSID.
function simulated(): WifiStatus | null {
  if (typeof location === "undefined") return null;
  const params = new URLSearchParams(location.search);
  if (params.has("wrongwifi")) return { connected: true, ssid: "Starbucks_Guest" };
  const forced = params.get("wifi");
  if (forced) return { connected: true, ssid: forced };
  return null;
}

// Resolve the current Wi-Fi status. Returns `null` when it can't be determined
// (no appAPI in the browser, IPC error, or a non-Windows host) so callers treat
// it as "undetermined → allow", never as "wrong".
export async function getWifiStatus(): Promise<WifiStatus | null> {
  const sim = simulated();
  if (sim) return sim;
  try {
    if (!window.appAPI?.getSsid) return null;
    const res = await window.appAPI.getSsid();
    if (!res.ok || !res.data) return null;
    return res.data;
  } catch {
    return null;
  }
}
