// Batch label print dialog — one BLE connection, many SUPVAN E11 labels.
//
// Two phases:
//   1. PREPARE — resolve every selected device's QR payload UP FRONT (the coded
//      EZOffice link is rate-limited and async, and the connect gesture below can
//      have no prior await). Each device shows resolving → QR / URL / no-QR.
//   2. PRINT   — one "Imprimir N etiquetas" gesture connects once and streams every
//      label through runPrintJob, with a live per-device progress list + Abort.
//
// Devices with no coded link still print (QR-less or with the Settings template) —
// they are valid batch items, never failures. A per-label print failure is skipped
// and the batch continues; the footer shows a printed-vs-failed summary at the end.
import { useEffect, useRef, useState, useCallback } from "react";
import { Printer, X, CheckCircle2, XCircle, Loader2, QrCode, Ban, Link2 } from "lucide-react";
import type { ConsolidatedDevice } from "../lib/devices";
import { applyUrlTemplate } from "../lib/devices";
import { inventoryAPI } from "../inventoryAPI";
import {
  BATCH_CANCELLED,
  buildLabelModel,
  getLabelEncoder,
  printLabelsViaBle,
  transportMode,
  type BatchLabelPrintResult,
  type LabelPrintRequest,
} from "../lib/printing";
import type { PrintEvent } from "../../../main/supvan/pipeline.ts";
import { cn } from "../lib/cn";
import { Button } from "./ui/Button";
import { focusRing } from "./ui/controls";
import { useFocusTrap } from "../hooks/useFocusTrap";

type Toast = { success: (m: string) => void; error: (m: string) => void };

// How a device's QR payload was resolved (drives the prepare-phase chip).
type QrOutcome = "loading" | "coded" | "template" | "none";
interface Prep {
  outcome: QrOutcome;
  /** The label QR payload: a coded link, the Settings template, or "" (QR-less). */
  payload: string;
}

// Per-device print progress (drives the print-phase row state).
type ItemStatus = "pending" | "printing" | "done" | "failed" | "cancelled";
interface ItemProgress {
  status: ItemStatus;
  note?: string;
  error?: string;
}

const etq = (n: number) => (n === 1 ? "etiqueta" : "etiquetas");

// PrintEvent → a short PT progress note for the row.
function phaseLabel(e: PrintEvent): string {
  switch (e.phase) {
    case "check-device": return "A verificar impressora…";
    case "wait-ready":   return "A preparar…";
    case "start-print":  return "A iniciar…";
    case "transfer":     return `A enviar dados… (${e.packet}/${e.total})`;
    case "wait-printing":
    case "wait-buffer":
    case "buf-full":
    case "wait-complete": return "A imprimir…";
    case "done":         return "Concluído";
    default:             return "A imprimir…";
  }
}

