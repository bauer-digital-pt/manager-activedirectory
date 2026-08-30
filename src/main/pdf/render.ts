// Generic HTML -> PDF / printer rendering in a hidden BrowserWindow.
//
// The renderer builds the document HTML (see renderer lib/maintenancePdf.ts) and
// hands the finished string here; this module never knows what a maintenance order
// looks like. Each call spins up an off-screen, script-disabled BrowserWindow,
// loads the HTML from a temp file (loadFile renders local assets and @page CSS more
// reliably than a data: URL), prints it to a PDF buffer or the system printer, and
// always tears the window down.
import { BrowserWindow, app } from "electron";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";

// Monotonic suffix so concurrent renders never collide on the temp filename.
let seq = 0;

async function withHiddenPage<T>(
  html: string,
  fn: (win: BrowserWindow) => Promise<T>,
): Promise<T> {
  const tmp = join(app.getPath("temp"), `admanager-doc-${process.pid}-${++seq}-${Date.now()}.html`);
  await writeFile(tmp, html, "utf8");
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      // Our template is static HTML/CSS with no scripts; keep JS off and isolate it.
      javascript: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  // A print document must never open windows or navigate elsewhere.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  try {
    await win.loadFile(tmp); // resolves once the page has finished loading
    return await fn(win);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await unlink(tmp).catch(() => { /* best-effort temp cleanup */ });
  }
}

// Render the HTML to a PDF and return the raw bytes.
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  return withHiddenPage(html, (win) =>
    win.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      preferCSSPageSize: true,
    }),
  );
}

// Render the HTML and open the system print dialog for it. Resolves when the print
// job is dispatched (or the user cancels the dialog).
export async function printHtml(html: string): Promise<void> {
  return withHiddenPage(html, (win) =>
    new Promise<void>((resolve, reject) => {
      win.webContents.print({ printBackground: true }, (success, failureReason) => {
        // A user-cancelled dialog reports success=false with no real error — treat it
        // as a non-failure so the caller doesn't surface a scary toast for "Cancel".
        if (!success && failureReason && failureReason !== "cancelled") {
          reject(new Error(failureReason));
        } else {
          resolve();
        }
      });
    }),
  );
}
