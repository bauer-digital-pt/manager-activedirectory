import { useState, useEffect, memo } from "react";
import { Laptop, Eye, X, Boxes } from "lucide-react";
import { type ADComputer } from "../adAPI";
import { cn } from "../lib/cn";

// Optional EZOffice enrichment for a device (joined by name in DeviceListPage).
// A tiny view-model so the row stays decoupled from the raw inventory shapes;
// every field is optional because a device may match no EZOffice asset at all.
export type DeviceAsset = {
  serial_number?: string;
  category?: string;
  /** EZOffice lifecycle status ("in use", "available", …). */
  status?: string;
  assigned_user_email?: string;
};

// EZOffice reports lifecycle status as terse English tokens — surface them in PT.
function ezStatusLabel(status?: string): string {
  switch ((status || "").toLowerCase()) {
    case "in use":     return "Em uso";
    case "available":  return "Disponível";
    case "retired":    return "Abatido";
    case "broken":     return "Avariado";
    case "lost":       return "Perdido";
    case "":           return "—";
    default:           return status!;
  }
}

// A device is "Inativo" once it hasn't authenticated in this many days (or never).
const STALE_DAYS = 90;

// Days since a "yyyy-MM-dd HH:mm:ss" stamp (pre-stringified by the PS script);
// null when the stamp is missing or unparseable.
function daysSince(dateStr?: string | null): number | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr.replace(" ", "T"));
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

type Tone = "emerald" | "amber" | "red";

// Read-only lifecycle state derived from Enabled + last-logon recency.
export function deviceStatus(d: ADComputer): { label: string; tone: Tone } {
  if (!d.Enabled) return { label: "Desativado", tone: "red" };
  const days = daysSince(d.LastLogonDate);
  if (days === null || days >= STALE_DAYS) return { label: "Inativo", tone: "amber" };
  return { label: "Ativo", tone: "emerald" };
}

const TONE_BADGE: Record<Tone, string> = {
  emerald: "bg-emerald-50 text-emerald-600 border-emerald-200",
  amber: "bg-amber-50 text-amber-600 border-amber-200",
  red: "bg-red-50 text-red-600 border-red-200",
};

function StatusBadge({ device }: { device: ADComputer }) {
  const { label, tone } = deviceStatus(device);
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border", TONE_BADGE[tone])}>
      {tone === "emerald" && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
      {label}
    </span>
  );
}

// Compact "há X dias" for the table; "Nunca" when the machine never logged on.
function relativeLabel(days: number): string {
  if (days <= 0) return "hoje";
  if (days === 1) return "ontem";
  if (days < 30) return `há ${days} dias`;
  if (days < 365) { const m = Math.round(days / 30); return `há ${m} ${m === 1 ? "mês" : "meses"}`; }
  const y = Math.floor(days / 365); return `há ${y} ${y === 1 ? "ano" : "anos"}`;
}
function lastLogonText(d: ADComputer): string {
  const days = daysSince(d.LastLogonDate);
  return days === null ? "Nunca" : relativeLabel(days);
}

