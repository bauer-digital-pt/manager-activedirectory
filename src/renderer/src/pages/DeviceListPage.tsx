import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Search, ServerCrash, RotateCcw, RefreshCw, Settings, Boxes } from "lucide-react";
import { adAPI, type ADComputer } from "../adAPI";
import { inventoryAPI, type InventoryAsset, type InventorySourceDevice } from "../inventoryAPI";
import { getInventoryConfig } from "../lib/inventoryConfig";
import { cn } from "../lib/cn";
import type { ExternalToast } from "sonner";
import DeviceRow, { deviceStatus, type DeviceAsset } from "./DeviceRow";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

// Windows PowerShell's ConvertTo-Json returns a bare object for a single result
// and null for none — normalize any of those shapes to a plain array.
function toArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data == null) return [];
  return [data as T];
}

// The inventory API's AD view (ldap3, snake_case) → the ADComputer shape the
// table already renders. It carries no DNS / ManagedBy / created / enabled flag,
// so those stay undefined (Enabled included — the row shows "Estado desconhecido"
// rather than fabricating "Ativo"); last_seen (ISO-8601) maps onto LastLogonDate,
// which the row's date helpers parse like the PowerShell "yyyy-MM-dd HH:mm:ss" stamp.
function fromSourceDevice(d: InventorySourceDevice): ADComputer {
  return {
    Name: d.name,
    OperatingSystem: d.platform || undefined,
    OperatingSystemVersion: d.os_version || undefined,
    OU: d.department || undefined,
    LastLogonDate: d.last_seen ?? null,
    DistinguishedName: "",
  };
}

// Build the enrichment map joining EZOffice detail onto a device row. The key is
// the device name (lowercased) because that's the only identifier an ADComputer
// row and an EZOffice asset share — neither the PowerShell nor the inventory row
// exposes a serial to join on. On the Mac path the source devices seed serial +
// holder first (so a device EZOffice doesn't know still shows them), then the
// EZOffice assets overlay, being authoritative for category/status.
function buildAssetMap(
  assets: InventoryAsset[] | null,
  sources: InventorySourceDevice[] | null,
): Map<string, DeviceAsset> {
  const map = new Map<string, DeviceAsset>();
  if (sources) {
    for (const s of sources) {
      const k = (s.name || "").toLowerCase();
      if (!k) continue;
      map.set(k, {
        serial_number: s.serial_number || undefined,
        assigned_user_email: s.assigned_user_email || undefined,
      });
    }
  }
  if (assets) {
    for (const a of assets) {
      const k = (a.name || "").toLowerCase();
      if (!k) continue;
      const prev = map.get(k) ?? {};
      map.set(k, {
        serial_number: a.serial_number || prev.serial_number,
        category: a.category || undefined,
        status: a.status || undefined,
        assigned_user_email: a.assigned_user_email || prev.assigned_user_email,
      });
    }
  }
  return map;
}

// Module-level cache so returning from another page (e.g. Settings) is instant
// and doesn't re-query the whole fleet. A first-ever mount has loaded=false. `key`
// records the source+enrichment signature the cache was built for, so toggling
// inventory (or a non-Windows host) triggers a one-off refresh.
type DevicesCache = {
  devices: ADComputer[];
  assets: Map<string, DeviceAsset>;
  sourced: boolean;
  loaded: boolean;
  error: string | null;
  key: string;
};
let devicesCache: DevicesCache = { devices: [], assets: new Map(), sourced: false, loaded: false, error: null, key: "" };

