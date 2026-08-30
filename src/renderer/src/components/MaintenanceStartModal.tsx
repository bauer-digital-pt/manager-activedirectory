// Start a maintenance work order on a device's EZOffice asset, in two phases:
//   1. "form"    — pick a maintenance type (drives the pre-filled description
//                  template), a title, a priority and a description.
//   2. "preview" — render the maintenance-order document (buildMaintenanceHtml) in
//                  a sandboxed <iframe srcDoc>, then Guardar PDF / Imprimir (both via
//                  the main-process PDF bridge) and Confirmar (create the work order).
//
// The preview HTML is the SAME string main renders to a PDF / sends to the printer,
// so what the operator sees is exactly what prints. The work order is only created
// on Confirmar; Guardar/Imprimir act on the pre-create document (no order ref yet).
// On success it calls onDone(true) so the list can flag the asset in maintenance
// without a refetch (the /assets read is SWR-cached and would return the stale row).
import { useEffect, useMemo, useRef, useState } from "react";
import { Wrench, X, FileDown, Printer, Check } from "lucide-react";
import type { ConsolidatedDevice } from "../lib/devices";
import { ezStatusLabel, stripDomain } from "../lib/devices";
import { inventoryAPI } from "../inventoryAPI";
import { getAuthStatus } from "../lib/auth";
import { pdfAPI } from "../lib/pdf";
import { buildMaintenanceHtml, maintenanceDocTitle, type MaintenanceOrderInfo } from "../lib/maintenancePdf";
import SearchableSelect, { type SelectOption } from "./SearchableSelect";
import { Button } from "./ui/Button";
import { cn } from "../lib/cn";
import { focusRing } from "./ui/controls";
import { useFocusTrap } from "../hooks/useFocusTrap";

type Toast = { success: (m: string) => void; error: (m: string) => void };

// Work-order priorities: canonical value sent to EZOffice (unverified enum) + a PT
// label for the UI and the printed document.
const PRIORITIES: Array<{ value: string; label: string }> = [
  { value: "Low", label: "Baixa" },
  { value: "Medium", label: "Média" },
  { value: "High", label: "Alta" },
  { value: "Urgent", label: "Urgente" },
];
const priorityLabel = (value: string): string =>
  PRIORITIES.find((p) => p.value === value)?.label ?? value;

