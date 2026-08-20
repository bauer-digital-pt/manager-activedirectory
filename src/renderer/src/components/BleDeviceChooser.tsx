// Global Bluetooth device-chooser + pairing prompt for label printing.
//
// Web Bluetooth's requestDevice() needs a device chooser, and Electron ships none.
// The main process (src/main/ble/picker.ts) AUTO-PICKS the first device whose name
// looks like a SUPVAN printer; this component is the FALLBACK for when that misses
// — the E11 may advertise a MAC-derived name, or nothing matchable (transport/
// config.ts: DEVICE_NAME_RE is a best guess). It also renders the OS pairing PIN
// prompt (Windows/Linux; macOS pairs transparently).
//
// It is mounted once, globally (App.tsx), and stays inert until the main process
// forwards a scan list (`ble:devices`) or a pairing prompt (`ble:pairing`) during a
// live print — i.e. it only appears while a requestDevice() is actually pending.
// In the browser preview (no window.bleAPI) the subscriptions are no-ops and it
// never shows. Everything here is presentation; the GATT connection stays in
// lib/supvan-webbt.ts.
import { useEffect, useRef, useState } from "react";
import { Bluetooth, BluetoothSearching, KeyRound, Loader2, Printer } from "lucide-react";
import { bleAPI, type BlePickDevice, type BlePairingPrompt } from "../lib/ble-bridge";
import { looksLikeSupvan } from "../../../main/supvan/transport/config.ts";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { cn } from "../lib/cn";
import { focusRing } from "./ui/controls";

/** Likely-printer devices first, then by name; unnamed devices last. */
function sortDevices(list: BlePickDevice[]): BlePickDevice[] {
  return [...list].sort((a, b) => {
    const sa = looksLikeSupvan(a.name) ? 0 : 1;
    const sb = looksLikeSupvan(b.name) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const na = a.name || "";
    const nb = b.name || "";
    if (na && !nb) return -1;
    if (!na && nb) return 1;
    return na.localeCompare(nb);
  });
}

export default function BleDeviceChooser() {
  // `devices === null` ⇒ chooser closed. An empty array ⇒ open, still scanning.
  const [devices, setDevices] = useState<BlePickDevice[] | null>(null);
  const [pairing, setPairing] = useState<BlePairingPrompt | null>(null);
  const [pin, setPin] = useState("");
  // Suppress a stray `ble:devices` that main may have sent just before we resolved
  // the request (an in-flight IPC message would otherwise re-open the chooser). A
  // new print is user-initiated, so a short window never blocks a genuine request.
  const closingRef = useRef(false);

  useEffect(() => {
    const offDevices = bleAPI.onDevices((list) => {
      if (closingRef.current) return;
      setDevices(list);
    });
    // Main auto-picked a printer that appeared in a later scan emission — the
    // request is already resolved, so drop the chooser this component opened on the
    // earlier no-match emission (otherwise a stale modal lingers over the print).
    const offClose = bleAPI.onClose(() => setDevices(null));
    const offPairing = bleAPI.onPairing((prompt) => {
      setPin("");
      setPairing(prompt);
    });
    return () => {
      offDevices();
      offClose();
      offPairing();
    };
  }, []);

  const resolveSelection = (fn: () => void) => {
    closingRef.current = true;
    fn();
    setDevices(null);
    window.setTimeout(() => {
      closingRef.current = false;
    }, 500);
  };

  const pick = (id: string) => resolveSelection(() => bleAPI.pick(id));
  const cancel = () => resolveSelection(() => bleAPI.cancel());

  const answerPairing = (confirmed: boolean) => {
    const providePin = pairing?.pairingKind === "providePin";
    bleAPI.respondPairing({ confirmed, pin: providePin ? pin : undefined });
    setPairing(null);
  };

  const sorted = devices ? sortDevices(devices) : [];

  return (
    <>
      {/* Device chooser */}
      <Modal
        open={devices !== null}
        onClose={cancel}
        title={
          <span className="flex items-center gap-2">
            <Bluetooth size={18} className="text-brand" />
            Escolher impressora Bluetooth
          </span>
        }
        className="max-w-md"
      >
        <p className="mt-1 text-sm text-zinc-500">
          Selecione a impressora de etiquetas SUPVAN para continuar a impressão.
        </p>

        <div className="mt-4 max-h-72 overflow-y-auto rounded-xl border border-zinc-100">
          {sorted.length === 0 ? (
            <div className="flex items-center gap-3 px-4 py-6 text-sm text-zinc-500">
              <BluetoothSearching size={18} className="shrink-0 animate-pulse text-brand" />
              À procura de dispositivos Bluetooth…
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {sorted.map((d) => {
                const likely = looksLikeSupvan(d.name);
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => pick(d.id)}
                      className={cn(
                        "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-50",
                        focusRing,
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                          likely ? "bg-brand/10 text-brand" : "bg-zinc-100 text-zinc-400",
                        )}
                      >
                        {likely ? <Printer size={16} /> : <Bluetooth size={16} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium text-zinc-800">
                            {d.name || "(sem nome)"}
                          </span>
                          {likely && (
                            <span className="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
                              provável
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-xs text-zinc-400">{d.id}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-5 flex items-center gap-2">
          {sorted.length > 0 && (
            <span className="mr-auto flex items-center gap-1.5 text-xs text-zinc-400">
              <Loader2 size={13} className="animate-spin" />A procurar mais…
            </span>
          )}
          <Button variant="ghost" onClick={cancel} className="ml-auto">
            Cancelar
          </Button>
        </div>
      </Modal>

      {/* Pairing PIN prompt (rendered after the chooser so it stacks on top). */}
      <Modal
        open={pairing !== null}
        onClose={() => answerPairing(false)}
        title={
          <span className="flex items-center gap-2">
            <KeyRound size={18} className="text-brand" />
            Emparelhar impressora
          </span>
        }
        className="max-w-sm"
      >
        {pairing?.pairingKind === "providePin" ? (
          <>
            <p className="mt-1 text-sm text-zinc-600">
              Introduza o código PIN apresentado na impressora.
            </p>
            <input
              type="text"
              inputMode="numeric"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pin.trim()) answerPairing(true);
              }}
              placeholder="PIN"
              className={cn(
                "mt-4 w-full rounded-lg border border-zinc-200 px-3 py-2 font-mono text-lg tracking-widest text-zinc-800",
                focusRing,
              )}
            />
          </>
        ) : pairing?.pin ? (
          <>
            <p className="mt-1 text-sm text-zinc-600">
              Confirme que este código corresponde ao apresentado na impressora:
            </p>
            <div className="mt-4 rounded-lg bg-zinc-50 py-3 text-center font-mono text-2xl font-semibold tracking-[0.3em] text-zinc-800">
              {pairing.pin}
            </div>
          </>
        ) : (
          <p className="mt-1 text-sm text-zinc-600">
            Confirme o emparelhamento com a impressora para continuar.
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => answerPairing(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => answerPairing(true)}
            disabled={pairing?.pairingKind === "providePin" && !pin.trim()}
          >
            Confirmar
          </Button>
        </div>
      </Modal>
    </>
  );
}
