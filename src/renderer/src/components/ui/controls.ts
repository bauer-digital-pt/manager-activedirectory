// Shared class strings for form controls, so the same text-input styling
// (border, focus ring, placeholder) isn't re-typed in every page. Width is
// baked in as `w-full` — the near-universal case; the rare flex-row input keeps
// its own inline class.
export const inputCls =
  "w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all placeholder:text-zinc-300";
