import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Search, ServerCrash, RotateCcw, RefreshCw, Settings, Boxes } from "lucide-react";
import { inventoryAPI, type InventoryAsset } from "../inventoryAPI";
import { getInventoryConfig } from "../lib/inventoryConfig";
import { ezStatusLabel } from "./DeviceRow";
import { cn } from "../lib/cn";
import type { ExternalToast } from "sonner";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

// Module-level cache (parity with DeviceListPage): returning from another page
// is instant and doesn't re-query the whole inventory. `key` records the API
// address the data was built for, so editing it in Settings re-fetches.
type AssetsCache = { assets: InventoryAsset[]; loaded: boolean; error: string | null; key: string };
let assetsCache: AssetsCache = { assets: [], loaded: false, error: null, key: "" };

// ISO / "YYYY-MM-DD …" → a short PT date; falls back to the raw string (or "—")
// so a surprising shape never crashes the row.
function fmtDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("pt-PT", { dateStyle: "medium" });
}

// EZOffice lifecycle status → a coloured badge tone (keys are the lowercased
// English tokens the API emits; ezStatusLabel renders the PT text).
const STATUS_TONE: Record<string, string> = {
  "in use":    "bg-emerald-50 text-emerald-600 border-emerald-200",
  "available": "bg-violet-50 text-violet-600 border-violet-200",
  "retired":   "bg-zinc-100 text-zinc-500 border-zinc-200",
  "broken":    "bg-red-50 text-red-600 border-red-200",
  "lost":      "bg-amber-50 text-amber-600 border-amber-200",
};

function StatusBadge({ status }: { status?: string }) {
  const key = (status || "").toLowerCase();
  const tone = STATUS_TONE[key] || "bg-zinc-100 text-zinc-500 border-zinc-200";
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border", tone)}>
      {ezStatusLabel(status)}
    </span>
  );
}

