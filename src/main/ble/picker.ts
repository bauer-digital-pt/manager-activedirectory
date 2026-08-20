/**
 * Main-process Bluetooth device picker for Web Bluetooth label printing.
 *
 * `navigator.bluetooth` lives in the RENDERER (see src/renderer/src/lib/supvan-
 * webbt.ts), but Electron ships no device chooser: when the renderer calls
 * requestDevice(), the main process must handle `select-bluetooth-device` and
 * drive the callback, or Chromium auto-cancels the request with NotFoundError.
 *
 * Strategy: prevent the default (mandatory), then auto-pick the first device whose
 * advertised name looks like a SUPVAN printer; if none matches yet, forward the
 * growing scan list to the renderer (`ble:devices`) so a chooser UI can pick one
 * (`ble:pick`) or cancel (`ble:cancel`). Pairing PIN prompts (Windows/Linux;
 * macOS auto-pairs) are forwarded via `ble:pairing` / answered via
 * `ble:pairing-response`.
 *
 * This is the ONLY Bluetooth code in main; it is isolated here so main.ts needs a
 * single import + a single `wireBluetooth(win)` call (mirroring registerPrintIpc).
 * Harmless for the Agent flavor: nothing fires unless the renderer actually calls
 * navigator.bluetooth.requestDevice(), which only the Manager's label-print path does.
 *
 * TODO(bring-up, 13:00 hardware): once the real E11 advertised name is known,
 * DEVICE_NAME_RE (transport/config.ts) may need widening/narrowing; if the E11
 * advertises nothing matchable, the manual chooser path already covers it.
 */
import { ipcMain, type BrowserWindow, type WebContents } from "electron";
import { DEVICE_NAME_RE } from "../supvan/transport/config.ts";

interface ForwardedDevice {
  id: string;
  name: string;
}

/**
 * Wire the Bluetooth device-picker + pairing bridge onto a window. Call once, for
 * the MAIN window only (the console window must not double-register the global
 * ipcMain listeners). Listeners are torn down when the window is destroyed.
 */
export function wireBluetooth(win: BrowserWindow): void {
  const wc: WebContents = win.webContents;

  // The pending requestDevice() callbacks. Only one request is expected at a time
  // (one print at a time); a new request overwrites any stale callback.
  let selectCallback: ((deviceId: string) => void) | null = null;
  let pairingCallback: ((response: { confirmed: boolean; pin?: string }) => void) | null = null;

  wc.on("select-bluetooth-device", (event, deviceList, callback) => {
    // REQUIRED: without preventDefault, Electron cancels the request immediately.
    event.preventDefault();
    selectCallback = callback;

    // Auto-pick the first SUPVAN-looking device.
    const hit = deviceList.find((d) => DEVICE_NAME_RE.test(d.deviceName ?? ""));
    if (hit) {
      selectCallback = null;
      callback(hit.deviceId);
      return;
    }

    // Otherwise forward the (growing) scan list so the renderer can choose. This
    // event fires repeatedly as more devices are discovered; each call refreshes
    // the list and the latest callback.
    const forwarded: ForwardedDevice[] = deviceList.map((d) => ({
      id: d.deviceId,
      name: d.deviceName ?? "",
    }));
    if (!wc.isDestroyed()) wc.send("ble:devices", forwarded);
  });

  // Pairing PIN handler (Windows/Linux; macOS pairs transparently). Guarded with
  // ?. because the API is not present on every platform/Electron build.
  wc.session.setBluetoothPairingHandler?.((details, callback) => {
    pairingCallback = callback;
    if (!wc.isDestroyed()) {
      wc.send("ble:pairing", {
        pairingKind: details.pairingKind,
        deviceId: details.deviceId,
        pin: details.pin,
      });
    }
  });

  const onPick = (_e: unknown, id: unknown): void => {
    const cb = selectCallback;
    selectCallback = null;
    if (cb) cb(typeof id === "string" ? id : "");
  };
  const onCancel = (): void => {
    const cb = selectCallback;
    selectCallback = null;
    // Empty string cancels the request (resolves requestDevice with no device).
    if (cb) cb("");
  };
  const onPairingResponse = (_e: unknown, resp: unknown): void => {
    const cb = pairingCallback;
    pairingCallback = null;
    const r = (resp ?? {}) as { confirmed?: boolean; pin?: string };
    if (cb) cb({ confirmed: !!r.confirmed, pin: r.pin });
  };

  ipcMain.on("ble:pick", onPick);
  ipcMain.on("ble:cancel", onCancel);
  ipcMain.on("ble:pairing-response", onPairingResponse);

  // Detach the global ipcMain listeners with the window so a recreate/reload does
  // not stack duplicates.
  wc.on("destroyed", () => {
    ipcMain.removeListener("ble:pick", onPick);
    ipcMain.removeListener("ble:cancel", onCancel);
    ipcMain.removeListener("ble:pairing-response", onPairingResponse);
  });
}
