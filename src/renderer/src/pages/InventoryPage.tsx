import { useState, useEffect, useCallback, useRef } from "react";
import {
  RefreshCw, RotateCcw, ServerCrash, Settings, PackageX, Clock,
  PackageSearch, UserPlus, AlertTriangle, CheckCircle2,
} from "lucide-react";
import { inventoryAPI, type Reconciliation } from "../inventoryAPI";
import { cn } from "../lib/cn";
import type { ExternalToast } from "sonner";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

// Module-level cache so returning from another page (e.g. Settings) is instant
// and doesn't re-run the reconciliation. A first-ever mount has loaded=false.
type ReconCache = { data: Reconciliation | null; loaded: boolean; error: string | null };
let reconCache: ReconCache = { data: null, loaded: false, error: null };

// ISO / "YYYY-MM-DD HH:MM:SS" → a short PT date-time; falls back to the raw
// string (or "—") when it isn't parseable, so a surprising shape never crashes.
function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" });
}
function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("pt-PT", { dateStyle: "medium" });
}

// The API reports orphan reasons as terse English tokens — surface them in PT.
function reasonLabel(reason: string): string {
  switch (reason) {
    case "assigned to inactive user": return "Atribuído a utilizador inativo";
    case "no source object":          return "Sem objeto de origem";
    default:                          return reason || "—";
  }
}