// Today's date as dd/mm/yyyy for the document header (renderer-side; main has no
// locale context).
function todayLabel(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export default function MaintenanceStartModal({
  device,
  maintenanceTemplates,
  toast,
  onClose,
  onDone,
}: {
  device: ConsolidatedDevice;
  /** Per-type description templates from Settings (keyed by maintenance-type name). */
  maintenanceTemplates?: Record<string, string>;
  toast?: Toast;
  onClose: () => void;
  /** Fired after the work order is created, so the list can flag the asset in
   *  maintenance in place (ongoing → true) without a stale-cache refetch. */
  onDone: (ongoing: boolean) => void;
}) {
  const assetId = device.assetId ?? "";
  const name = device.displayName || device.name || "—";

  const [phase, setPhase] = useState<"form" | "preview">("form");

  // Maintenance types (the "Tipo" dropdown). Fetched once on open; an empty list
  // (Work Orders module disabled server-side) still lets the operator type a title.
  const [types, setTypes] = useState<string[]>([]);
  const [typesLoading, setTypesLoading] = useState(true);
  const [typesError, setTypesError] = useState<string | null>(null);

  // Form fields.
  const [workType, setWorkType] = useState("");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("Medium");
  const [description, setDescription] = useState("");
  // Whether picking a type may overwrite the description: true until the operator
  // edits the description themselves, so their text is never clobbered.
  const descPristine = useRef(true);
  const [start, setStart] = useState(true);

  // The operator opening the order — from the live login session (stamped on the doc).
  const [technician, setTechnician] = useState("");

  const [busy, setBusy] = useState(false);
  // Guards a create/print/save that resolves after the modal unmounts.
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const closeRef = useRef<HTMLButtonElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(true, {
    onEscape: () => { if (!busy) onClose(); },
    initialFocus: closeRef,
  });
  const mouseDownInside = useRef(false);

  useEffect(() => {
    let alive = true;
    setTypesLoading(true); setTypesError(null);
    inventoryAPI
      .getMaintenanceTypes()
      .then((r) => {
        if (!alive) return;
        if (r.ok && Array.isArray(r.data)) setTypes(r.data);
        else setTypesError(r.error ?? "Não foi possível obter os tipos de manutenção.");
      })
      .catch((e) => { if (alive) setTypesError((e as Error)?.message || "Não foi possível obter os tipos de manutenção."); })
      .finally(() => { if (alive) setTypesLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    getAuthStatus().then((s) => { if (alive) setTechnician(s.username || ""); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const typeOptions = useMemo<SelectOption[]>(() => types.map((t) => ({ value: t, label: t })), [types]);

  // Picking a type sets work_type_name, pre-fills the title if still empty, and
  // pre-fills the description from the matching template unless the operator has
  // already edited it.
  const onPickType = (t: string) => {
    setWorkType(t);
    setTitle((cur) => (cur.trim() ? cur : t));
    if (descPristine.current) {
      const tpl = maintenanceTemplates?.[t] ?? "";
      setDescription(tpl);
    }
  };

  const order = useMemo<MaintenanceOrderInfo>(() => ({
    deviceName: name,
    serial: device.serialNumber ?? "",
    category: device.category ?? "",
    assetId,
    ezStatus: device.ezStatus ? ezStatusLabel(device.ezStatus) : "",
    assignedUser: stripDomain(device.assignedUserEmail) || device.assignedUserEmail || "",
    workType,
    priority: priorityLabel(priority),
    description,
    technician,
    dateLabel: todayLabel(),
  }), [name, device.serialNumber, device.category, assetId, device.ezStatus, device.assignedUserEmail, workType, priority, description, technician]);

  const html = useMemo(() => buildMaintenanceHtml(order), [order]);
  const canAdvance = title.trim().length > 0;

  const doSave = async () => {
    if (busy) return;
    setBusy(true);
    const r = await pdfAPI.save(html, maintenanceDocTitle(order));
    if (!mountedRef.current) return;
    setBusy(false);
    if (r.ok) {
      if (r.data?.path) toast?.success("PDF guardado.");
      // canceled (no path) → say nothing.
    } else {
      toast?.error(r.error ?? "Não foi possível guardar o PDF.");
    }
  };

  const doPrint = async () => {
    if (busy) return;
    setBusy(true);
    const r = await pdfAPI.print(html);
    if (!mountedRef.current) return;
    setBusy(false);
    if (r.ok) toast?.success("Ordem enviada para impressão.");
    else toast?.error(r.error ?? "Não foi possível imprimir a ordem.");
  };

  const doConfirm = async () => {
    if (busy || !assetId || !canAdvance) return;
    setBusy(true);
    const r = await inventoryAPI.startMaintenance(assetId, {
      title: title.trim(),
      priority,
      work_type_name: workType || undefined,
      description: description.trim() || undefined,
      asset_name: name,
      start,
    });
    if (!mountedRef.current) return;
    setBusy(false);
    if (r.ok) {
      toast?.success(`Manutenção iniciada para ${name}.`);
      onDone(true);
    } else {
      toast?.error(r.error ?? "Não foi possível iniciar a manutenção.");
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Começar manutenção"
      className="anim-overlay fixed inset-0 z-40 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={(e) => { mouseDownInside.current = e.target !== e.currentTarget; }}
      onMouseUp={(e) => { if (e.target === e.currentTarget && !mouseDownInside.current && !busy) onClose(); }}
    >
      <div
        ref={trapRef}
        tabIndex={-1}
        className="anim-modal bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden focus:outline-none"
      >
        <div className="flex items-center gap-2 px-5 py-4 border-b border-zinc-100">
          <Wrench size={17} className="text-zinc-500" />
          <h2 className="font-semibold text-zinc-800 truncate">Manutenção — {name}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Fechar"
            className={cn("ml-auto p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 transition-colors disabled:opacity-50", focusRing)}
          >
            <X size={16} />
          </button>
        </div>

        {phase === "form" ? (
          <div className="px-5 py-5 space-y-4 overflow-y-auto">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">Tipo de manutenção</label>
              <SearchableSelect
                value={workType}
                onChange={onPickType}
                options={typeOptions}
                placeholder={typesLoading ? "A carregar tipos…" : "Selecionar tipo (opcional)…"}
                searchPlaceholder="Procurar tipo…"
                emptyText={typesError ? "Erro ao carregar" : typesLoading ? "A carregar…" : "Sem tipos configurados"}
                disabled={busy}
              />
              {typesError && <p className="mt-1.5 text-xs text-amber-600">{typesError} Podes continuar e escrever um título.</p>}
            </div>

            <div>
              <label htmlFor="maint-title" className="mb-1 block text-xs font-medium text-zinc-500">Título</label>
              <input
                id="maint-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Ex.: Substituição de ecrã"
                disabled={busy}
                className={cn("w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 placeholder:text-zinc-400 transition-colors focus:border-brand", focusRing)}
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">Prioridade</label>
              <div className="flex flex-wrap gap-1.5">
                {PRIORITIES.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setPriority(p.value)}
                    disabled={busy}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50",
                      focusRing,
                      priority === p.value
                        ? "border-brand bg-violet-50 text-brand"
                        : "border-zinc-200 text-zinc-600 hover:bg-zinc-50",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label htmlFor="maint-desc" className="mb-1 block text-xs font-medium text-zinc-500">Descrição</label>
              <textarea
                id="maint-desc"
                value={description}
                onChange={(e) => { descPristine.current = false; setDescription(e.target.value); }}
                rows={4}
                placeholder="Detalhes da intervenção…"
                disabled={busy}
                className={cn("w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 placeholder:text-zinc-400 transition-colors focus:border-brand", focusRing)}
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-zinc-600">
              <input
                type="checkbox"
                checked={start}
                onChange={(e) => setStart(e.target.checked)}
                disabled={busy}
                className={cn("h-4 w-4 rounded border-zinc-300 accent-violet-600", focusRing)}
              />
              Marcar como em progresso ao criar
            </label>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-hidden bg-zinc-100 px-5 py-4">
            <iframe
              title="Pré-visualização da ordem de manutenção"
              srcDoc={html}
              sandbox=""
              className="h-[58vh] w-full rounded-lg border border-zinc-200 bg-white"
            />
          </div>
        )}

        <div className="flex items-center gap-2 px-5 py-4 border-t border-zinc-100 bg-zinc-50/60">
          {phase === "form" ? (
            <>
              <Button variant="ghost" onClick={onClose} disabled={busy} className="ml-auto">Cancelar</Button>
              <Button onClick={() => setPhase("preview")} disabled={busy || !canAdvance}>Seguinte</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setPhase("form")} disabled={busy}>Voltar</Button>
              <div className="ml-auto flex items-center gap-2">
                <Button variant="secondary" onClick={doSave} disabled={busy}>
                  <FileDown size={14} />
                  Guardar PDF
                </Button>
                <Button variant="secondary" onClick={doPrint} disabled={busy}>
                  <Printer size={14} />
                  Imprimir
                </Button>
                <Button onClick={doConfirm} disabled={busy || !assetId}>
                  <Check size={14} />
                  {busy ? "A iniciar…" : "Confirmar"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
