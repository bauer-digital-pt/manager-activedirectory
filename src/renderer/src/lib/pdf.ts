// Renderer-side wrapper over the generic document PDF / print bridge (main's
// pdf:save / pdf:print, backed by ./pdf/render). The renderer builds the finished
// HTML (see lib/maintenancePdf.ts) and asks main to save it as a PDF via the native
// save dialog, or send it to the system printer. In the browser preview — where the
// bridge is absent — every call degrades to a clear "unavailable" PSResult instead
// of throwing, so the modal's Guardar/Imprimir buttons stay exercisable with mocks.
import type { PSResult } from "../../../shared/types";

declare global {
  interface Window {
    pdfAPI?: {
      save(html: string, suggestedName?: string): Promise<PSResult<{ path?: string; canceled?: boolean }>>;
      print(html: string): Promise<PSResult<null>>;
    };
  }
}

const UNAVAILABLE = "Geração de PDF indisponível neste ambiente.";

export const pdfAPI = {
  save: (html: string, suggestedName?: string): Promise<PSResult<{ path?: string; canceled?: boolean }>> =>
    window.pdfAPI?.save(html, suggestedName) ?? Promise.resolve({ ok: false, error: UNAVAILABLE }),
  print: (html: string): Promise<PSResult<null>> =>
    window.pdfAPI?.print(html) ?? Promise.resolve({ ok: false, error: UNAVAILABLE }),
};

/** True when the main-process PDF bridge is present (i.e. running in Electron). */
export const isPdfAvailable = (): boolean => typeof window.pdfAPI !== "undefined";
