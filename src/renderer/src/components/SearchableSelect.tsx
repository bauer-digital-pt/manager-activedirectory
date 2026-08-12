import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Search, X } from "lucide-react";
import { cn } from "../lib/cn";
import { useOutsideClick } from "../hooks/useOutsideClick";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional dimmed second line (e.g. the username under a display name). */
  sublabel?: string;
}

interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Shown on the trigger when nothing is selected. */
  placeholder?: string;
  searchPlaceholder?: string;
  /** Shown inside the menu when there are no options at all. */
  emptyText?: string;
  disabled?: boolean;
  /** When true, offers a "clear" row that sets the value back to "". */
  clearable?: boolean;
  /** Label for the clear row (e.g. "Sem utilizador-modelo"). */
  clearLabel?: string;
  className?: string;
  /**
   * Async mode. When provided, the component stops filtering `options` locally —
   * the parent owns the results and is notified of each query change (debounce
   * on the parent side). Use `loading` for the spinner and `selectedLabel` so the
   * trigger can still name the current value even when it isn't in `options`.
   */
  onSearch?: (query: string) => void;
  loading?: boolean;
  /** Fallback trigger label for `value` when it isn't among `options` (async mode). */
  selectedLabel?: string;
}

// A self-contained combobox: a trigger button that opens a searchable,
// keyboard-navigable menu. Kept dependency-free so it can be dropped in
// anywhere. Arrow/Enter/Escape are stopped from bubbling so host-level key
// handlers (e.g. the create-user wizard) don't fight the menu.
export default function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Selecionar…",
  searchPlaceholder = "Procurar…",
  emptyText = "Sem opções",
  disabled = false,
  clearable = false,
  clearLabel = "Nenhum",
  className,
  onSearch,
  loading = false,
  selectedLabel,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0); // highlighted index within `rows`
  const listId = useId();
  // Close on outside click while open (ref goes on the root wrapper).
  const rootRef = useOutsideClick<HTMLDivElement>(open, () => setOpen(false));
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const async = !!onSearch;

  // In async mode the current value may not be in the (query-scoped) options, so
  // fall back to the caller-supplied label to keep the trigger from going blank.
  const selected =
    options.find((o) => o.value === value) ??
    (async && value && selectedLabel ? { value, label: selectedLabel } : null);

  // Async mode: the parent already filtered — show options verbatim. Local mode:
  // filter against the in-menu query.
  const filtered = useMemo(() => {
    if (async) return options;
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.sublabel?.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q)
    );
  }, [async, options, query]);

  // Rows include an optional synthetic "clear" row at the top so keyboard nav
  // and click share one index space.
  const rows: { value: string; label: string; sublabel?: string; isClear?: boolean }[] = useMemo(
    () => [
      ...(clearable ? [{ value: "", label: clearLabel, isClear: true }] : []),
      ...filtered,
    ],
    [clearable, clearLabel, filtered]
  );

  // On open: focus the search, reset the query, and highlight the current value.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const idx = rows.findIndex((r) => !r.isClear && r.value === value);
    setActive(idx >= 0 ? idx : 0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the active row within bounds as the filter narrows.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault(); e.stopPropagation();
      if (!open) { setOpen(true); return; }
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault(); e.stopPropagation();
      const row = rows[active];
      if (row) commit(row.value);
    } else if (e.key === "Escape") {
      if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    }
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 text-sm bg-white border rounded-lg text-left transition-all",
          "focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400",
          open ? "border-violet-400 ring-2 ring-violet-500/20" : "border-zinc-200",
          disabled && "opacity-60 cursor-not-allowed"
        )}
      >
        <span
          className={cn(
            "flex-1 truncate",
            selected ? "text-zinc-800" : "text-zinc-400",
            selected && clearable && !disabled && "pr-6"
          )}
        >
          {selected ? selected.label : placeholder}
        </span>
        <ChevronsUpDown size={14} className="flex-shrink-0 text-zinc-400" />
      </button>

      {/* Clear control — a SIBLING of the trigger, not a child: an interactive
          element nested inside a <button> is invalid markup. Overlaid just
          left of the chevron. */}
      {selected && clearable && !disabled && (
        <button
          type="button"
          aria-label="Limpar"
          onClick={(e) => { e.stopPropagation(); commit(""); }}
          className="absolute right-8 top-1/2 -translate-y-1/2 p-0.5 rounded text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
        >
          <X size={13} />
        </button>
      )}

      {open && (
        <div className="absolute z-30 mt-1.5 w-full rounded-xl border border-zinc-200 bg-white shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-100">
            {loading
              ? <Loader2 size={14} className="flex-shrink-0 text-violet-500 animate-spin" />
              : <Search size={14} className="flex-shrink-0 text-zinc-400" />}
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); onSearch?.(e.target.value); }}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={rows[active] ? `${listId}-opt-${active}` : undefined}
              className="flex-1 bg-transparent text-sm text-zinc-800 placeholder:text-zinc-300 focus:outline-none"
            />
          </div>
          <div ref={listRef} id={listId} role="listbox" className="max-h-60 overflow-y-auto py-1">
            {rows.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-zinc-400">
                {loading
                  ? "A procurar…"
                  : async && query.trim().length < 2
                    ? emptyText
                    : options.length === 0
                      ? (async ? "Sem resultados" : emptyText)
                      : "Sem resultados"}
              </div>
            ) : (
              rows.map((row, i) => {
                const isSelected = row.isClear ? value === "" : row.value === value;
                return (
                  <button
                    key={(row.isClear ? "__clear__" : row.value) || `row-${i}`}
                    id={`${listId}-opt-${i}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-idx={i}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => { e.preventDefault(); commit(row.value); }}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
                      i === active ? "bg-violet-50" : "bg-white",
                      row.isClear && "text-zinc-400 italic"
                    )}
                  >
                    <span className="flex-1 min-w-0">
                      <span className={cn("block truncate text-sm", isSelected ? "font-medium text-violet-700" : "text-zinc-800")}>
                        {row.label}
                      </span>
                      {row.sublabel && (
                        <span className="block truncate text-xs text-zinc-400">{row.sublabel}</span>
                      )}
                    </span>
                    {isSelected && <Check size={14} className="flex-shrink-0 text-violet-500" strokeWidth={2.5} />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
