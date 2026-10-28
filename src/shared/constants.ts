// Constants shared across main, preload, and renderer.
// Dependency-free so both build contexts can import it.

// Domain controller the app talks to by default (domain: bmap.lis). Pre-filled so
// a fresh install connects out of the box; the user can override it in Settings →
// Connection, and an empty stored value falls back to this. We use the DC's IP
// directly (not the hostname pt-srv-dc02) because some client PCs don't resolve
// the DC hostname via DNS, which broke ADWS connectivity. Used by the main process
// as the fallback server and mirrored by the renderer's browser (dev/mock) fallback.
export const DEFAULT_DC = "10.4.0.12";

// --- Inventory API address ---------------------------------------------------
// Same shape as DEFAULT_DC + LEGACY_DCS/migrateServer() in main.ts, deliberately:
// a default, the stored values it supersedes, and one migrate function the store's
// normalizer calls. Kept HERE rather than in main.ts (where LEGACY_DCS lives) only
// so it is reachable from `node --test`, which cannot import an electron-bound
// module — see test/inventoryBaseUrl.test.ts.

// THE CUTOVER LINE. The internal read-only inventory API is moving to its own host
// (pt-srv-pyexp-03, port 8760, behind TLS → an `https://…:8760` value), and this
// constant is the only thing that has to change when it does. Everything around it
// is already in place; the address is the single unknown, so it stays the legacy
// one until that host exists — a plausible guess committed early is a wrong address
// shipped in a green diff.
//
// The move is NOT port-preserving. Today's API is a legacy container
// (`version: 0.1.0`) on pt-srv-pyexp-01 at :8000; its replacement is the same API
// ported into pyexporter (`version: 1.0.0`) on :8760. So there is no transparent
// DNS flip and the client address must change — which is what LEGACY_INVENTORY_BASE_URLS
// below is for.
export const DEFAULT_INVENTORY_BASE_URL = "http://10.4.4.69:8000";

// Stored addresses that must be transparently migrated to the current default —
// the exact counterpart of LEGACY_DCS, and for the same reason it exists there: an
// install carrying the old value in inventory.json would otherwise keep using it
// and ignore the new default.
//
// Here that matters more than it did for the DC, because the old address will be
// switched OFF. Changing DEFAULT_INVENTORY_BASE_URL alone moves only the installs
// that were never configured; every machine where anyone opened Definições →
// Inventário has the address stored and would keep calling a dead container in
// silence, the only symptom being an inventory tab that stopped working for reasons
// the user cannot see. The cutover cannot depend on visiting laptops one by one.
//
// Scoped to values WE shipped as the default. An address somebody typed by hand for
// their own reason is theirs and is left alone.
export const LEGACY_INVENTORY_BASE_URLS: readonly string[] = [
  // The legacy pyexp-inventory container on pt-srv-pyexp-01.
  "http://10.4.4.69:8000",
];

/**
 * Resolve the inventory API address to use: the stored one, unless it is blank or
 * one we have superseded, in which case the current default takes over.
 *
 * Case and trailing slashes are normalised because both spellings reach this — the
 * Definições field accepts a trailing slash and the transport strips it, so a
 * stored `…:8000/` would otherwise dodge the migration and keep an install pinned
 * to a dead address. (`migrateServer` can compare with a bare `toLowerCase()`
 * because a hostname has no such tail.)
 */
export function migrateInventoryBaseUrl(url: string): string {
  const norm = (u: string) => (u ?? "").trim().replace(/\/+$/, "").toLowerCase();
  const stored = (url ?? "").trim();
  if (!stored) return DEFAULT_INVENTORY_BASE_URL;
  const target = norm(stored);
  if (LEGACY_INVENTORY_BASE_URLS.some((old) => norm(old) === target)) {
    return DEFAULT_INVENTORY_BASE_URL;
  }
  return stored;
}
