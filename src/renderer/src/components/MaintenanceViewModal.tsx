// Read-only view of a device asset's current open maintenance work order. Shown by
// the "Ver manutenção" action when the asset is already flagged in maintenance. It
// fetches the authoritative per-asset work order on open (the list only carries a
// heuristic in_maintenance flag) and renders whatever fields EZOffice returns; the
// shape is loose, so it degrades to what's present. No writes — closing maintenance
// is deliberately left to EZOffice itself (we never call mark_complete).
import { useEffect, useState } from "react";
import { Wrench } from "lucide-react";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { inventoryAPI } from "../inventoryAPI";
import type { ConsolidatedDevice } from "../lib/devices";
import type { MaintenanceWorkOrder } from "../inventoryAPI";

export default function MaintenanceViewModal({
  device,
  onClose,
}: {
  device: ConsolidatedDevice;
  onClose: () => void;
}) {
  const assetId = device.assetId ?? "";
  const name = device.displayName || device.name || "—";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wo, setWo] = useState<MaintenanceWorkOrder | null>(null);
  const [ongoing, setOngoing] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    inventoryAPI
      .getMaintenance(assetId)
      .then((r) => {
        if (!alive) return;
        if (r.ok && r.data) { setWo(r.data.work_order); setOngoing(r.data.ongoing); }
        else setError(r.error ?? "Não foi possível obter a manutenção do ativo.");
      })
      .catch((e) => { if (alive) setError((e as Error)?.message || "Não foi possível obter a manutenção do ativo."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [assetId]);

  const state = wo?.state || wo?.status || "";
  const rows: Array<[string, string]> = wo
    ? [
        ["Título", String(wo.title ?? "—")],
        ["Estado", state || "—"],
        ["Prioridade", String(wo.priority ?? "—")],
        ["Aberta em", String(wo.created_on ?? "—")],
        ["Referência", wo.id != null ? String(wo.id) : "—"],
      ]
    : [];

  return (
    <Modal open onClose={onClose} title={<span className="flex items-center gap-2"><Wrench size={16} className="text-zinc-500" />Manutenção — {name}</span>}>
      <div className="mt-3">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-9 rounded-lg bg-zinc-100 animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <p role="alert" className="text-sm text-red-600">{error}</p>
        ) : !ongoing || !wo ? (
          <p className="text-sm text-zinc-500">Este ativo já não tem manutenção em curso.</p>
        ) : (
          <>
            <div className="rounded-xl border border-zinc-100 divide-y divide-zinc-50 overflow-hidden">
              {rows.map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-4 px-4 py-2.5">
                  <span className="flex-shrink-0 pt-0.5 text-xs text-zinc-400">{k}</span>
                  <span className="break-all text-right text-sm text-zinc-800">{v}</span>
                </div>
              ))}
            </div>
            {wo.description ? (
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium text-zinc-500">Descrição</p>
                <p className="whitespace-pre-wrap rounded-lg border border-zinc-100 bg-zinc-50/60 px-3 py-2 text-sm text-zinc-700">
                  {String(wo.description)}
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="mt-6 flex justify-end">
        <Button variant="secondary" onClick={onClose}>Fechar</Button>
      </div>
    </Modal>
  );
}
