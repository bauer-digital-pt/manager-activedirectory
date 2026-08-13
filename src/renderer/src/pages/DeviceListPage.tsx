import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Search, ServerCrash, RotateCcw, RefreshCw, Settings } from "lucide-react";
import { adAPI, type ADComputer } from "../adAPI";
import { cn } from "../lib/cn";
import type { ExternalToast } from "sonner";
import DeviceRow, { deviceStatus } from "./DeviceRow";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

// Windows PowerShell's ConvertTo-Json returns a bare object for a single result
// and null for none — normalize any of those shapes to a plain array.
function toArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data == null) return [];
  return [data as T];
}

// Module-level cache so returning from another page (e.g. Settings) is instant
// and doesn't re-query the whole fleet. A first-ever mount has loaded=false.
type DevicesCache = { devices: ADComputer[]; loaded: boolean; error: string | null };
let devicesCache: DevicesCache = { devices: [], loaded: false, error: null };

export default function DeviceListPage({
  toast,
  onOpenDeviceSettings,
}: {
  toast: { success: ToastFn; error: ToastFn };
  /** Opens Settings (Dispositivos / Ligação AD) — offered when the query fails. */
  onOpenDeviceSettings?: () => void;
}) {
  const [devices, setDevices] = useState<ADComputer[]>(devicesCache.devices);
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

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    adAPI
      .getDevices()
      .then((r) => {
        setLoading(false);
        if (r.ok) {
          const list = toArray<ADComputer>(r.data);
          setDevices(list);
          setError(null);
          devicesCache = { devices: list, loaded: true, error: null };
        } else {
          // Explicit, recoverable error — never a misleading "no devices".
          setDevices([]);
          const err = r.error ?? "Não foi possível carregar os dispositivos do Active Directory.";
          setError(err);
          devicesCache = { devices: [], loaded: true, error: err };
        }
      })
      .catch((e) => {
        setLoading(false);
        setDevices([]);
        const err = typeof e?.message === "string" ? e.message : "Não foi possível comunicar com o Active Directory.";
        setError(err);
        devicesCache = { devices: [], loaded: true, error: err };
      });
  }, []);

  useEffect(() => {
    // Only fetch on the first ever mount; later mounts reuse the cache.
    if (!devicesCache.loaded) load();
  }, [load]);

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
      const matchesSearch =
        !q ||
        d.Name?.toLowerCase().includes(q) ||
        d.DNSHostName?.toLowerCase().includes(q) ||
        d.Description?.toLowerCase().includes(q) ||
        d.OperatingSystem?.toLowerCase().includes(q) ||
        d.OU?.toLowerCase().includes(q);
      return matchesDept && matchesSearch;
    });
  }, [devices, activeDept, search]);

  // Reset the window whenever the result set changes (filter/search/reload).
  useEffect(() => { setVisibleCount(PAGE); }, [search, activeDept, devices]);

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
              onClick={load}
              disabled={loading}
              title="Recarregar do Active Directory"
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
        {loading ? (
          <div className="px-6 py-4 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-14 bg-zinc-50 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <DevicesError message={error} onRetry={load} onOpenSettings={onOpenDeviceSettings} />
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-sm text-zinc-400">
            {search || activeDept ? "Nenhum dispositivo corresponde aos filtros" : "Nenhum dispositivo encontrado"}
          </div>
        ) : (
          <table className="w-full">
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
                <DeviceRow key={d.DistinguishedName || d.Name || `row-${i}`} device={d} />
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
            {" — "}{activeCount} {activeCount === 1 ? "ativo" : "ativos"}
            {(search || activeDept) && " — filtrado"}
          </span>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

// Inline, recoverable error shown when the fleet can't be listed — points at the
// AD connection settings instead of a dead "no devices".
function DevicesError({
  message,
  onRetry,
  onOpenSettings,
}: {
  message: string;
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
        Verifica a ligação ao Active Directory em{" "}
        <span className="font-medium text-zinc-500">Definições → Ligação AD</span>.
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