export default function InventoryPage({
  toast: _toast,
  onOpenSettings,
}: {
  toast: { success: ToastFn; error: ToastFn };
  /** Opens Settings → Inventário — offered when the reconciliation fails. */
  onOpenSettings?: () => void;
}) {
  const [data, setData] = useState<Reconciliation | null>(reconCache.data);
  const [loading, setLoading] = useState(!reconCache.loaded);
  const [error, setError] = useState<string | null>(reconCache.error);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    inventoryAPI
      .getReconciliation()
      .then((r) => {
        setLoading(false);
        if (r.ok && r.data) {
          setData(r.data);
          setError(null);
          reconCache = { data: r.data, loaded: true, error: null };
        } else {
          setData(null);
          const err = r.error ?? "Não foi possível obter a reconciliação do inventário.";
          setError(err);
          reconCache = { data: null, loaded: true, error: err };
        }
      })
      .catch((e) => {
        setLoading(false);
        setData(null);
        const err = typeof e?.message === "string" ? e.message : "Não foi possível contactar a API de inventário.";
        setError(err);
        reconCache = { data: null, loaded: true, error: err };
      });
  }, []);

  const loadedRef = useRef(reconCache.loaded);
  useEffect(() => {
    // Only fetch on the first ever mount; later mounts reuse the cache.
    if (!loadedRef.current) load();
  }, [load]);

  const counts = data?.counts;
  const findingsClean =
    !!data &&
    data.orphaned_assets.length === 0 &&
    data.stale_devices.length === 0 &&
    data.missing_in_ezoffice_devices.length === 0 &&
    data.new_members.length === 0 &&
    data.errors.length === 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="px-6 pt-5 pb-4 border-b border-zinc-200">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">Inventário</h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Reconciliação entre o Active Directory e o EZOffice.
              {data && (
                <>
                  {" "}Última análise: <span className="text-zinc-500">{fmtDateTime(data.ran_at)}</span>
                  {data.dry_run && <span className="ml-1.5 text-zinc-400">(simulação)</span>}
                </>
              )}
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            title="Recarregar a reconciliação"
            className="inline-flex items-center justify-center p-1.5 text-zinc-500 bg-zinc-50 border border-zinc-200 rounded-md hover:bg-zinc-100 hover:text-zinc-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw size={14} className={cn(loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="px-6 py-6 space-y-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-20 rounded-xl bg-zinc-50 animate-pulse" />
              ))}
            </div>
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-40 rounded-xl bg-zinc-50 animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <InventoryError message={error} onRetry={load} onOpenSettings={onOpenSettings} />
        ) : !data || !counts ? (
          <div className="flex items-center justify-center h-40 text-sm text-zinc-400">
            Sem dados de reconciliação.
          </div>
        ) : (
          <div className="px-6 py-6 space-y-6 max-w-6xl">
            {/* KPI grid */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Kpi label="Ativos (EZOffice)" value={counts.assets_total} />
              <Kpi label="Membros ativos" value={counts.members_active} sub={`de ${counts.members_total}`} />
              <Kpi label="Dispositivos (AD)" value={counts.devices_total} />
              <Kpi label="Ativos órfãos" value={counts.orphaned_assets} tone={counts.orphaned_assets ? "amber" : "neutral"} />
              <Kpi label="Em falta no EZOffice" value={counts.missing_in_ezoffice} tone={counts.missing_in_ezoffice ? "amber" : "neutral"} />
              <Kpi label="Obsoletos" value={counts.stale_devices} tone={counts.stale_devices ? "amber" : "neutral"} />
            </div>

            {/* All clear */}
            {findingsClean && (
              <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-emerald-700">
                <CheckCircle2 size={20} className="flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold">Tudo sincronizado</p>
                  <p className="text-xs text-emerald-600/80">Sem ocorrências entre o Active Directory e o EZOffice.</p>
                </div>
              </div>
            )}

            {/* Errors surfaced by the reconciliation itself */}
            {data.errors.length > 0 && (
              <Section title="Erros da análise" icon={AlertTriangle} tone="red" count={data.errors.length}>
                <ul className="divide-y divide-zinc-50">
                  {data.errors.map((e, i) => (
                    <li key={i} className="px-6 py-3 text-sm text-red-600">{e}</li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Orphaned assets */}
            {data.orphaned_assets.length > 0 && (
              <Section title="Ativos órfãos" icon={PackageX} tone="amber" count={data.orphaned_assets.length}>
                <FindingTable
                  rows={data.orphaned_assets}
                  keyOf={(r, i) => r.serial_number || r.name || `orphan-${i}`}
                  columns={[
                    { header: "Dispositivo", cell: (r) => <span className="font-medium text-zinc-800">{r.name || "—"}</span> },
                    { header: "Nº de série", cell: (r) => <span className="font-mono text-xs text-zinc-500">{r.serial_number || "—"}</span> },
                    { header: "Utilizador anterior", cell: (r) => r.previous_user || "—" },
                    { header: "Motivo", cell: (r) => reasonLabel(r.reason) },
                  ]}
                />
              </Section>
            )}

            {/* Missing in EZOffice */}
            {data.missing_in_ezoffice_devices.length > 0 && (
              <Section title="Em falta no EZOffice" icon={PackageSearch} tone="amber" count={data.missing_in_ezoffice_devices.length}>
                <FindingTable
                  rows={data.missing_in_ezoffice_devices}
                  keyOf={(r, i) => r.serial_number || r.name || `missing-${i}`}
                  columns={[
                    { header: "Dispositivo", cell: (r) => <span className="font-medium text-zinc-800">{r.name || "—"}</span> },
                    { header: "Nº de série", cell: (r) => <span className="font-mono text-xs text-zinc-500">{r.serial_number || "—"}</span> },
                    { header: "Plataforma", cell: (r) => r.platform || "—" },
                    { header: "Origem", cell: (r) => <SourceBadge source={r.source} /> },
                  ]}
                />
              </Section>
            )}

            {/* Stale devices */}
            {data.stale_devices.length > 0 && (
              <Section title="Dispositivos obsoletos" icon={Clock} tone="amber" count={data.stale_devices.length}>
                <FindingTable
                  rows={data.stale_devices}
                  keyOf={(r, i) => r.name || `stale-${i}`}
                  columns={[
                    { header: "Dispositivo", cell: (r) => <span className="font-medium text-zinc-800">{r.name || "—"}</span> },
                    { header: "Plataforma", cell: (r) => r.platform || "—" },
                    { header: "Visto pela última vez", cell: (r) => fmtDate(r.last_seen) },
                    { header: "Origem", cell: (r) => <SourceBadge source={r.source} /> },
                  ]}
                />
              </Section>
            )}

            {/* New members (present in the source, not yet in EZOffice) */}
            {data.new_members.length > 0 && (
              <Section title="Novos membros" icon={UserPlus} tone="violet" count={data.new_members.length}>
                <FindingTable
                  rows={data.new_members}
                  keyOf={(r, i) => r.email || `member-${i}`}
                  columns={[
                    { header: "Nome", cell: (r) => <span className="font-medium text-zinc-800">{r.display_name || "—"}</span> },
                    { header: "Email", cell: (r) => <span className="text-zinc-500">{r.email || "—"}</span> },
                    { header: "Origem", cell: (r) => <SourceBadge source={r.source} /> },
                  ]}
                />
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Kpi({ label, value, sub, tone = "neutral" }: {
  label: string;
  value: number;
  sub?: string;
  tone?: "neutral" | "amber" | "red";
}) {
  const toneCls =
    tone === "red"   ? "border-red-200 bg-red-50" :
    tone === "amber" ? "border-amber-200 bg-amber-50" :
                       "border-zinc-200 bg-white";
  const valueCls =
    tone === "red"   ? "text-red-600" :
    tone === "amber" ? "text-amber-600" :
                       "text-zinc-900";
  return (
    <div className={cn("rounded-xl border px-4 py-3", toneCls)}>
      <div className="flex items-baseline gap-1.5">
        <span className={cn("text-2xl font-semibold tabular-nums", valueCls)}>{value}</span>
        {sub && <span className="text-xs text-zinc-400">{sub}</span>}
      </div>
      <p className="mt-0.5 text-xs font-medium text-zinc-500">{label}</p>
    </div>
  );
}

function Section({ title, icon: Icon, tone, count, children }: {
  title: string;
  icon: React.ElementType;
  tone: "amber" | "red" | "violet";
  count: number;
  children: React.ReactNode;
}) {
  const iconCls =
    tone === "red"    ? "bg-red-50 text-red-500 ring-red-200/70" :
    tone === "violet" ? "bg-violet-50 text-violet-500 ring-violet-200/70" :
                        "bg-amber-50 text-amber-600 ring-amber-200/70";
  const badgeCls =
    tone === "red"    ? "bg-red-100 text-red-600" :
    tone === "violet" ? "bg-violet-100 text-violet-600" :
                        "bg-amber-100 text-amber-700";
  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200">
      <div className="flex items-center gap-2.5 border-b border-zinc-100 bg-zinc-50/60 px-6 py-3">
        <span className={cn("flex h-7 w-7 items-center justify-center rounded-lg ring-1", iconCls)}>
          <Icon size={15} strokeWidth={2} />
        </span>
        <h3 className="text-sm font-semibold text-zinc-800">{title}</h3>
        <span className={cn("ml-auto rounded-full px-2 py-0.5 text-xs font-medium tabular-nums", badgeCls)}>{count}</span>
      </div>
      {children}
    </section>
  );
}

// A small generic table: the reconciliation findings are four different row
// shapes but render the same way (header + cells), so one typed renderer covers
// them all instead of four near-identical <table> blocks.
function FindingTable<T>({ rows, columns, keyOf }: {
  rows: T[];
  columns: { header: string; cell: (row: T) => React.ReactNode }[];
  keyOf: (row: T, index: number) => string;
}) {
  return (
    <table className="anim-fade-in w-full">
      <thead>
        <tr className="border-b border-zinc-100">
          {columns.map((c) => (
            <th key={c.header} className="px-6 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-50">
        {rows.map((row, i) => (
          <tr key={keyOf(row, i)} className="hover:bg-zinc-50/50 transition-colors">
            {columns.map((c) => (
              <td key={c.header} className="px-6 py-3 text-sm text-zinc-600">{c.cell(row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SourceBadge({ source }: { source: string }) {
  if (!source) return <>—</>;
  return (
    <span className="inline-flex items-center rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
      {source}
    </span>
  );
}

// Inline, recoverable error shown when the reconciliation can't be fetched —
// points at the inventory connection settings instead of a dead empty state.
function InventoryError({
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
        Não foi possível carregar o inventário
      </h3>
      <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-zinc-500">{message}</p>
      <p className="mt-1 max-w-[46ch] text-xs leading-relaxed text-zinc-400">
        Verifica o endereço em{" "}
        <span className="font-medium text-zinc-500">Definições → Inventário</span>.
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
