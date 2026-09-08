import { useState, useEffect, useId, useRef, memo } from "react";
import {
  Eye, X, Boxes, Copy, ExternalLink, Power, PowerOff, MonitorSmartphone,
  Server, AlertTriangle, Printer, UserCheck, UserMinus, Wrench, ClipboardList,
} from "lucide-react";
import { adAPI } from "../adAPI";
import { inventoryAPI } from "../inventoryAPI";
import { cn } from "../lib/cn";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { Button } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { focusRing } from "../components/ui/controls";
import {
  type ConsolidatedDevice, type DeviceSource, type Tone,
  deviceState, ezStatusLabel, categoryIcon, daysSince, stripDomain,
  applyUrlTemplate, openExternal, sourceLabel, SOURCE_ORDER,
} from "../lib/devices";
import LabelPreviewModal from "../components/LabelPreviewModal";
import CheckoutMemberModal from "../components/CheckoutMemberModal";
import MaintenanceStartModal from "../components/MaintenanceStartModal";
import MaintenanceViewModal from "../components/MaintenanceViewModal";
import PortalMenu from "../components/PortalMenu";

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
  sky: "bg-sky-50 text-sky-600 border-sky-200",
};

function StatusBadge({ device }: { device: ConsolidatedDevice }) {
  const { label, tone } = deviceState(device);
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap", TONE_BADGE[tone])}>
      {tone === "emerald" && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
      {label}
    </span>
  );
}

// Where a row's data came from — one compact chip per ATOMIC source, so a row
// merged across systems (e.g. AD + ScreenConnect) shows every origin.
const SOURCE_META: Record<DeviceSource, { label: string; short: string; Icon: React.ElementType }> = {
  ad:            { label: "Active Directory", short: "AD",       Icon: Server },
  ezoffice:      { label: "EZOffice",         short: "EZOffice", Icon: Boxes },
  screenconnect: { label: "ScreenConnect",    short: "SC",       Icon: MonitorSmartphone },
};