export default function DeviceListPage({
  toast,
  kiosk = false,
  onOpenConnectionSettings,
  onOpenInventorySettings,
}: {
  toast: { success: ToastFn; error: ToastFn };
  /** Kiosk mode: silently refresh the fleet every 5 min for a live wall display. */
  kiosk?: boolean;
  /** Opens Settings → AD Connection — offered when the AD device read fails. */
  onOpenConnectionSettings?: () => void;
  /** Opens Settings → Inventário — offered when the inventory-API source fails (Mac/Linux). */
  onOpenInventorySettings?: () => void;
}) {
  const [devices, setDevices] = useState<ADComputer[]>(devicesCache.devices);
  const [assetByName, setAssetByName] = useState<Map<string, DeviceAsset>>(devicesCache.assets);
  const [sourced, setSourced] = useState(devicesCache.sourced);
  const [loading, setLoading] = useState(!devicesCache.loaded);
  const [error, setError] = useState<string | null>(devicesCache.error);
  const [activeDept, setActiveDept] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Lazy render: mount the first slice of rows and grow on scroll so a large
  // fleet doesn't build thousands of DOM rows at once.
  const PAGE = 40;
  const [visibleCount, setVisibleCount] = useState(PAGE);

  // Keep the latest toast reachable without making load() depend on it (the
  // parent may pass a fresh object each render, which would re-run the effect).
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Where the list comes from + whether to enrich it with EZOffice data. Windows
  // always reads AD directly (native PowerShell); a Mac/Linux Manager has no local
  // AD access, so — when the inventory API is enabled — it sources the fleet from
  // that API instead. `?macfallback` forces this path in the browser preview.
  const platform = window.appAPI?.platform ?? "browser";
  const forceMac = platform === "browser" && new URLSearchParams(location.search).has("macfallback");
  const [invReady, setInvReady] = useState(false);
  const [invEnabled, setInvEnabled] = useState(false);
  const [invBaseUrl, setInvBaseUrl] = useState("");
  useEffect(() => {
    let alive = true;
    getInventoryConfig()
      .then((c) => { if (alive) { setInvEnabled(!!c.enabled); setInvBaseUrl(c.baseUrl || ""); setInvReady(true); } })
      .catch(() => { if (alive) setInvReady(true); });
    return () => { alive = false; };
  }, []);

  const useInventorySource = invEnabled && (platform === "darwin" || platform === "linux" || forceMac);
  const enrich = invEnabled;
  // Include the API address in the key ONLY when a fetch actually hits it, so
  // changing the address (source or enrichment) re-queries, while a pure AD read
  // isn't needlessly invalidated by an unrelated inventory-URL edit.
  const usesApi = useInventorySource || enrich;
  const cacheKey = `${useInventorySource ? "inv" : "ad"}|${enrich ? "enr" : "raw"}|${usesApi ? invBaseUrl : "-"}`;

  // `background` (kiosk auto-refresh) reloads without the loading skeleton and,
  // on failure, keeps the last-good fleet instead of blanking it — a wall display
  // should stay showing stale-but-useful data rather than an error every 5 min.
  const load = useCallback((background = false) => {
    if (!background) { setLoading(true); setError(null); }
    const key = cacheKey;

    // Enrichment must never block the list: a failed assets fetch just means no
    // EZOffice detail, not a broken page.
    const assetsP: Promise<InventoryAsset[] | null> = enrich
      ? inventoryAPI.getAssets().then((r) => (r.ok && r.data ? r.data : null)).catch(() => null)
      : Promise.resolve(null);

    const run = async (): Promise<{ list: ADComputer[]; map: Map<string, DeviceAsset> }> => {
      if (useInventorySource) {
        const [devRes, assets] = await Promise.all([inventoryAPI.getADDevices(), assetsP]);
        if (!devRes.ok) throw new Error(devRes.error ?? "Não foi possível obter os dispositivos da API de inventário.");
        const sources = toArray<InventorySourceDevice>(devRes.data);
        return { list: sources.map(fromSourceDevice), map: buildAssetMap(assets, sources) };
      }
      const [devRes, assets] = await Promise.all([adAPI.getDevices(), assetsP]);
      if (!devRes.ok) throw new Error(devRes.error ?? "Não foi possível carregar os dispositivos do Active Directory.");
      return { list: toArray<ADComputer>(devRes.data), map: buildAssetMap(assets, null) };
    };

    run()
      .then(({ list, map }) => {
        setLoading(false);
        setDevices(list); setAssetByName(map); setSourced(useInventorySource); setError(null);
        devicesCache = { devices: list, assets: map, sourced: useInventorySource, loaded: true, error: null, key };
      })
      .catch((e) => {
        // Background hiccup: keep the last-good fleet untouched (no blank, no error).
        if (background) return;
        setLoading(false);
        setDevices([]); setAssetByName(new Map()); setSourced(useInventorySource);
        // Explicit, recoverable error — never a misleading "no devices".
        const fallback = useInventorySource
          ? "Não foi possível contactar a API de inventário."
          : "Não foi possível comunicar com o Active Directory.";
        const err = typeof e?.message === "string" && e.message ? e.message : fallback;
        setError(err);
        devicesCache = { devices: [], assets: new Map(), sourced: useInventorySource, loaded: true, error: err, key };
      });
  }, [useInventorySource, enrich, cacheKey]);

  useEffect(() => {
    // Wait until the source decision is known (which inventory config resolves),
    // then fetch on the first ever mount or whenever the source/enrichment changes.
    if (!invReady) return;
    if (!devicesCache.loaded || devicesCache.key !== cacheKey) load();
  }, [invReady, cacheKey, load]);

  // Kiosk: silently refresh the fleet every 5 minutes so the live view stays
  // current on a wall display without any operator action.
  useEffect(() => {
    if (!kiosk || !invReady) return;
    const id = setInterval(() => load(true), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [kiosk, invReady, load]);

  // Distinct department folders (OU) present in the fleet, for the filter pills.
  const departments = useMemo(() => {
    const set = new Set<string>();
    for (const d of devices) if (d.OU) set.add(d.OU);
    return Array.from(set).sort();
  }, [devices]);

  // Type-to-search (parity with the Users list): any printable key focuses the
  // search box. Bail while a detail modal is open so we don't steal its keys.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length === 1) {
        e.preventDefault();
        searchRef.current?.focus();
        setSearch((s) => s + e.key);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return devices.filter((d) => {
      const matchesDept = !activeDept || d.OU === activeDept;
      if (!q) return matchesDept;
      const a = assetByName.get((d.Name || "").toLowerCase());
      const matchesSearch =
        d.Name?.toLowerCase().includes(q) ||
        d.DNSHostName?.toLowerCase().includes(q) ||
        d.Description?.toLowerCase().includes(q) ||
        d.OperatingSystem?.toLowerCase().includes(q) ||
        d.OU?.toLowerCase().includes(q) ||
        a?.serial_number?.toLowerCase().includes(q) ||
        a?.assigned_user_email?.toLowerCase().includes(q);
      return matchesDept && matchesSearch;
    });
  }, [devices, activeDept, search, assetByName]);

  // Reset the window only when the operator changes a filter — deliberately NOT
  // keyed on `devices`, so a kiosk background refresh swaps the data in place
  // without collapsing the scrolled-open window and yanking a wall display back
  // to the top every 5 min. A shrunk/grown result set is handled by the
  // filtered.slice + hasMore below without needing a reset. (Matches UsersPage.)
  useEffect(() => { setVisibleCount(PAGE); }, [search, activeDept]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 280) {
      setVisibleCount((n) => Math.min(n + PAGE, filtered.length));
    }
  };

  // Small at-a-glance breakdown for the footer.
  const activeCount = useMemo(() => filtered.filter((d) => deviceStatus(d).tone === "emerald").length, [filtered]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="px-6 pt-5 pb-4 border-b border-zinc-200 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900">Dispositivos</h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
              <input
                ref={searchRef}
                placeholder="Procurar dispositivos…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 pr-3 py-1.5 text-sm bg-zinc-50 border border-zinc-200 rounded-md w-56 focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all"
              />
            </div>
            <button
              onClick={() => load()}
              disabled={loading}
              title={useInventorySource ? "Recarregar da API de inventário" : "Recarregar do Active Directory"}
              className="inline-flex items-center justify-center p-1.5 text-zinc-500 bg-zinc-50 border border-zinc-200 rounded-md hover:bg-zinc-100 hover:text-zinc-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw size={14} className={cn(loading && "animate-spin")} />
            </button>
          </div>
        </div>

        {/* Department pills */}
        {(loading || departments.length > 0) && (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setActiveDept(null)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-medium transition-colors",
                !activeDept ? "bg-violet-600 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200",
              )}
            >
              Todos
            </button>
            {loading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-6 w-16 rounded-full bg-zinc-100 animate-pulse" />
                ))
              : departments.map((d) => (
                  <button
                    key={d}
                    onClick={() => setActiveDept(activeDept === d ? null : d)}
                    className={cn(
                      "px-3 py-1 rounded-full text-xs font-medium transition-colors",
                      activeDept === d ? "bg-violet-600 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200",
                    )}
                  >
                    {d}
                  </button>
                ))}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto" onScroll={onScroll}>
        {/* Mac/Linux Manager: the fleet comes from the inventory API, not local AD. */}
        {!loading && !error && sourced && (
          <div className="mx-6 mt-4 flex items-center gap-2 rounded-lg border border-violet-100 bg-violet-50/60 px-3 py-2 text-xs text-violet-700">
            <Boxes size={14} className="flex-shrink-0" />
            Lista obtida através da API de inventário — este dispositivo não tem acesso direto ao Active Directory.
          </div>
        )}
        {loading ? (
          <div className="px-6 py-4 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-14 bg-zinc-50 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <DevicesError
            message={error}
            sourced={sourced}
            onRetry={() => load()}
            onOpenSettings={sourced ? onOpenInventorySettings : onOpenConnectionSettings}
          />
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-sm text-zinc-400">
            {search || activeDept ? "Nenhum dispositivo corresponde aos filtros" : "Nenhum dispositivo encontrado"}
          </div>
        ) : (
          <table className="anim-fade-in w-full">
            <thead>
              <tr className="border-b border-zinc-100">
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider">Dispositivo</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider">Departamento</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider hidden md:table-cell">Sistema</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider hidden sm:table-cell">Último início de sessão</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider">Estado</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-zinc-500 uppercase tracking-wider"><span className="sr-only">Detalhes</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50">
              {visible.map((d, i) => (
                <DeviceRow
                  key={d.DistinguishedName || d.Name || `row-${i}`}
                  device={d}
                  asset={assetByName.get((d.Name || "").toLowerCase())}
                />
              ))}
            </tbody>
          </table>
        )}
        {hasMore && (
          <div className="px-6 py-3 text-center text-xs text-zinc-400">
            A mostrar {visible.length} de {filtered.length} — continua a fazer scroll para ver mais
          </div>
        )}
      </div>

      {/* Footer */}
      {!loading && !error && filtered.length > 0 && (
        <div className="px-6 py-3 border-t border-zinc-100">
          <span className="text-xs text-zinc-400">
            {filtered.length} {filtered.length === 1 ? "dispositivo" : "dispositivos"}
            {/* The API source carries no enabled flag, so an "ativos" count there
                would be a fabricated 0 — only show it on the AD (Windows) path. */}
            {!sourced && <>{" — "}{activeCount} {activeCount === 1 ? "ativo" : "ativos"}</>}
            {(search || activeDept) && " — filtrado"}
          </span>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

// Inline, recoverable error shown when the fleet can't be listed — points at the
// settings for whichever source failed (the inventory API on a Mac/Linux Manager,
// the AD connection otherwise) instead of a dead "no devices".
function DevicesError({
  message,
  sourced,
  onRetry,
  onOpenSettings,
}: {
  message: string;
  /** The failing fetch was the inventory-API source (Mac/Linux), not local AD. */
  sourced: boolean;
  onRetry: () => void;
  onOpenSettings?: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 ring-1 ring-amber-200/70">
        <ServerCrash size={26} strokeWidth={2} />
      </div>
      <h3 className="mt-5 text-base font-semibold text-zinc-900">
        Não foi possível carregar os dispositivos
      </h3>
      <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-zinc-500">{message}</p>
      <p className="mt-1 max-w-[46ch] text-xs leading-relaxed text-zinc-400">
        {sourced ? (
          <>
            Confirma o endereço da API em{" "}
            <span className="font-medium text-zinc-500">Definições → Inventário</span>.
          </>
        ) : (
          <>
            Verifica a ligação ao Active Directory em{" "}
            <span className="font-medium text-zinc-500">Definições → Ligação AD</span>.
          </>
        )}
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700"
        >
          <RotateCcw size={15} />
          Tentar novamente
        </button>
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-800"
          >
            <Settings size={15} />
            Abrir definições
          </button>
        )}
      </div>
    </div>
  );
}
