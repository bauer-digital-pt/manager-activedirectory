import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";
import { useOutsideClick } from "../../hooks/useOutsideClick";

export interface FilterOption {
  value: string;
  label: string;
}

// A compact single-select dropdown used for the Users page filter TYPES
// (OU / Estado / Departamento / Tipo de conta) and the "Ordenar por" control.
// `value === null` means the "all" sentinel (shown as `allLabel`); picking a
// real option tints the trigger violet so active filters are obvious at a glance.
export default function FilterDropdown({
  label,
  value,
  options,
  onChange,
  allLabel = "Todos",
  icon,
  // When false, the reset/"all" row is hidden — used by the always-set sort
  // control, which has no "no sort" state.
  allowAll = true,
  className,
}: {
  label: string;
  value: string | null;
  options: FilterOption[];
  onChange: (next: string | null) => void;
  allLabel?: string;
  icon?: React.ReactNode;
  allowAll?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClick<HTMLDivElement>(open, () => setOpen(false));

  const active = value !== null;
  const selectedLabel = active
    ? options.find((o) => o.value === value)?.label ?? value
    : allLabel;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
          active
            ? "border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100"
            : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50",
          className,
        )}
      >
        {icon && <span className={active ? "text-violet-500" : "text-zinc-400"}>{icon}</span>}
        <span className="text-zinc-400">{label}:</span>
        <span className={active ? "text-violet-700" : "text-zinc-700"}>{selectedLabel}</span>
        <ChevronDown size={13} className={cn("transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="anim-popover absolute left-0 z-30 mt-1 max-h-72 w-52 overflow-y-auto rounded-xl border border-zinc-200 bg-white py-1 shadow-lg">
          {allowAll && (
            <OptionRow
              label={allLabel}
              selected={value === null}
              onClick={() => { onChange(null); setOpen(false); }}
            />
          )}
          {options.map((o) => (
            <OptionRow
              key={o.value}
              label={o.label}
              selected={value === o.value}
              onClick={() => { onChange(o.value); setOpen(false); }}
            />
          ))}
          {options.length === 0 && (
            <p className="px-3 py-2 text-xs text-zinc-400">Sem opções</p>
          )}
        </div>
      )}
    </div>
  );
}

function OptionRow({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors",
        selected ? "text-violet-700" : "text-zinc-700 hover:bg-zinc-50",
      )}
    >
      <span className="truncate">{label}</span>
      {selected && <Check size={14} className="flex-shrink-0 text-violet-500" />}
    </button>
  );
}