export default function BatchLabelPrintModal({
  devices,
  ezofficeTemplate,
  toast,
  onClose,
}: {
  /** The selected devices to print, snapshotted on open. */
  devices: ConsolidatedDevice[];
  /** Settings EZOffice URL template (…/a/{id}) — a code-less QR fallback per device. */
  ezofficeTemplate?: string;
  toast?: Toast;
  onClose: () => void;
}) {
  // Snapshot the selection on mount: the parent rebuilds the array on every render,
  // and a batch is a point-in-time set — so we never re-resolve mid-flight.
  const [list] = useState(devices);
  const template = (ezofficeTemplate ?? "").trim();

  // The Settings-template payload for a device (…/a/{id}); "" when it can't fill.
  const templatePayload = useCallback(
    (d: ConsolidatedDevice): string =>
      applyUrlTemplate(template, { name: d.name, serial: d.serialNumber, id: d.assetId }) ?? "",
    [template],
  );

  // Resolve what we can synchronously; assets with an id but no coded link are
  // fetched below. Precedence mirrors LabelPreviewModal: coded link > template > none.
  const [preps, setPreps] = useState<Prep[]>(() =>
    list.map((d) => {
      const known = (d.qrUrl ?? "").trim();
      if (known) return { outcome: "coded", payload: known };
      if (d.assetId) return { outcome: "loading", payload: "" };
      const tpl = applyUrlTemplate(template, { name: d.name, serial: d.serialNumber, id: d.assetId }) ?? "";
      return { outcome: tpl ? "template" : "none", payload: tpl };
    }),
  );

  const [printing, setPrinting] = useState(false);
  const [done, setDone] = useState(false);
  const [progress, setProgress] = useState<Record<number, ItemProgress>>({});
  const [summary, setSummary] = useState<BatchLabelPrintResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const printRef = useRef<HTMLButtonElement>(null);
  const mouseDownInside = useRef(false);

  const resolving = preps.some((p) => p.outcome === "loading");
  const unavailable = transportMode() === "none";
  const canClose = !printing;

  // Fetch the coded public link for each asset that needs one (sequential — the
  // EZOffice endpoint is rate-limited; a QR-less/template fallback on failure).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        const known = (d.qrUrl ?? "").trim();
        if (known || !d.assetId) continue; // already resolved synchronously
        let next: Prep;
        try {
          const r = await inventoryAPI.getAssetPublicLink(d.assetId);
          const url = r.ok && r.data ? (r.data.qr_url ?? "").trim() : "";
          if (url) next = { outcome: "coded", payload: url };
          else {
            const tpl = templatePayload(d);
            next = { outcome: tpl ? "template" : "none", payload: tpl };
          }
        } catch {
          const tpl = templatePayload(d);
          next = { outcome: tpl ? "template" : "none", payload: tpl };
        }
        if (cancelled) return;
        setPreps((prev) => prev.map((p, idx) => (idx === i ? next : p)));
      }
    })();
    return () => { cancelled = true; };
  }, [list, templatePayload]);

  // Counts for the prepare-phase summary line.
  const withQr = preps.filter((p) => p.outcome === "coded").length;
  const withTemplate = preps.filter((p) => p.outcome === "template").length;
  const noQr = preps.filter((p) => p.outcome === "none").length;

  // START PRINT. GESTURE-CRITICAL: nothing may await before printLabelsViaBle — its
  // prelude (build all jobs) is synchronous so requestDevice() stays in the gesture.
  const doPrint = () => {
    if (printing || resolving || unavailable || list.length === 0) return;
    const encode = getLabelEncoder();
    if (!encode) {
      // Defensive: main.tsx registers the LZMA-alone encoder at startup.
      console.warn("[label] Web Bluetooth ready but no LZMA-alone encoder registered (see main.tsx).");
      toast?.error("A impressão por Bluetooth ainda não está disponível nesta versão.");
      return;
    }
    const reqs: LabelPrintRequest[] = list.map((d, i) => ({
      model: buildLabelModel(d, preps[i].payload),
      meta: { assetId: d.assetId, serial: d.serialNumber, name: d.displayName || d.name },
    }));

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPrinting(true);
    setDone(false);
    setSummary(null);
    setProgress(Object.fromEntries(list.map((_, i) => [i, { status: "pending" } as ItemProgress])));

    void printLabelsViaBle(reqs, encode, {
      signal: ctrl.signal,
      onItemEvent: (index, event) =>
        setProgress((prev) => ({ ...prev, [index]: { status: "printing", note: phaseLabel(event) } })),
      onItemSettled: (r) =>
        setProgress((prev) => ({
          ...prev,
          [r.index]: r.ok
            ? { status: "done" }
            : { status: r.error === BATCH_CANCELLED ? "cancelled" : "failed", error: r.error },
        })),
    }).then((res) => {
      abortRef.current = null;
      setPrinting(false);
      setDone(true);
      setSummary(res);
      // Authoritative final state (covers a connection failure that never settled
      // the buildable jobs — those stay "pending" without this reconcile).
      setProgress(() => {
        const next: Record<number, ItemProgress> = {};
        for (let i = 0; i < list.length; i++) next[i] = { status: res.ok ? "cancelled" : "failed" };
        for (const it of res.items)
          next[it.index] = it.ok
            ? { status: "done" }
            : { status: it.error === BATCH_CANCELLED ? "cancelled" : "failed", error: it.error };
        return next;
      });
      if (!res.ok) { toast?.error(res.error || "Não foi possível imprimir as etiquetas."); return; }
      const printed = res.items.filter((i) => i.ok).length;
      const cancelled = res.items.filter((i) => !i.ok && i.error === BATCH_CANCELLED).length;
      const failed = res.items.length - printed - cancelled;
      if (failed === 0 && cancelled === 0) toast?.success(`${printed} ${etq(printed)} enviada${printed === 1 ? "" : "s"} para impressão.`);
      else if (printed === 0 && failed === 0) toast?.error("Impressão cancelada.");
      else toast?.error(`${printed} ${etq(printed)} impressa${printed === 1 ? "" : "s"}, ${failed + cancelled} por imprimir.`);
    });
  };

  const trapRef = useFocusTrap<HTMLDivElement>(true, {
    onEscape: canClose ? onClose : undefined,
    onEnter: () => { if (!printing && !done) doPrint(); },
    initialFocus: printRef,
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Impressão de etiquetas em série"
      className="anim-overlay fixed inset-0 z-40 bg-black/30 backdrop-blur-sm flex items-center justify-center"
      onMouseDown={(e) => { mouseDownInside.current = e.target !== e.currentTarget; }}
      onMouseUp={(e) => { if (canClose && e.target === e.currentTarget && !mouseDownInside.current) onClose(); }}
    >
      <div
        ref={trapRef}
        tabIndex={-1}
        className="anim-modal bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 overflow-hidden focus:outline-none"
      >
        <div className="flex items-center gap-2 px-5 py-4 border-b border-zinc-100">
          <Printer size={17} className="text-zinc-500" />
          <h2 className="font-semibold text-zinc-800">
            Imprimir {list.length} {etq(list.length)}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={!canClose}
            aria-label="Fechar"
            className={cn(
              "ml-auto p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
              focusRing,
            )}
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4">
          <ul className="max-h-[52vh] overflow-y-auto rounded-xl border border-zinc-100 divide-y divide-zinc-50">
            {list.map((d, i) => (
              <li key={d.key} className="flex items-center gap-3 px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-zinc-800 truncate">{d.displayName || d.name}</p>
                  <p className="text-xs text-zinc-400 truncate">
                    {d.serialNumber ? `SN ${d.serialNumber}` : d.assetId ? `EZ ${d.assetId}` : "—"}
                  </p>
                </div>
                <StatusChip
                  printing={printing || done}
                  prep={preps[i]}
                  progress={progress[i]}
                />
              </li>
            ))}
          </ul>

          {!printing && !done && (
            <p className="mt-3 text-center text-xs text-zinc-500">
              {resolving ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" />
                  A obter os URLs dos ativos do EZOffice…
                </span>
              ) : (
                <>
                  {withQr > 0 && <>{withQr} com QR</>}
                  {withTemplate > 0 && <>{withQr > 0 ? " · " : ""}{withTemplate} com URL configurado</>}
                  {noQr > 0 && <>{withQr > 0 || withTemplate > 0 ? " · " : ""}{noQr} sem QR</>}
                </>
              )}
            </p>
          )}

          {done && summary && <FinalSummary summary={summary} />}
        </div>

        <div className="flex items-center gap-2 px-5 py-4 border-t border-zinc-100 bg-zinc-50/60">
          {unavailable && !printing && (
            <span role="status" className="mr-auto text-xs text-amber-600">
              Impressão indisponível neste ambiente (sem transporte Bluetooth).
            </span>
          )}
          {printing ? (
            <Button variant="danger" onClick={() => abortRef.current?.abort()} className="ml-auto">
              <Ban size={14} />
              Cancelar impressão
            </Button>
          ) : done ? (
            <Button onClick={onClose} className="ml-auto">Fechar</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} className="ml-auto">Cancelar</Button>
              <Button
                ref={printRef}
                onClick={doPrint}
                disabled={resolving || unavailable || list.length === 0}
              >
                <Printer size={14} />
                {resolving ? "A obter URLs…" : `Imprimir ${list.length} ${etq(list.length)}`}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

// The right-side status chip: QR-resolution outcome before printing, live/final
// print state during and after.
function StatusChip({ printing, prep, progress }: {
  printing: boolean;
  prep: Prep;
  progress?: ItemProgress;
}) {
  if (printing && progress) {
    switch (progress.status) {
      case "printing":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs text-brand">
            <Loader2 size={13} className="animate-spin" />
            {progress.note ?? "A imprimir…"}
          </span>
        );
      case "done":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600">
            <CheckCircle2 size={13} /> Impressa
          </span>
        );
      case "failed":
        return (
          <span title={progress.error} className="inline-flex items-center gap-1.5 text-xs text-red-600">
            <XCircle size={13} /> Falhou
          </span>
        );
      case "cancelled":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
            <Ban size={13} /> Cancelada
          </span>
        );
      default:
        return <span className="text-xs text-zinc-400">Em espera…</span>;
    }
  }

  // Prepare phase — what will go in the QR.
  switch (prep.outcome) {
    case "loading":
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
          <Loader2 size={13} className="animate-spin" /> A obter QR…
        </span>
      );
    case "coded":
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600">
          <QrCode size={13} /> QR
        </span>
      );
    case "template":
      return (
        <span title="URL configurado em Definições (sem código público)" className="inline-flex items-center gap-1.5 text-xs text-amber-600">
          <Link2 size={13} /> URL config.
        </span>
      );
    default:
      return (
        <span title="Sem ativo/QR — a etiqueta é impressa sem QR" className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
          <QrCode size={13} className="opacity-40" /> Sem QR
        </span>
      );
  }
}

// Post-run tally under the list.
function FinalSummary({ summary }: { summary: BatchLabelPrintResult }) {
  if (!summary.ok) {
    return (
      <p role="alert" className="mt-3 text-center text-xs text-red-600 break-words">
        {summary.error || "Não foi possível ligar à impressora."}
      </p>
    );
  }
  const printed = summary.items.filter((i) => i.ok).length;
  const cancelled = summary.items.filter((i) => !i.ok && i.error === BATCH_CANCELLED).length;
  const failed = summary.items.length - printed - cancelled;
  return (
    <p role="status" className="mt-3 text-center text-xs text-zinc-500">
      <span className="text-emerald-600 font-medium">{printed} {etq(printed)}</span> impressa{printed === 1 ? "" : "s"}
      {failed > 0 && <> · <span className="text-red-600 font-medium">{failed}</span> falhada{failed === 1 ? "" : "s"}</>}
      {cancelled > 0 && <> · <span className="text-zinc-500 font-medium">{cancelled}</span> cancelada{cancelled === 1 ? "" : "s"}</>}
    </p>
  );
}
