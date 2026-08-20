// Shared class strings for form controls, so the same text-input styling
// (border, focus ring, placeholder) isn't re-typed in every page. Width is
// baked in as `w-full` — the near-universal case; the rare flex-row input keeps
// its own inline class.
export const inputCls =
  "w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition-all placeholder:text-zinc-400";

// Shared keyboard focus-visible recipe for interactive elements that AREN'T the
// <Button> primitive (nav items, window controls, dropdown options, icon
// buttons). `focusRing` is for light surfaces; `focusRingDark` for the deep
// Bauer-purple OOBE/login backdrops, where a light ring is the only one visible.
// Applied broadly this fixes the app-wide "keyboard focus is invisible" gap.
export const focusRing =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white";
export const focusRingDark =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-deep-purple";