function SourceChips({ sources }: { sources: DeviceSource[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {SOURCE_ORDER.filter((s) => sources.includes(s)).map((s) => {
        const { short, Icon, label } = SOURCE_META[s];
        return (
          <span
            key={s}
            title={label}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-zinc-100 text-zinc-500"
          >
            <Icon size={10} />
            {short}
          </span>
        );
      })}
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
  maintenanceTemplates,
  onToggledEnabled,
  onCustodyChanged,
  onMaintenanceChanged,
  selected = false,
  onToggleSelect,
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
  // Called after a successful EZOffice custody write (checkout/checkin) so the list
  // can patch the underlying asset in place — status → "in use"/"available" and the
  // holder's email. A full refetch is deliberately avoided: the API's /assets read is
  // SWR-cached (up to ~5 min stale), so it would return the PRE-write row and appear
  // to "undo" the change. Keyed by asset_id (consolidate overlays assets by that id).
  // Wire to a STABLE callback (DeviceListPage.onCustodyChanged) to keep memo() effective.
  onCustodyChanged?: (assetId: string, status: string, assignedUserEmail: string) => void;
  // Per-maintenance-type description templates (Settings → Dispositivos), passed to
  // the start-maintenance modal to pre-fill the description.
  maintenanceTemplates?: Record<string, string>;
  // Called after a maintenance work order is created so the list can flag the asset
  // in maintenance in place (ongoing → true). Keyed by asset_id, mirroring
  // onCustodyChanged — a refetch would return the SWR-cached, pre-write row.
  onMaintenanceChanged?: (assetId: string, ongoing: boolean) => void;
  // Multi-select for batch actions (e.g. batch label print). `selected` is this
  // row's checkbox state; `onToggleSelect(key)` flips it. A stable callback keeps
  // the memo() effective (see DeviceListPage). Absent → the checkbox is inert.
  selected?: boolean;
  onToggleSelect?: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  // Label preview + print dialog (SUPVAN E11). Pure client-side render; the print
  // button degrades gracefully until the Bluetooth transport lands.
  const [preview, setPreview] = useState(false);
  // EZOffice custody: checkout picker modal + checkin confirm dialog (+ its busy).
  const [checkout, setCheckout] = useState(false);
  const [checkin, setCheckin] = useState(false);
  const [checkinBusy, setCheckinBusy] = useState(false);
  // Maintenance work orders: start (two-phase form + PDF) / read-only view.
  const [maintStart, setMaintStart] = useState(false);
  const [maintView, setMaintView] = useState(false);
  // Two-step confirm for the (reversible but disruptive) enable/disable write.
  const [confirmToggle, setConfirmToggle] = useState(false);
  const titleId = useId();
  // Trap Tab focus inside the detail dialog and restore it on close (Escape is
  // still handled by the keyboard effect below, so no onEscape here).
  const cardRef = useFocusTrap<HTMLDivElement>(open);
  // Anchor for the portaled row-action menu (positioned against this button).
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const Icon = categoryIcon(device.category, device.name);
  const name = device.displayName || device.name || "—";
  const manager = cnOf(device.managedBy);
  const state = deviceState(device);

  // EZOffice enrichment worth showing its own section.
  const hasAsset = !!(device.assetId || device.serialNumber || device.category || device.ezStatus || device.assignedUserEmail);
  // The enable/disable write only makes sense for an AD-backed object whose state
  // we actually know (the Mac/inventory source carries no enabled flag, and AD
  // writes are unavailable off-Windows anyway — so this naturally hides there).
  const canToggle = device.sources.includes("ad") && device.enabled !== undefined;
  const identity = device.distinguishedName || device.name;

  // EZOffice custody actions live only on rows backed by an asset we can target by
  // id. The label reads the RAW ezStatus (not deviceState(), which AD enabled /
  // last-logon recency would override): "available" → checkout, "in use" → checkin;
  // retired/broken/lost (or no assetId) → no custody action at all.
  const ezSource = device.sources.includes("ezoffice") && !!device.assetId;
  const ez = (device.ezStatus || "").toLowerCase();
  const canCheckout = ezSource && ez === "available";
  const canCheckin = ezSource && ez === "in use";

  // Maintenance work orders (also asset-backed). The heuristic ongoingMaintenance
  // flag splits the action: not in maintenance → "Começar manutenção" (opens the
  // create flow); already in maintenance → "Ver manutenção" (read-only). Any
  // EZOffice-backed asset can start one, regardless of custody state.
  const hasMaintenance = ezSource && !!device.ongoingMaintenance;
  const canStartMaint = ezSource && !device.ongoingMaintenance;

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

  // Return the asset to the inventory (checkin). Confirmed via the ConfirmDialog; on
  // success the list patches the asset in place (available + no holder) rather than
  // refetching the SWR-cached, still-stale /assets read (see onCustodyChanged).
  const doCheckin = async () => {
    if (!device.assetId || checkinBusy) return;
    const assetId = device.assetId;
    setCheckinBusy(true);
    const r = await inventoryAPI.checkin(assetId);
    setCheckinBusy(false);
    setCheckin(false);
    if (r.ok) {
      toast?.success(`${name} devolvido ao inventário`);
      onCustodyChanged?.(assetId, "available", "");
    } else {
      toast?.error(r.error ?? "Não foi possível fazer checkin do ativo.");
    }
  };

  // Esc closes; Enter closes when no toggle-confirm is pending.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (busy) return; if (confirmToggle) setConfirmToggle(false); else setOpen(false); }
      // Enter closes the dialog — but not when focus is on a button (the trap or a
      // Tab parks it there), so its own Enter→click fires instead of double-acting.
      else if (e.key === "Enter" && !confirmToggle && !busy && !(e.target as HTMLElement).closest("button")) { e.preventDefault(); setOpen(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, confirmToggle, busy]);

  // Reset the transient confirm whenever the modal closes.
  useEffect(() => { if (!open) setConfirmToggle(false); }, [open]);

  // Domain-free row sub-line (req. C — never surface a raw .bmap.lis suffix in the
  // list): prefer the human holder, then a stripped hostname, then serial/category.
  const holder = stripDomain(device.assignedUserEmail);
  const subLine = holder || stripDomain(device.dnsHostName) || device.serialNumber || device.category || "—";
  const categoryCol = device.category || device.operatingSystem || "—";

  return (
    <>
      <tr
        className={cn(
          "group transition-colors select-none",
          selected ? "bg-violet-50/60 hover:bg-violet-50" : "hover:bg-zinc-50/80",
        )}
        onDoubleClick={() => setOpen(true)}
        onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}
      >
        <td
          className="pl-6 pr-1 py-3.5 w-0"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect?.(device.key)}
            aria-label={`Selecionar ${name}`}
            className={cn("h-4 w-4 cursor-pointer rounded border-zinc-300 accent-violet-600", focusRing)}
          />
        </td>
        <td className="pl-3 pr-6 py-3.5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-violet-100 flex items-center justify-center flex-shrink-0">
              <Icon size={15} className="text-violet-700" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-zinc-900 truncate">{name}</p>
                <SourceChips sources={device.sources} />
              </div>
              <p className="text-xs text-zinc-400 truncate">{subLine}</p>
            </div>
          </div>
        </td>
        <td className="px-6 py-3.5 max-md:hidden">
          {device.department
            ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-100 text-zinc-500">{device.department}</span>
            : <span className="text-xs text-zinc-300">—</span>}
        </td>
        <td className="px-6 py-3.5 max-lg:hidden">
          <span className="text-sm text-zinc-500 truncate">{categoryCol}</span>
        </td>
        <td className="px-6 py-3.5 max-lg:hidden">
          <span className="text-sm text-zinc-500" title={absoluteDate(device.lastLogonDate)}>{lastSeenText(device)}</span>
        </td>
        <td className="px-6 py-3.5"><StatusBadge device={device} /></td>
        <td className="px-6 py-3.5 text-right">
          <div className="inline-block">
            <button
              ref={menuBtnRef}
              onClick={(e) => { e.stopPropagation(); setMenu(false); setOpen(true); }}
              title="Ver detalhes"
              aria-label="Ver detalhes"
              className={cn(
                "p-1.5 rounded-md text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 transition-colors",
                focusRing,
                // Hidden until row hover, but revealed on keyboard focus so it's
                // reachable without a mouse.
                menu ? "opacity-100 bg-zinc-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100",
              )}
            >
              <Eye size={15} />
            </button>

            <PortalMenu open={menu} onClose={() => setMenu(false)} anchorRef={menuBtnRef} width={224}>
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
                {(canCheckout || canCheckin) && (
                  <>
                    <div className="border-t border-zinc-100" />
                    {canCheckout && (
                      <DeviceMenuItem icon={<UserCheck size={13} />} label="Fazer checkout" onClick={() => { setMenu(false); setCheckout(true); }} />
                    )}
                    {canCheckin && (
                      <DeviceMenuItem icon={<UserMinus size={13} />} label="Fazer checkin" onClick={() => { setMenu(false); setCheckin(true); }} />
                    )}
                  </>
                )}
                {(canStartMaint || hasMaintenance) && (
                  <>
                    <div className="border-t border-zinc-100" />
                    {canStartMaint && (
                      <DeviceMenuItem icon={<Wrench size={13} />} label="Começar manutenção" onClick={() => { setMenu(false); setMaintStart(true); }} />
                    )}
                    {hasMaintenance && (
                      <DeviceMenuItem icon={<ClipboardList size={13} />} label="Ver manutenção" onClick={() => { setMenu(false); setMaintView(true); }} />
                    )}
                  </>
                )}
                <div className="border-t border-zinc-100" />
                <DeviceMenuItem icon={<Printer size={13} />} label="Imprimir etiqueta" onClick={() => { setMenu(false); setPreview(true); }} />
            </PortalMenu>
          </div>
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={7} className="p-0 border-0">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="anim-overlay fixed inset-0 z-30 flex items-center justify-center overflow-y-auto p-4 bg-black/30 backdrop-blur-sm"
              // Don't dismiss on a backdrop click while a toggle write is in flight.
              onClick={() => { if (!busy) setOpen(false); }}
            >
              <div
                ref={cardRef}
                tabIndex={-1}
                className="anim-modal bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto focus:outline-none"
                onClick={(e) => e.stopPropagation()}
              >
                <ModalHeader
                  icon={<MonitorSmartphone size={15} />}
                  title="Detalhes do dispositivo"
                  titleId={titleId}
                  subtitle={stripDomain(device.dnsHostName) || name}
                  onClose={() => setOpen(false)}
                />
                <div className="px-6 py-5 space-y-4 max-h-[calc(100dvh-13rem)] overflow-y-auto">
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
                        <SourceChips sources={device.sources} />
                      </div>
                    </div>
                  </div>

                  <DetailSection title="Identificação">
                    <DetailRow label="Nome" value={name} />
                    {device.dnsHostName && <DetailRow label="DNS" value={device.dnsHostName} />}
                    <DetailRow label="Departamento" value={device.department || "—"} />
                    <DetailRow label="Fonte" value={sourceLabel(device.sources)} />
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
                      {device.ongoingMaintenance && <DetailRow label="Manutenção" value="Em curso" />}
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
                    <IconAction icon={<Printer size={15} />} label="Imprimir etiqueta" onClick={() => setPreview(true)} />
                  </div>

                  {/* Right: the state toggle (two-step) then Close. */}
                  {canToggle && (
                    confirmToggle ? (
                      <div className="flex items-center gap-2">
                        <span className="hidden sm:inline text-xs text-zinc-500">
                          {device.enabled ? "Desativar?" : "Ativar?"}
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmToggle(false)} disabled={busy}>
                          Cancelar
                        </Button>
                        <Button
                          variant="danger"
                          onClick={doToggle}
                          disabled={busy}
                          // Enabling is a positive (emerald) action — override the
                          // danger red only for that case (tailwind-merge wins).
                          className={!device.enabled ? "bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-500/40" : undefined}
                        >
                          {busy ? "A aplicar…" : device.enabled ? "Desativar" : "Ativar"}
                        </Button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmToggle(true)}
                        className={cn(
                          "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border transition-colors",
                          focusRing,
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
                  <Button variant="ghost" onClick={() => setOpen(false)}>Fechar</Button>
                </ModalFooter>
              </div>
            </div>
          </td>
        </tr>
      )}

      {preview && (
        <tr>
          <td colSpan={7} className="p-0 border-0">
            <LabelPreviewModal
              device={device}
              // The coded EZOffice QR URL (…/a/<seq>?c=<code>) — what a scan needs to
              // open the public asset view. It's no longer on the list read, so the
              // modal resolves it on demand from device.assetId; device.qrUrl is only
              // set on the rare path where the API already provided it. The Settings
              // URL template is passed separately as a code-less fallback — the modal
              // must prefer the coded URL, never let the template shadow it.
              codedUrl={device.qrUrl || ""}
              templateUrl={ezofficeUrl || ""}
              toast={toast}
              onClose={() => setPreview(false)}
            />
          </td>
        </tr>
      )}

      {checkout && (
        <tr>
          <td colSpan={7} className="p-0 border-0">
            <CheckoutMemberModal
              device={device}
              toast={toast}
              onClose={() => setCheckout(false)}
              onDone={(email) => {
                setCheckout(false);
                if (device.assetId) onCustodyChanged?.(device.assetId, "in use", email);
              }}
            />
          </td>
        </tr>
      )}

      {checkin && (
        <tr>
          <td colSpan={7} className="p-0 border-0">
            <ConfirmDialog
              open
              title="Fazer checkin"
              message={
                <>
                  Devolver <span className="font-medium text-zinc-700">{name}</span>
                  {holder ? <> (atribuído a <span className="font-medium text-zinc-700">{holder}</span>)</> : null}
                  {" "}ao inventário?
                </>
              }
              confirmLabel="Fazer checkin"
              busy={checkinBusy}
              onConfirm={doCheckin}
              onCancel={() => setCheckin(false)}
            />
          </td>
        </tr>
      )}

      {maintStart && (
        <tr>
          <td colSpan={7} className="p-0 border-0">
            <MaintenanceStartModal
              device={device}
              maintenanceTemplates={maintenanceTemplates}
              toast={toast}
              onClose={() => setMaintStart(false)}
              onDone={(ongoing) => {
                setMaintStart(false);
                if (device.assetId) onMaintenanceChanged?.(device.assetId, ongoing);
              }}
            />
          </td>
        </tr>
      )}

      {maintView && (
        <tr>
          <td colSpan={7} className="p-0 border-0">
            <MaintenanceViewModal device={device} onClose={() => setMaintView(false)} />
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
      role="menuitem"
      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-zinc-700 hover:bg-zinc-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/30"
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
      className={cn("p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 transition-colors", focusRing)}
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
      <button onClick={onClose} aria-label="Fechar" className={cn("p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition-colors flex-shrink-0", focusRing)}>
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
