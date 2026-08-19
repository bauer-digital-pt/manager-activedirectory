import { useState, useEffect, useId, useRef, memo } from "react";
import {
  Eye, X, Boxes, Copy, ExternalLink, Power, PowerOff, MonitorSmartphone,
  Server, Layers, AlertTriangle,
} from "lucide-react";
import { adAPI } from "../adAPI";
import { cn } from "../lib/cn";
import { useOutsideClick } from "../hooks/useOutsideClick";
import {
  type ConsolidatedDevice, type DeviceSource, type Tone,
  deviceState, ezStatusLabel, categoryIcon, daysSince, stripDomain,
  applyUrlTemplate, openExternal,
} from "../lib/devices";

// Admin-configured deep-link templates (from Settings → Dispositivos). Empty
// strings mean the corresponding action is hidden.
export type UrlTemplates = { ezoffice: string; screenConnect: string };

/* -------------------------------------------------------------------------- */
/* Small presentational helpers                                               */
/* -------------------------------------------------------------------------- */

const TONE_BADGE: Record<Tone, string> = {
  emerald: "bg-emerald-50 text-emerald-600 border-emerald-200",
  amber: "bg-amber-50 text-amber-600 border-amber-200",
  red: "bg-red-50 text-red-600 border-red-200",
  zinc: "bg-zinc-100 text-zinc-500 border-zinc-200",
  violet: "bg-violet-50 text-violet-600 border-violet-200",
};

function StatusBadge({ device }: { device: ConsolidatedDevice }) {
  const { label, tone } = deviceState(device);
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border", TONE_BADGE[tone])}>
      {tone === "emerald" && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
      {label}
    </span>
  );
}

// Where a row's data came from — a compact chip + a matching icon.
const SOURCE_META: Record<DeviceSource, { label: string; short: string; Icon: React.ElementType }> = {
  ad:       { label: "Active Directory",     short: "AD",          Icon: Server },
  ezoffice: { label: "EZOffice",             short: "EZOffice",    Icon: Boxes },
  both:     { label: "AD + EZOffice",        short: "AD + EZ",     Icon: Layers },
};

function SourceChip({ source }: { source: DeviceSource }) {
  const { short, Icon } = SOURCE_META[source];
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-zinc-100 text-zinc-500">
      <Icon size={10} />
      {short}
    </span>
  );
}

// Compact "há X dias" for the table; "Nunca" when there's no timestamp at all.
function relativeLabel(days: number): string {
  if (days <= 0) return "hoje";
  if (days === 1) return "ontem";
  if (days < 30) return `há ${days} dias`;
  if (days < 365) { const m = Math.round(days / 30); return `há ${m} ${m === 1 ? "mês" : "meses"}`; }
  const y = Math.floor(days / 365); return `há ${y} ${y === 1 ? "ano" : "anos"}`;
}
function lastSeenText(d: ConsolidatedDevice): string {
  const days = daysSince(d.lastLogonDate);
  return days === null ? "—" : relativeLabel(days);
}

