import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Search, ServerCrash, RotateCcw, RefreshCw, Settings, Boxes, PackageSearch,
  Tag, Activity, Building2, Layers, ArrowUpNarrowWide, ArrowDownWideNarrow, X,
} from "lucide-react";
import { adAPI, type ADComputer } from "../adAPI";
import { inventoryAPI, type InventoryAsset, type InventorySourceDevice } from "../inventoryAPI";
import { getInventoryConfig } from "../lib/inventoryConfig";
import { getDeviceConfig } from "../lib/deviceConfig";
import { cn } from "../lib/cn";
import type { ExternalToast } from "sonner";
import DeviceRow, { type UrlTemplates } from "./DeviceRow";
import FilterDropdown, { type FilterOption } from "../components/ui/FilterDropdown";
import {
  type ConsolidatedDevice, type DeviceSource, type StateId,
  fromAD, fromSource, consolidate, deviceState, STATE_RANK,
} from "../lib/devices";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

// Windows PowerShell's ConvertTo-Json returns a bare object for a single result
// and null for none — normalize any of those shapes to a plain array.
function toArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data == null) return [];
  return [data as T];
}

/* ------------------------------- sorting ---------------------------------- */

// "Ordenar por" options. "estado" is the default: bucketed by STATE_RANK
// (attention states first, healthy last), alphabetical within each bucket.
type SortBy = "estado" | "nome" | "recente" | "criacao";
const SORT_OPTIONS: FilterOption[] = [
  { value: "estado",  label: "Estado (padrão)" },
  { value: "nome",    label: "Nome" },
  { value: "recente", label: "Último início de sessão" },
  { value: "criacao", label: "Data de criação" },
];

// Parse a PowerShell "yyyy-MM-dd HH:mm:ss" or ISO-8601 stamp into a comparable
// epoch, or null when absent/unparseable (nulls always sort last).
function toTime(v?: string | null): number | null {
  if (!v) return null;
  const t = Date.parse(v.includes("T") ? v : v.replace(" ", "T"));
  return Number.isNaN(t) ? null : t;
}
function nameCmp(a: ConsolidatedDevice, b: ConsolidatedDevice): number {
  return (a.displayName || a.name).localeCompare(b.displayName || b.name, "pt");
}

// PT labels for the Estado filter, keyed by the StateId deviceState() returns.
const STATE_LABEL: Record<StateId, string> = {
  disabled: "Desativado", broken: "Avariado", lost: "Perdido", inactive: "Inativo",
  retired: "Abatido", available: "Disponível", inuse: "Em uso", active: "Ativo",
  unknown: "Desconhecido",
};
const SOURCE_LABEL: Record<DeviceSource, string> = {
  ad: "Active Directory", ezoffice: "EZOffice", both: "AD + EZOffice",
};

/* --------------------------------- cache ---------------------------------- */

// Module-level cache so returning from another page (e.g. Settings) is instant
// and doesn't re-query the whole fleet. `key` records the source+enrichment
// signature the cache was built for, so toggling inventory (or a non-Windows
// host) triggers a one-off refresh. Holds the RAW base rows + assets so the
// consolidation stays a pure, memoised derivation.
type DevicesCache = {
  base: ConsolidatedDevice[];
  assets: InventoryAsset[] | null;
  sourced: boolean;
  loaded: boolean;
  error: string | null;
  key: string;
};
let devicesCache: DevicesCache = { base: [], assets: null, sourced: false, loaded: false, error: null, key: "" };