// The EZOffice asset inventory — the hardware source of truth, listed straight
// from GET /api/v1/assets (no AD join). Read-only, like the Manager device list.
export default function EZOfficePage({
  toast: _toast,
  onOpenSettings,
}: {
  toast: { success: ToastFn; error: ToastFn };
  /** Opens Settings → Conexões — offered when the inventory read fails. */
  onOpenSettings?: () => void;
}) {
  const [assets, setAssets] = useState<InventoryAsset[]>(assetsCache.assets);
  const [loading, setLoading] = useState(!assetsCache.loaded);
  const [error, setError] = useState<string | null>(assetsCache.error);
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Lazy render: mount the first slice and grow on scroll so a large inventory
  // doesn't build thousands of DOM rows at once (mirrors DeviceListPage).
  const PAGE = 40;
  const [visibleCount, setVisibleCount] = useState(PAGE);

  // The API address the current view is bound to. null until config resolves;
  // "∅" stands in for an unset address so it still differs from "not yet known".
  const [cfgKey, setCfgKey] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getInventoryConfig()
      .then((c) => { if (alive) setCfgKey(c.baseUrl || "∅"); })
      .catch(() => { if (alive) setCfgKey("∅"); });
    return () => { alive = false; };
  }, []);
  const cfgKeyRef = useRef(cfgKey);
  cfgKeyRef.current = cfgKey;

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const key = cfgKeyRef.current ?? "";
    inventoryAPI
      .getAssets()
      .then((r) => {
        setLoading(false);
        if (r.ok && r.data) {
          setAssets(r.data);
          setError(null);
          assetsCache = { assets: r.data, loaded: true, error: null, key };
        } else {
          setAssets([]);
          const err = r.error ?? "Não foi possível obter os ativos do inventário.";
          setError(err);
          assetsCache = { assets: [], loaded: true, error: err, key };
        }
      })
      .catch((e) => {
        setLoading(false);
        setAssets([]);
        const err = typeof e?.message === "string" && e.message ? e.message : "Não foi possível contactar a API de inventário.";
        setError(err);
        assetsCache = { assets: [], loaded: true, error: err, key };
      });
  }, []);

  useEffect(() => {
    // Wait until the API address is known, then fetch on the first ever mount or
    // whenever it changed since the cache was built (e.g. edited in Settings).
    if (cfgKey === null) return;
    if (!assetsCache.loaded || assetsCache.key !== cfgKey) load();
  }, [cfgKey, load]);

  // Distinct categories present, for the filter pills.
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const a of assets) if (a.category) set.add(a.category);
    return Array.from(set).sort();
  }, [assets]);

  // Type-to-search: any printable key focuses the search box (parity with the
  // other lists). Bail while a detail modal is open so we don't steal its keys.
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
    return assets.filter((a) => {
      const matchesCat = !activeCat || a.category === activeCat;
      if (!q) return matchesCat;
      const matchesSearch =
        a.name?.toLowerCase().includes(q) ||
        a.serial_number?.toLowerCase().includes(q) ||
        a.category?.toLowerCase().includes(q) ||
        a.status?.toLowerCase().includes(q) ||
        a.assigned_user_email?.toLowerCase().includes(q);
      return matchesCat && matchesSearch;
    });
  }, [assets, activeCat, search]);

  useEffect(() => { setVisibleCount(PAGE); }, [search, activeCat]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 280) {
      setVisibleCount((n) => Math.min(n + PAGE, filtered.length));
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="px-6 pt-5 pb-4 border-b border-zinc-200 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900">Dispositivos EZOffice</h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
              <input
                ref={searchRef}
                placeholder="Procurar ativos…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 pr-3 py-1.5 text-sm bg-zinc-50 border border-zinc-200 rounded-md w-56 focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all"
              />
            </div>
            <button
              onClick={load}
              disabled={loading}
              title="Recarregar do inventário EZOffice"
              className="inline-flex items-center justify-center p-1.5 text-zinc-500 bg-zinc-50 border border-zinc-200 rounded-md hover:bg-zinc-100 hover:text-zinc-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw size={14} className={cn(loading && "animate-spin")} />
            </button>
          </div>
        </div>

        {/* Category pills */}
        {(loading || categories.length > 0) && (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setActiveCat(null)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-medium transition-colors",
                !activeCat ? "bg-violet-600 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200",
              )}
            >
              Todas
            </button>
            {loading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-6 w-16 rounded-full bg-zinc-100 animate-pulse" />
                ))
              : categories.map((c) => (
                  <button
                    key={c}
                    onClick={() => setActiveCat(activeCat === c ? null : c)}
                    className={cn(
                      "px-3 py-1 rounded-full text-xs font-medium transition-colors",
                      activeCat === c ? "bg-violet-600 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200",
                    )}
                  >
                    {c}
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
          <AssetsError message={error} onRetry={load} onOpenSettings={onOpenSettings} />
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-sm text-zinc-400">
            {search || activeCat ? "Nenhum ativo corresponde aos filtros" : "Nenhum ativo encontrado"}
          </div>
        ) : (
          <table className="anim-fade-in w-full">
            <thead>
              <tr className="border-b border-zinc-100">
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider">Ativo</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider hidden md:table-cell">Nº de série</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider">Categoria</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider hidden lg:table-cell">Utilizador atribuído</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider hidden sm:table-cell">Comprado em</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50">
              {visible.map((a, i) => (
                <tr key={a.asset_id || a.serial_number || a.name || `row-${i}`} className="hover:bg-zinc-50/80 transition-colors">
                  <td className="px-6 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-violet-100 flex items-center justify-center flex-shrink-0">
                        <Boxes size={15} className="text-violet-700" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-900 truncate">{a.name || "—"}</p>
                        <p className="text-xs text-zinc-400 truncate md:hidden">{a.serial_number || "—"}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-3.5 hidden md:table-cell">
                    <span className="font-mono text-xs text-zinc-500">{a.serial_number || "—"}</span>
                  </td>
                  <td className="px-6 py-3.5">
                    {a.category
                      ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-100 text-zinc-500">{a.category}</span>
                      : <span className="text-xs text-zinc-300">—</span>}
                  </td>
                  <td className="px-6 py-3.5 hidden lg:table-cell">
                    <span className="text-sm text-zinc-500 truncate">{a.assigned_user_email || "—"}</span>
                  </td>
                  <td className="px-6 py-3.5 hidden sm:table-cell">
                    <span className="text-sm text-zinc-500">{fmtDate(a.purchased_on)}</span>
                  </td>
                  <td className="px-6 py-3.5"><StatusBadge status={a.status} /></td>
                </tr>
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
            {filtered.length} {filtered.length === 1 ? "ativo" : "ativos"}
            {(search || activeCat) && " — filtrado"}
          </span>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

// Inline, recoverable error shown when the inventory can't be listed — points at
// the connection settings instead of a dead "no assets" state.
function AssetsError({
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
        Não foi possível carregar os ativos
      </h3>
      <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-zinc-500">{message}</p>
      <p className="mt-1 max-w-[46ch] text-xs leading-relaxed text-zinc-400">
        Confirma o endereço da API em{" "}
        <span className="font-medium text-zinc-500">Definições → Conexões</span>.
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
