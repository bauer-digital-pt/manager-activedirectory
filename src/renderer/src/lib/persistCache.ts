// Stale-while-revalidate persistence over localStorage. The heavy lists (the
// device fleet, the user directory) are read over the network on every cold
// launch, which is what makes startup and "a carregar listas" feel slow. Caching
// the last-good result to disk lets the page paint INSTANTLY from the last known
// state and refresh in the background, so a relaunch isn't a multi-second
// spinner. Best-effort: any quota / parse / serialization failure degrades to
// "no cache" silently — the in-memory path (and the live fetch) still work.
//
// Only NON-sensitive, already-displayed inventory data is cached here (names,
// serials, categories, statuses). Never persist credentials, tokens or passwords.
const PREFIX = "adm.cache.v1:";

export function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota exceeded or a value that won't serialize: drop any stale entry so a
    // partial/corrupt blob can't linger, then carry on (memory cache still holds).
    try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
  }
}
