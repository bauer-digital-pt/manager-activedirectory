/**
 * Main-process IPC surface for SUPVAN E11 label printing.
 *
 * This is the ONLY supvan module that runs exclusively in the main process — the
 * rest of the core is isomorphic (pure, dep-free) and also runs in the renderer
 * preview and in `node --test`. Registration is isolated here (rather than inline
 * in main.ts) so main.ts needs a single import + a single call, keeping it clear
 * of the unrelated in-flight edits there.
 *
 * PHASE 4 status: the label pipeline is real — `print:label` re-renders the model
 * with the shared core and maps it onto the default printhead, proving the model
 * round-trips through IPC and the raster is feasible. But the actual bytes → BLE →
 * E11 transport (and the LZMA-alone backend choice) land in Phase 3/5 with the
 * hardware, so the handler reports an honest "not yet available" instead of
 * pretending to print. `print:list-devices` returns an empty list for the same
 * reason. Nothing here fabricates success.
 */
import { renderLabel, labelToColumnMajor, type LabelModel, type LabelStyle } from "./label.ts";
import { DEFAULT_GEOMETRY } from "./job.ts";

/** Mirrors src/shared/types.ts PSResult — kept local to avoid a cross-tree import. */
interface PSResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Mirrors the renderer's PrintDeviceInfo (lib/printing.ts) for the picker. */
interface PrintDeviceInfo {
  id: string;
  name: string;
  kind?: string;
}

/** The request shape the renderer sends over `print:label` (lib/printing.ts). */
interface LabelPrintRequest {
  model: LabelModel;
  style?: LabelStyle;
  meta?: { assetId?: string; serial?: string; name?: string };
}

/**
 * Structural type of main.ts's logging `handle()` wrapper. Declared loosely
 * (event: unknown) so this module carries no Electron dependency; main.ts's
 * concrete `handle` is assignable to it.
 */
type IpcHandle = (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void;

/** Register the print IPC channels against main.ts's logging `handle` wrapper. */
export function registerPrintIpc(handle: IpcHandle): void {
  // Enumerate printers. Bluetooth discovery is not wired yet (Phase 3), so this
  // honestly reports "none found" rather than inventing a device.
  handle("print:list-devices", async (): Promise<PSResult<PrintDeviceInfo[]>> => {
    return { ok: true, data: [] };
  });

  // Compose + validate the label in main (proving the shared render is identical
  // to the renderer preview and that it fits the printhead), then decline: the
  // transport lands in Phase 3. The composed dimensions go into the message so
  // the round-trip is observable end-to-end.
  handle("print:label", async (_event, req): Promise<PSResult<never>> => {
    const request = req as LabelPrintRequest | undefined;
    if (!request || !request.model || typeof request.model.qr !== "string") {
      return { ok: false, error: "Pedido de impressão inválido." };
    }
    try {
      const render = renderLabel(request.model, request.style ?? {});
      // Throws if the label is wider than the printhead after rotation — surfacing
      // an unprintable label now, not at the hardware bring-up.
      labelToColumnMajor(render, DEFAULT_GEOMETRY, {});
      return {
        ok: false,
        error:
          `Etiqueta composta (${render.width}×${render.height} pts, QR v${render.qr.version}), ` +
          `mas a impressão Bluetooth ainda não está disponível (Fase 3 — chega com o hardware).`,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
}
