// Biometric presence check (Touch ID / Windows Hello) bridge.
//
// Used to unlock a SOFT lock or pass the kiosk re-auth gate without re-typing the
// password. In Electron biometricAPI (preload) talks to the OS: macOS Touch ID via
// systemPreferences, Windows Hello via a WinRT helper script. In the browser
// (dev/mock) it's absent, so biometrics simply report unavailable and the UI falls
// back to the password field.
//
// A biometric proves the operator is PHYSICALLY PRESENT, not that they know the
// password — so it's only ever offered while a session is alive (soft lock / kiosk
// gate), never for a full login. The main process enforces the same (no session →
// refused).

export type BiometricKind = "touchid" | "windows-hello" | null;

export interface BiometricInfo {
  available: boolean;
  kind: BiometricKind;
}

declare global {
  interface Window {
    biometricAPI?: {
      available(): Promise<{ ok: boolean; available: boolean; kind: BiometricKind; error?: string }>;
      prompt(reason: string): Promise<{ ok: boolean; error?: string }>;
    };
  }
}

export function biometricLabel(kind: BiometricKind): string {
  if (kind === "touchid") return "Touch ID";
  if (kind === "windows-hello") return "Windows Hello";
  return "Biometria";
}

// Whether the OS can prompt right now (device present + configured for this user).
// Never throws — an absent bridge or an OS error reads as "unavailable".
export async function getBiometricInfo(): Promise<BiometricInfo> {
  try {
    if (window.biometricAPI?.available) {
      const r = await window.biometricAPI.available();
      return { available: !!r.available, kind: r.kind ?? null };
    }
  } catch { /* fall through */ }
  return { available: false, kind: null };
}

// Show the OS biometric prompt. Resolves ok=true only on a successful match.
export async function biometricPrompt(reason: string): Promise<{ ok: boolean; error?: string }> {
  if (!window.biometricAPI?.prompt) return { ok: false, error: "Biometria indisponível." };
  try {
    return await window.biometricAPI.prompt(reason);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Verificação biométrica cancelada." };
  }
}