// Full "dd/mm/yyyy HH:MM" for the detail modal; falls back to the raw string.
function absoluteDate(dateStr?: string | null): string {
  if (!dateStr) return "—";
  const t = Date.parse(dateStr.replace(" ", "T"));
  if (Number.isNaN(t)) return dateStr;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// The CN (common name) of a DN, for a friendlier "Gestor" than the full path.
function cnOf(dn?: string): string | null {
  if (!dn) return null;
  const m = dn.match(/^CN=([^,]+)/i);
  return m ? m[1] : dn;
}

function DeviceRow({ device, asset }: { device: ADComputer; asset?: DeviceAsset }) {
  const [open, setOpen] = useState(false);

  // Esc / Enter close the (read-only) detail modal.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); setOpen(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const name = device.Name || "—";
  const manager = cnOf(device.ManagedBy);
  // Only show the EZOffice section when the match carried something worth showing.
  const hasAsset =
    !!asset && !!(asset.serial_number || asset.category || asset.status || asset.assigned_user_email);

  return (
    <>
      <tr
        className="group hover:bg-zinc-50/80 transition-colors cursor-pointer"
        onClick={() => setOpen(true)}
      >
        <td className="px-6 py-3.5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-violet-100 flex items-center justify-center flex-shrink-0">
              <Laptop size={15} className="text-violet-700" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-900 truncate">{name}</p>
              {/* DNS is the natural sub-line; the inventory list (no DNS) falls
                  back to the assigned user so the row still says who holds it. */}
              <p className="text-xs text-zinc-400 truncate">{device.DNSHostName || asset?.assigned_user_email || "—"}</p>
            </div>
          </div>
        </td>
        <td className="px-6 py-3.5">
          {device.OU
            ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-100 text-zinc-500">{device.OU}</span>
            : <span className="text-xs text-zinc-300">—</span>}
        </td>
        <td className="px-6 py-3.5 hidden md:table-cell">
          <span className="text-sm text-zinc-500 truncate">{device.OperatingSystem || "—"}</span>
        </td>
        <td className="px-6 py-3.5 hidden sm:table-cell">
          <span className="text-sm text-zinc-500" title={absoluteDate(device.LastLogonDate)}>{lastLogonText(device)}</span>
        </td>
        <td className="px-6 py-3.5"><StatusBadge device={device} /></td>
        <td className="px-6 py-3.5 text-right">
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(true); }}
            title="Ver detalhes"
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 opacity-0 group-hover:opacity-100 transition-colors"
          >
            <Eye size={15} />
          </button>
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={6} className="p-0 border-0">
            <div
              role="dialog"
              aria-modal="true"
              className="anim-overlay fixed inset-0 z-30 bg-black/30 backdrop-blur-sm flex items-center justify-center"
              onClick={() => setOpen(false)}
            >
              <div
                className="anim-modal bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden"
                onClick={(e) => e.stopPropagation()}
              >
                <ModalHeader
                  icon={<Laptop size={15} />}
                  title="Detalhes do dispositivo"
                  subtitle={device.DNSHostName || name}
                  onClose={() => setOpen(false)}
                />
                <div className="px-6 py-5 space-y-4 max-h-[60vh] overflow-y-auto">
                  <div className="flex items-center gap-4 pb-4 border-b border-zinc-100">
                    <div className="w-14 h-14 rounded-2xl bg-violet-100 flex items-center justify-center flex-shrink-0">
                      <Laptop size={24} className="text-violet-700" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-base font-semibold text-zinc-900 truncate">{name}</p>
                      {device.OperatingSystem && <p className="text-sm text-zinc-500 truncate">{device.OperatingSystem}</p>}
                      <div className="mt-1"><StatusBadge device={device} /></div>
                    </div>
                  </div>

                  <DetailSection title="Identificação">
                    <DetailRow label="Nome" value={name} />
                    {device.DNSHostName && <DetailRow label="DNS" value={device.DNSHostName} />}
                    <DetailRow label="Departamento" value={device.OU || "—"} />
                  </DetailSection>

                  <DetailSection title="Sistema">
                    <DetailRow label="Sistema operativo" value={device.OperatingSystem || "—"} />
                    <DetailRow label="Versão" value={device.OperatingSystemVersion || "—"} />
                  </DetailSection>

                  {hasAsset && (
                    <DetailSection title="Inventário (EZOffice)" icon={<Boxes size={12} />}>
                      {asset!.serial_number && <DetailRow label="Nº de série" value={asset!.serial_number} mono />}
                      {asset!.category && <DetailRow label="Categoria" value={asset!.category} />}
                      {asset!.status && <DetailRow label="Estado (EZOffice)" value={ezStatusLabel(asset!.status)} />}
                      {asset!.assigned_user_email && <DetailRow label="Utilizador atribuído" value={asset!.assigned_user_email} />}
                    </DetailSection>
                  )}

                  <DetailSection title="Atividade">
                    <DetailRow label="Estado" value={deviceStatus(device).label} />
                    <DetailRow label="Último início de sessão" value={absoluteDate(device.LastLogonDate)} />
                    <DetailRow label="Data de criação" value={absoluteDate(device.WhenCreated)} />
                  </DetailSection>

                  {device.Description && (
                    <DetailSection title="Preparado para">
                      <DetailRow label="Descrição" value={device.Description} />
                    </DetailSection>
                  )}

                  {(manager || device.DistinguishedName) && (
                    <DetailSection title="Diretoria">
                      {manager && <DetailRow label="Gestor" value={manager} />}
                      {device.DistinguishedName && <DetailRow label="DN" value={device.DistinguishedName} mono />}
                    </DetailSection>
                  )}
                </div>
                <ModalFooter>
                  <button onClick={() => setOpen(false)} className="px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 rounded-lg transition-colors">Fechar</button>
                </ModalFooter>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// Memoised: DeviceListPage re-renders on every search keystroke + scroll-driven
// window growth, but each row's `device` prop is unchanged, so a shallow compare
// skips re-rendering the whole visible list (and its modal machinery) on input.
export default memo(DeviceRow);

/* -------------------------------------------------------------------------- */

function ModalHeader({ icon, title, subtitle, onClose }: { icon: React.ReactNode; title: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="px-6 py-4 border-b border-zinc-100 flex items-center justify-between">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="text-zinc-400 flex-shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-zinc-900">{title}</p>
          <p className="text-xs text-zinc-400 truncate">{subtitle}</p>
        </div>
      </div>
      <button onClick={onClose} className="p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition-colors flex-shrink-0">
        <X size={14} />
      </button>
    </div>
  );
}

function ModalFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-6 py-4 border-t border-zinc-100 flex items-center justify-end gap-2">
      {children}
    </div>
  );
}

function DetailSection({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
        {icon}
        {title}
      </p>
      <div className="rounded-xl border border-zinc-100 divide-y divide-zinc-50 overflow-hidden">{children}</div>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between px-4 py-2.5 gap-4">
      <span className="text-xs text-zinc-400 flex-shrink-0 pt-0.5">{label}</span>
      <span className={cn("text-sm text-zinc-800 text-right break-all", mono && "font-mono text-xs")}>{value}</span>
    </div>
  );
}
