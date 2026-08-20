// Renderer bridge to the main-process Bluetooth device picker (window.bleAPI).
//
// Web Bluetooth's requestDevice() needs a device chooser, and Electron ships none:
// main handles the `select-bluetooth-device` event, auto-picks a SUPVAN-looking
// device, and — failing that — forwards the growing scan list here so a chooser UI
// can pick/cancel. This module only shuttles those picker/pairing messages; the
// actual GATT connection lives in lib/supvan-webbt.ts, which alone touches
// navigator.bluetooth.
//
// Degrades to no-ops when the bridge is absent (browser mock, or a build without
// the picker wired), so the renderer type-checks and runs without Electron.

/** A device offered by the OS scan, forwarded from main. */
export interface BlePickDevice {
  id: string;
  name: string;
}

/** A pairing prompt forwarded from main (Windows/Linux; macOS auto-pairs). */
export interface BlePairingPrompt {
  /** e.g. "confirm" | "confirmPin" | "providePin" (Electron pairingKind). */
  pairingKind: string;
  deviceId?: string;
  /** Present for confirmPin prompts. */
  pin?: string;
}

declare global {
  interface Window {
    // Electron-only; optional so the browser-mock build type-checks.
    bleAPI?: {
      /** Subscribe to forwarded scan results; returns an unsubscribe fn. */
      onDevices(cb: (list: BlePickDevice[]) => void): () => void;
      /** Resolve the pending requestDevice() with this device id. */
      pick(id: string): void;
      /** Cancel the pending requestDevice() (resolves it with no device). */
      cancel(): void;
      /** Subscribe to pairing prompts; returns an unsubscribe fn. */
      onPairing(cb: (prompt: BlePairingPrompt) => void): () => void;
      /** Answer a pairing prompt. */
      respondPairing(resp: { confirmed: boolean; pin?: string }): void;
    };
  }
}

const noop = (): void => {};

/** True when the main-process BLE picker bridge is present (running in Electron). */
export const isBlePickerAvailable = (): boolean =>
  typeof window !== "undefined" && typeof window.bleAPI !== "undefined";

/** Safe wrapper over window.bleAPI — every method degrades to a no-op when absent. */
export const bleAPI = {
  onDevices: (cb: (list: BlePickDevice[]) => void): (() => void) => window.bleAPI?.onDevices(cb) ?? noop,
  pick: (id: string): void => window.bleAPI?.pick(id),
  cancel: (): void => window.bleAPI?.cancel(),
  onPairing: (cb: (prompt: BlePairingPrompt) => void): (() => void) => window.bleAPI?.onPairing(cb) ?? noop,
  respondPairing: (resp: { confirmed: boolean; pin?: string }): void => window.bleAPI?.respondPairing(resp),
};