export default function DeviceListPage({
  toast,
  kiosk = false,
  ensureFreshAuth,
  onOpenConnectionSettings,
  onOpenInventorySettings,
  onOpenReconciliation,
}: {
  toast: { success: ToastFn; error: ToastFn };
  /** Kiosk mode: silently refresh the fleet every 5 min for a live wall display. */
  kiosk?: boolean;
  /** Threaded to each row to gate the enable/disable write behind a re-auth. */
  ensureFreshAuth?: () => Promise<boolean>;
  /** Opens Settings → Conexões — offered when the AD device read fails. */
  onOpenConnectionSettings?: () => void;
  /** Opens Settings → Conexões — offered when the inventory-API source fails (Mac/Linux). */
  onOpenInventorySettings?: () => void;
  /** Jump to the reconciliation dashboard (AD ↔ EZOffice). */
  onOpenReconciliation?: () => void;
}) {
  const [base, setBase] = useState<ConsolidatedDevice[]>(devicesCache.base);
  const [assets, setAssets] = useState<InventoryAsset[] | null>(devicesCache.assets);
  const [sourced, setSourced] = useState(devicesCache.sourced);
  const [loading, setLoading] = useState(!devicesCache.loaded);
  const [error, setError] = useState<string | null>(devicesCache.error);

  // Four filter TYPES (null = "all") + the sort control — same UX as the Users page.
  const [categoria, setCategoria] = useState<string | null>(null);
  const [estado, setEstado] = useState<string | null>(null);
  const [departamento, setDepartamento] = useState<string | null>(null);
  const [fonte, setFonte] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("estado");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Admin-configured deep-link templates (EZOffice / ScreenConnect) from Settings.
  const [urlTemplates, setUrlTemplates] = useState<UrlTemplates>({ ezoffice: "", screenConnect: "" });
  useEffect(() => {
    let alive = true;
    getDeviceConfig()
      .then((c) => { if (alive) setUrlTemplates({ ezoffice: c.ezofficeUrlTemplate, screenConnect: c.screenConnectUrlTemplate }); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

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
  // that API instead. Browser preview: ?macfallback forces the source path and
  // ?inv forces enrichment so the consolidated list (peripherals included) shows.
  const platform = window.appAPI?.platform ?? "browser";
  const params = new URLSearchParams(location.search);
  const forceMac = platform === "browser" && params.has("macfallback");
  const forceInv = platform === "browser" && (params.has("inv") || params.has("macfallback"));
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

  const useInventorySource = (invEnabled && (platform === "darwin" || platform === "linux")) || forceMac;
  const enrich = invEnabled || forceInv;
  // Include the API address in the key ONLY when a fetch actually hits it, so
  // changing the address re-queries, while a pure AD read isn't needlessly
  // invalidated by an unrelated inventory-URL edit.
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

    const run = async (): Promise<{ base: ConsolidatedDevice[]; assets: InventoryAsset[] | null }> => {
      if (useInventorySource) {
        const [devRes, a] = await Promise.all([inventoryAPI.getADDevices(), assetsP]);
        if (!devRes.ok) throw new Error(devRes.error ?? "Não foi possível obter os dispositivos da API de inventário.");
        return { base: toArray<InventorySourceDevice>(devRes.data).map(fromSource), assets: a };
      }
      const [devRes, a] = await Promise.all([adAPI.getDevices(), assetsP]);
      if (!devRes.ok) throw new Error(devRes.error ?? "Não foi possível carregar os dispositivos do Active Directory.");
      return { base: toArray<ADComputer>(devRes.data).map(fromAD), assets: a };
    };

    run()
      .then(({ base: b, assets: a }) => {
        setLoading(false);
        setBase(b); setAssets(a); setSourced(useInventorySource); setError(null);
        devicesCache = { base: b, assets: a, sourced: useInventorySource, loaded: true, error: null, key };
      })
      .catch((e) => {
        // Background hiccup: keep the last-good fleet untouched (no blank, no error).
        if (background) return;
        setLoading(false);
        setBase([]); setAssets(null); setSourced(useInventorySource);
        const fallback = useInventorySource
          ? "Não foi possível contactar a API de inventário."
          : "Não foi possível comunicar com o Active Directory.";
        const err = typeof e?.message === "string" && e.message ? e.message : fallback;
        setError(err);
        devicesCache = { base: [], assets: null, sourced: useInventorySource, loaded: true, error: err, key };
      });
  }, [useInventorySource, enrich, cacheKey]);

  useEffect(() => {
    // Wait until the source decision is known (which inventory config resolves),
    // then fetch on the first ever mount or whenever the source/enrichment changes.
    if (!invReady) return;
    if (!devicesCache.loaded || devicesCache.key !== cacheKey) load();
  }, [invReady, cacheKey, load]);

  // Kiosk: silently refresh every 5 minutes so a wall display stays current.
  useEffect(() => {
    if (!kiosk || !invReady) return;
    const id = setInterval(() => load(true), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [kiosk, invReady, load]);

  // The single, consolidated + enriched list (req. A): AD objects overlaid with
  // their matching EZOffice asset, plus asset-only rows for peripherals AD never
  // sees. A pure, memoised derivation of the raw base + assets.
  const devices = useMemo(() => consolidate(base, assets), [base, assets]);

  // Patch a single row's enabled flag in place after a successful toggle, so the
  // state badge updates without a full refetch. Keyed by the consolidated key
  // (= the AD base row's key), and mirrored into the cache.
  const onToggledEnabled = useCallback((key: string, enabled: boolean) => {
    setBase((prev) => {
      const next = prev.map((d) => (d.key === key ? { ...d, enabled } : d));
      devicesCache = { ...devicesCache, base: next };
      return next;
    });
  }, []);

  // Filter option lists, drawn from the loaded fleet so each dropdown only offers
  // values that actually exist (parity with the Users page).
  const categoriaOptions = useMemo<FilterOption[]>(() => {
    const set = new Set<string>();
    for (const d of devices) if (d.category) set.add(d.category);
    return [...set].sort((a, b) => a.localeCompare(b, "pt")).map((c) => ({ value: c, label: c }));
  }, [devices]);
  const departamentoOptions = useMemo<FilterOption[]>(() => {
    const set = new Set<string>();
    for (const d of devices) if (d.department) set.add(d.department);
    return [...set].sort((a, b) => a.localeCompare(b, "pt")).map((d) => ({ value: d, label: d }));
  }, [devices]);
  const estadoOptions = useMemo<FilterOption[]>(() => {
    const set = new Set<StateId>();
    for (const d of devices) set.add(deviceState(d).id);
    return [...set]
      .sort((a, b) => STATE_RANK[a] - STATE_RANK[b])
      .map((id) => ({ value: id, label: STATE_LABEL[id] }));
  }, [devices]);
  const fonteOptions = useMemo<FilterOption[]>(() => {
    const set = new Set<DeviceSource>();
    for (const d of devices) set.add(d.source);
    const order: DeviceSource[] = ["both", "ad", "ezoffice"];
    return order.filter((s) => set.has(s)).map((s) => ({ value: s, label: SOURCE_LABEL[s] }));
  }, [devices]);

  const anyFilterActive = !!(categoria || estado || departamento || fonte || search.trim());
  const clearFilters = useCallback(() => {
    setCategoria(null); setEstado(null); setDepartamento(null); setFonte(null); setSearch("");
  }, []);

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

  // Filter by all four types + free-text, then sort. Recomputes only when an
  // input actually changes.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = devices.filter((d) => {
      if (categoria && (d.category ?? "") !== categoria) return false;
      if (departamento && (d.department ?? "") !== departamento) return false;
      if (fonte && d.source !== fonte) return false;
      if (estado && deviceState(d).id !== estado) return false;
      if (q) {
        const hay = [
          d.name, d.displayName, d.dnsHostName, d.serialNumber, d.category,
          d.department, d.operatingSystem, d.assignedUserEmail, d.description,
        ];
        if (!hay.some((v) => v?.toLowerCase().includes(q))) return false;
      }
      return true;
    });

    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      switch (sortBy) {
        case "nome":
          return dir * nameCmp(a, b);
        case "recente":
        case "criacao": {
          const ta = toTime(sortBy === "recente" ? a.lastLogonDate : a.whenCreated);
          const tb = toTime(sortBy === "recente" ? b.lastLogonDate : b.whenCreated);
          if (ta === null && tb === null) return nameCmp(a, b);
          if (ta === null) return 1;   // missing timestamps always sort last
          if (tb === null) return -1;
          return dir * (ta - tb) || nameCmp(a, b);
        }
        case "estado":
        default:
          return dir * (STATE_RANK[deviceState(a).id] - STATE_RANK[deviceState(b).id]) || nameCmp(a, b);
      }
    });
  }, [devices, categoria, departamento, fonte, estado, search, sortBy, sortDir]);

  // Reset the render window whenever the filter/sort inputs change. Deliberately
  // NOT keyed on `devices`, so a kiosk background refresh swaps data in place
  // without yanking a wall display back to the top.
  useEffect(() => {
    setVisibleCount(PAGE);
  }, [search, categoria, estado, departamento, fonte, sortBy, sortDir]);

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
            {onOpenReconciliation && (
              <button
                onClick={onOpenReconciliation}
                title="Abrir a reconciliação AD ↔ EZOffice"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium text-zinc-600 bg-zinc-50 border border-zinc-200 rounded-md hover:bg-zinc-100 hover:text-zinc-800 transition-colors"
              >
                <PackageSearch size={14} />
                Reconciliação
              </button>
            )}
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

        {/* Filter types + sort control (same layout as the Users page) */}
        {loading ? (
          <div className="flex items-center gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 w-28 rounded-lg bg-zinc-100 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <FilterDropdown
              label="Categoria"
              icon={<Tag size={13} />}
              allLabel="Todas"
              value={categoria}
              options={categoriaOptions}
              onChange={setCategoria}
            />
            <FilterDropdown
              label="Estado"
              icon={<Activity size={13} />}
              allLabel="Todos"
              value={estado}
              options={estadoOptions}
              onChange={setEstado}
            />
            <FilterDropdown
              label="Departamento"
              icon={<Building2 size={13} />}
              allLabel="Todos"
              value={departamento}
              options={departamentoOptions}
              onChange={setDepartamento}
            />
            <FilterDropdown
              label="Fonte"
              icon={<Layers size={13} />}
              allLabel="Todas"
              value={fonte}
              options={fonteOptions}
              onChange={setFonte}
            />

            {/* Sort: choose the key, then toggle asc/desc. */}
            <div className="ml-auto flex items-center gap-1.5">
              <FilterDropdown
                label="Ordenar por"
                allowAll={false}
                value={sortBy}
                options={SORT_OPTIONS}
                onChange={(v) => setSortBy((v as SortBy) ?? "estado")}
              />
              <button
                type="button"
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                title={sortDir === "asc" ? "Ascendente" : "Descendente"}
                className="inline-flex items-center justify-center rounded-lg border border-zinc-200 bg-white p-1.5 text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-700"
              >
                {sortDir === "asc" ? <ArrowUpNarrowWide size={15} /> : <ArrowDownWideNarrow size={15} />}
              </button>
            </div>

            {anyFilterActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
              >
                <X size={13} />
                Limpar
              </button>
            )}
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
            {anyFilterActive ? "Nenhum dispositivo corresponde aos filtros" : "Nenhum dispositivo encontrado"}
          </div>
        ) : (
          <table className="anim-fade-in w-full">
            <thead>
              <tr className="border-b border-zinc-100">
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider">Dispositivo</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider">Departamento</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider hidden md:table-cell">Categoria</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider hidden sm:table-cell">Último início de sessão</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider">Estado</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-zinc-500 uppercase tracking-wider"><span className="sr-only">Detalhes</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50">
              {visible.map((d) => (
                <DeviceRow
                  key={d.key}
                  device={d}
                  toast={toast}
                  ensureFreshAuth={ensureFreshAuth}
                  urlTemplates={urlTemplates}
                  onToggledEnabled={onToggledEnabled}
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
            {anyFilterActive && " — filtrado"}
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
            <span className="font-medium text-zinc-500">Definições → Conexões</span>.
          </>
        ) : (
          <>
            Verifica a ligação ao Active Directory em{" "}
            <span className="font-medium text-zinc-500">Definições → Conexões</span>.
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
