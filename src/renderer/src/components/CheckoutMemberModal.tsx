// Checkout picker for a device's EZOffice asset: choose an EZOffice member and
// assign the asset to them. Built on the shared Modal (focus trap + dialog
// semantics); the member list is fetched once on open and filtered locally by the
// SearchableSelect (the tenant's member count is small enough for a client-side
// combobox). On success it toasts and calls onDone with the chosen member's email so
// the parent can patch the row in place (checkout sets the asset "in use" + holder) —
// a full refetch would return the pre-write state (the /assets read is SWR-cached).
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import SearchableSelect, { type SelectOption } from "./SearchableSelect";
import { inventoryAPI, type InventoryMember } from "../inventoryAPI";
import { type ConsolidatedDevice } from "../lib/devices";

interface Props {
  device: ConsolidatedDevice;
  toast?: { success: (m: string) => void; error: (m: string) => void };
  onClose: () => void;
  /** Fired after a successful checkout with the chosen member's email, so the list
   * can patch the row in place (status → "in use", holder → this email). */
  onDone: (memberEmail: string) => void;
}

export default function CheckoutMemberModal({ device, toast, onClose, onDone }: Props) {
  const [members, setMembers] = useState<InventoryMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [memberId, setMemberId] = useState("");
  const [busy, setBusy] = useState(false);
  // Guards a checkout that resolves after the modal unmounts (Escape / navigation).
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // Fetch members once on open; the picker filters the (active-only) list locally.
  useEffect(() => {
    let alive = true;
    setLoading(true); setLoadError(null);
    inventoryAPI
      .getMembers()
      .then((r) => {
        if (!alive) return;
        if (r.ok && Array.isArray(r.data)) setMembers(r.data.filter((m) => m.active));
        else setLoadError(r.error ?? "Não foi possível obter os utilizadores do EZOffice.");
      })
      .catch((e) => { if (alive) setLoadError((e as Error)?.message || "Não foi possível obter os utilizadores do EZOffice."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const options = useMemo<SelectOption[]>(
    () => members.map((m) => ({
      value: m.member_id,
      label: m.full_name || m.email || m.member_id,
      sublabel: [m.email, m.department].filter(Boolean).join(" · ") || undefined,
    })),
    [members],
  );

  const assetId = device.assetId ?? "";
  const name = device.displayName || device.name || "—";

  const doCheckout = async () => {
    if (!memberId || busy) return;
    setBusy(true);
    const r = await inventoryAPI.checkout(assetId, memberId);
    if (!mountedRef.current) return;
    setBusy(false);
    if (r.ok) {
      const who = members.find((m) => m.member_id === memberId);
      toast?.success(`${name} atribuído a ${who?.full_name || who?.email || "utilizador"}`);
      // Hand the holder's email back so the list can reflect the new custody without
      // a refetch (the /assets read is SWR-cached and would return the pre-write row).
      onDone(who?.email ?? "");
    } else {
      toast?.error(r.error ?? "Não foi possível fazer checkout do ativo.");
    }
  };

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title="Fazer checkout"
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
    >
      <p className="mt-1 text-sm text-zinc-500">
        Atribuir <span className="font-medium text-zinc-700">{name}</span> a um utilizador do EZOffice.
      </p>

      <div className="mt-4">
        <label className="mb-1 block text-xs font-medium text-zinc-500">Utilizador</label>
        <SearchableSelect
          value={memberId}
          onChange={setMemberId}
          options={options}
          placeholder={loading ? "A carregar utilizadores…" : "Selecionar utilizador…"}
          searchPlaceholder="Procurar por nome, email ou departamento…"
          emptyText={loadError ? "Erro ao carregar" : loading ? "A carregar…" : "Sem utilizadores"}
          disabled={busy || loading || !!loadError}
        />
        {loadError && <p className="mt-1.5 text-xs text-red-600">{loadError}</p>}
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button variant="primary" onClick={doCheckout} disabled={busy || !memberId}>
          {busy ? "A atribuir…" : "Fazer checkout"}
        </Button>
      </div>
    </Modal>
  );
}
