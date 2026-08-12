// Constants shared across main, preload, and renderer.
// Dependency-free so both build contexts can import it.

// Domain controller the app talks to by default (domain: bmap.lis). Pre-filled so
// a fresh install connects out of the box; the user can override it in Settings →
// Connection, and an empty stored value falls back to this. We use the DC's IP
// directly (not the hostname pt-srv-dc02) because some client PCs don't resolve
// the DC hostname via DNS, which broke ADWS connectivity. Used by the main process
// as the fallback server and mirrored by the renderer's browser (dev/mock) fallback.
export const DEFAULT_DC = "10.4.0.12";