// Full "dd/mm/yyyy HH:MM" for the detail modal; falls back to the raw string.
function absoluteDate(dateStr?: string | null): string {
  if (!dateStr) return "—";
  const t = Date.parse(dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T"));
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

/* -------------------------------------------------------------------------- */

function DeviceRow({
  device,
  toast,
  ensureFreshAuth,
  urlTemplates,
  onToggledEnabled,
}: {
  device: ConsolidatedDevice;
  toast?: { success: (m: string) => void; error: (m: string) => void };
  // Kiosk gate: the enable/disable write calls this before running (re-auth modal
  // when the last auth is stale). Absent outside kiosk mode → runs unguarded.
  ensureFreshAuth?: () => Promise<boolean>;
  urlTemplates: UrlTemplates;
  // Called after a successful enable/disable so the list can patch the row's state
  // in place (no full refetch). Receives the row key + the new enabled value.
  onToggledEnabled?: (key: string, enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  // Two-step confirm for the (reversible but disruptive) enable/disable write.
  const [confirmToggle, setConfirmToggle] = useState(false);
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const menuRef = useOutsideClick<HTMLDivElement>(menu, () => setMenu(false));

  const Icon = categoryIcon(device.category, device.name);
  const name = device.displayName || device.name || "—";
  const manager = cnOf(device.managedBy);
  const state = deviceState(device);

  // EZOffice enrichment worth showing its own section.
  const hasAsset = !!(device.assetId || device.serialNumber || device.category || device.ezStatus || device.assignedUserEmail);
  // The enable/disable write only makes sense for an AD-backed object whose state
  // we actually know (the Mac/inventory source carries no enabled flag, and AD
  // writes are unavailable off-Windows anyway — so this naturally hides there).
  const canToggle = (device.source === "ad" || device.source === "both") && device.enabled !== undefined;
  const identity = device.distinguishedName || device.name;

  // Resolved external links (null when the template is empty or can't be filled).
  const linkVars = { name: device.name, serial: device.serialNumber, id: device.assetId };
  const ezofficeUrl = applyUrlTemplate(urlTemplates.ezoffice, linkVars);
  const screenConnectUrl = applyUrlTemplate(urlTemplates.screenConnect, linkVars);

  // Copy a value to the clipboard (menu / detail actions). Feedback via toast.
  const copy = async (text: string, ok: string) => {
    setMenu(false);
    try { await navigator.clipboard.writeText(text); toast?.success(ok); }
    catch { toast?.error("Não foi possível copiar."); }
  };

  const openLink = (url: string | null) => { if (url) openExternal(url); };

  // Enable/disable the AD computer account. Reversible → gated only by the kiosk
  // re-auth (no admin-password reconfirm), plus the local two-step confirm.
  const doToggle = async () => {
    if (!canToggle) return;
    if (ensureFreshAuth && !(await ensureFreshAuth())) return;
    const action = device.enabled ? "disable" : "enable";
    setBusy(true);
    const r = await adAPI.setDeviceState({ identity, action });
    setBusy(false);
    setConfirmToggle(false);
    if (r.ok) {
      const enabled = action === "enable";
      toast?.success(enabled ? `${name} ativado` : `${name} desativado`);
      onToggledEnabled?.(device.key, enabled);
    } else {
      toast?.error(r.error ?? "Não foi possível alterar o estado do dispositivo.");
    }
  };

  // Esc closes; Enter closes when no toggle-confirm is pending.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (confirmToggle) setConfirmToggle(false); else setOpen(false); }
      else if (e.key === "Enter" && !confirmToggle && !busy) { e.preventDefault(); setOpen(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, confirmToggle, busy]);

  // Reset the transient confirm whenever the modal closes.
  useEffect(() => { if (!open) setConfirmToggle(false); }, [open]);

  // Move focus into the dialog on open and restore it on close.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => prev?.focus?.();
  }, [open]);

  // Domain-free row sub-line (req. C — never surface a raw .bmap.lis suffix in the
  // list): prefer the human holder, then a stripped hostname, then serial/category.
  const holder = stripDomain(device.assignedUserEmail);
  const subLine = holder || stripDomain(device.dnsHostName) || device.serialNumber || device.category || "—";
  const categoryCol = device.category || device.operatingSystem || "—";

  return (
    <>
      <tr
        className="group hover:bg-zinc-50/80 transition-colors select-none"
        onDoubleClick={() => setOpen(true)}
        onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}
      >
        <td className="px-6 py-3.5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-violet-100 flex items-center justify-center flex-shrink-0">
              <Icon size={15} className="text-violet-700" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-zinc-900 truncate">{name}</p>
                <SourceChip source={device.source} />
              </div>
              <p className="text-xs text-zinc-400 truncate">{subLine}</p>
            </div>
          </div>
        </td>
        <td className="px-6 py-3.5">
          {device.department
            ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-100 text-zinc-500">{device.department}</span>
            : <span className="text-xs text-zinc-300">—</span>}
        </td>
        <td className="px-6 py-3.5 hidden md:table-cell">
          <span className="text-sm text-zinc-500 truncate">{categoryCol}</span>
        </td>
        <td className="px-6 py-3.5 hidden sm:table-cell">
          <span className="text-sm text-zinc-500" title={absoluteDate(device.lastLogonDate)}>{lastSeenText(device)}</span>
        </td>
        <td className="px-6 py-3.5"><StatusBadge device={device} /></td>
        <td className="px-6 py-3.5 text-right">
          <div className="relative inline-block" ref={menuRef}>
            <button
              onClick={(e) => { e.stopPropagation(); setOpen(true); }}
              title="Ver detalhes"
              className={cn(
                "p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors",
                menu ? "opacity-100 bg-zinc-100" : "opacity-0 group-hover:opacity-100",
              )}
            >
              <Eye size={15} />
            </button>

            {menu && (
              <div className="anim-popover absolute right-0 mt-1 w-56 bg-white border border-zinc-200 rounded-xl shadow-lg overflow-hidden z-20 text-left">
                <DeviceMenuItem icon={<Eye size={13} />} label="Abrir detalhes" onClick={() => { setMenu(false); setOpen(true); }} />
                <div className="border-t border-zinc-100" />
                <DeviceMenuItem icon={<Copy size={13} />} label="Copiar nome" onClick={() => copy(device.name, "Nome copiado")} />
                {device.serialNumber && (
                  <DeviceMenuItem icon={<Copy size={13} />} label="Copiar nº de série" onClick={() => copy(device.serialNumber!, "Nº de série copiado")} />
                )}
                {device.dnsHostName && (
                  <DeviceMenuItem icon={<Copy size={13} />} label="Copiar DNS" onClick={() => copy(device.dnsHostName!, "DNS copiado")} />
                )}
                {(ezofficeUrl || screenConnectUrl) && <div className="border-t border-zinc-100" />}
                {ezofficeUrl && (
                  <DeviceMenuItem icon={<ExternalLink size={13} />} label="Abrir no EZOffice" onClick={() => { setMenu(false); openLink(ezofficeUrl); }} />
                )}
                {screenConnectUrl && (
                  <DeviceMenuItem icon={<ExternalLink size={13} />} label="Abrir no ScreenConnect" onClick={() => { setMenu(false); openLink(screenConnectUrl); }} />
                )}
              </div>
            )}
          </div>
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={6} className="p-0 border-0">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="anim-overlay fixed inset-0 z-30 bg-black/30 backdrop-blur-sm flex items-center justify-center"
              onClick={() => setOpen(false)}
            >
              <div
                ref={cardRef}
                tabIndex={-1}
                className="anim-modal bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden focus:outline-none"
                onClick={(e) => e.stopPropagation()}
              >
                <ModalHeader
                  icon={<MonitorSmartphone size={15} />}
                  title="Detalhes do dispositivo"
                  titleId={titleId}
                  subtitle={stripDomain(device.dnsHostName) || name}
                  onClose={() => setOpen(false)}
                />
                <div className="px-6 py-5 space-y-4 max-h-[60vh] overflow-y-auto">
                  <div className="flex items-center gap-4 pb-4 border-b border-zinc-100">
                    <div className="w-14 h-14 rounded-2xl bg-violet-100 flex items-center justify-center flex-shrink-0">
                      <Icon size={24} className="text-violet-700" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-base font-semibold text-zinc-900 truncate">{name}</p>
                      {(device.category || device.operatingSystem) && (
                        <p className="text-sm text-zinc-500 truncate">{device.category || device.operatingSystem}</p>
                      )}
                      <div className="mt-1 flex items-center gap-2">
                        <StatusBadge device={device} />
                        <SourceChip source={device.source} />
                      </div>
                    </div>
                  </div>

                  <DetailSection title="Identificação">
                    <DetailRow label="Nome" value={name} />
                    {device.dnsHostName && <DetailRow label="DNS" value={device.dnsHostName} />}
                    <DetailRow label="Departamento" value={device.department || "—"} />
                    <DetailRow label="Fonte" value={SOURCE_META[device.source].label} />
                  </DetailSection>

                  {(device.operatingSystem || device.operatingSystemVersion) && (
                    <DetailSection title="Sistema">
                      <DetailRow label="Sistema operativo" value={device.operatingSystem || "—"} />
                      <DetailRow label="Versão" value={device.operatingSystemVersion || "—"} />
                    </DetailSection>
                  )}

                  {hasAsset && (
                    <DetailSection title="Inventário (EZOffice)" icon={<Boxes size={12} />}>
                      {device.serialNumber && <DetailRow label="Nº de série" value={device.serialNumber} mono />}
                      {device.category && <DetailRow label="Categoria" value={device.category} />}
                      {device.ezStatus && <DetailRow label="Estado (EZOffice)" value={ezStatusLabel(device.ezStatus)} />}
                      {device.assignedUserEmail && <DetailRow label="Utilizador atribuído" value={device.assignedUserEmail} />}
                      {device.assetId && <DetailRow label="ID do ativo" value={device.assetId} mono />}
                    </DetailSection>
                  )}

                  <DetailSection title="Atividade">
                    <DetailRow label="Estado" value={state.label} />
                    <DetailRow label="Último início de sessão" value={absoluteDate(device.lastLogonDate)} />
                    {device.whenCreated && <DetailRow label="Data de criação" value={absoluteDate(device.whenCreated)} />}
                  </DetailSection>

                  {device.description && (
                    <DetailSection title="Preparado para">
                      <DetailRow label="Descrição" value={device.description} />
                    </DetailSection>
                  )}

                  {(manager || device.distinguishedName) && (
                    <DetailSection title="Diretório">
                      {manager && <DetailRow label="Gestor" value={manager} />}
                      {device.distinguishedName && <DetailRow label="DN" value={device.distinguishedName} mono />}
                    </DetailSection>
                  )}
                </div>

                <ModalFooter>
                  {/* Left: quick copy + external links. */}
                  <div className="mr-auto flex items-center gap-0.5">
                    <IconAction icon={<Copy size={15} />} label="Copiar nome" onClick={() => copy(device.name, "Nome copiado")} />
                    {device.serialNumber && (
                      <IconAction icon={<Copy size={15} />} label="Copiar nº de série" onClick={() => copy(device.serialNumber!, "Nº de série copiado")} />
                    )}
                    {ezofficeUrl && (
                      <IconAction icon={<Boxes size={15} />} label="Abrir no EZOffice" onClick={() => openLink(ezofficeUrl)} />
                    )}
                    {screenConnectUrl && (
                      <IconAction icon={<ExternalLink size={15} />} label="Abrir no ScreenConnect" onClick={() => openLink(screenConnectUrl)} />
                    )}
                  </div>

                  {/* Right: the state toggle (two-step) then Close. */}
                  {canToggle && (
                    confirmToggle ? (
                      <div className="flex items-center gap-2">
                        <span className="hidden sm:inline text-xs text-zinc-500">
                          {device.enabled ? "Desativar?" : "Ativar?"}
                        </span>
                        <button
                          onClick={() => setConfirmToggle(false)}
                          disabled={busy}
                          className="px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 rounded-lg transition-colors disabled:opacity-40"
                        >
                          Cancelar
                        </button>
                        <button
                          onClick={doToggle}
                          disabled={busy}
                          className={cn(
                            "px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-40",
                            device.enabled ? "bg-red-600 hover:bg-red-700" : "bg-emerald-600 hover:bg-emerald-700",
                          )}
                        >
                          {busy ? "A aplicar…" : device.enabled ? "Desativar" : "Ativar"}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmToggle(true)}
                        className={cn(
                          "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border transition-colors",
                          device.enabled
                            ? "border-red-200 text-red-600 hover:bg-red-50"
                            : "border-emerald-200 text-emerald-600 hover:bg-emerald-50",
                        )}
                      >
                        {device.enabled ? <PowerOff size={15} /> : <Power size={15} />}
                        {device.enabled ? "Desativar" : "Ativar"}
                      </button>
                    )
                  )}
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

// Memoised: the list re-renders on every search keystroke + scroll-driven window
// growth, but each row's `device` reference is stable (consolidate() is memoised
// upstream), so a shallow compare skips re-rendering the whole visible list.
export default memo(DeviceRow);

/* -------------------------------------------------------------------------- */

function DeviceMenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-zinc-700 hover:bg-zinc-50 transition-colors"
    >
      <span className="text-zinc-400">{icon}</span>
      {label}
    </button>
  );
}

// Icon-only action with a native hover tooltip — used in the detail footer.
function IconAction({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 transition-colors"
    >
      {icon}
    </button>
  );
}

function ModalHeader({ icon, title, titleId, subtitle, onClose }: { icon: React.ReactNode; title: string; titleId?: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="px-6 py-4 border-b border-zinc-100 flex items-center justify-between">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="text-zinc-400 flex-shrink-0">{icon}</span>
        <div className="min-w-0">
          <p id={titleId} className="text-sm font-semibold text-zinc-900">{title}</p>
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
