// App flavor — the SAME codebase ships as TWO installers:
//   • "manager" — the full admin app (users, onboarding, settings, console).
//   • "agent"   — a slim per-PC app: login + the device onboarding wizard only.
//
// The flavor is baked at BUILD TIME via a Vite `define` (see vite.config.mts /
// vite.browser.config.mts) that replaces `__APP_FLAVOR__` with the value of the
// APP_FLAVOR env var. When it is unset (dev server, tests, browser preview) it
// defaults to "manager"; the browser preview can still preview the agent UI with
// a `?flavor=agent` query param (resolved in the renderer, see lib/flavor.ts).
//
// Both installers use DISTINCT appIds and SEPARATE auto-update feeds so tagging
// one never pushes it onto the other's fleet — see electron-builder.config.cjs.
export type AppFlavor = "manager" | "agent";

// Injected by the bundler. `declare` keeps TypeScript happy; the `typeof` guard
// below keeps it safe at runtime when the define is absent (an undefined `define`
// leaves a bare identifier, and `typeof <undeclared>` is legal and yields
// "undefined" rather than throwing).
declare const __APP_FLAVOR__: AppFlavor | undefined;

export const BUILD_FLAVOR: AppFlavor =
  (typeof __APP_FLAVOR__ !== "undefined" ? __APP_FLAVOR__ : undefined) || "manager";

export interface FlavorMeta {
  /** productName used for packaging + window/app naming. */
  productName: string;
  /** Short label shown next to the brand mark on the auth/status screens. */
  eyebrow: string;
  /** Short human name (logs, toasts). */
  short: string;
}

export const FLAVOR_META: Record<AppFlavor, FlavorMeta> = {
  manager: { productName: "AD Manager", eyebrow: "AD Manager", short: "Manager" },
  agent: { productName: "AD Agent", eyebrow: "AD Agent", short: "Agent" },
};
