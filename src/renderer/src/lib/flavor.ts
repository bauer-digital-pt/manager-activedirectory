// Renderer-side flavor resolution. In a packaged app the flavor is baked into
// the bundle (BUILD_FLAVOR); in the browser preview a `?flavor=agent` query param
// lets EITHER UI be previewed from the one dev server without a dedicated build.
import { BUILD_FLAVOR, FLAVOR_META, type AppFlavor } from "../../../shared/flavor";

export type { AppFlavor } from "../../../shared/flavor";
export { FLAVOR_META } from "../../../shared/flavor";

function resolveFlavor(): AppFlavor {
  // Query override applies only in the browser preview (no preload bridge). A
  // packaged app loads dist/index.html with no query, so this never fires there.
  const inBrowser =
    typeof window !== "undefined" &&
    (!window.appAPI || window.appAPI.platform === "browser");
  if (inBrowser && typeof location !== "undefined" && location.search) {
    const q = new URLSearchParams(location.search).get("flavor");
    if (q === "agent" || q === "manager") return q;
  }
  return BUILD_FLAVOR;
}

export const FLAVOR: AppFlavor = resolveFlavor();
export const IS_AGENT = FLAVOR === "agent";
/** Branding for the resolved flavor (productName / eyebrow / short name). */
export const FLAVOR_UI = FLAVOR_META[FLAVOR];
