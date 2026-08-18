import { Server, Boxes, Layers } from "lucide-react";
import { cn } from "../lib/cn";
import type { DeviceView } from "../App";

// In-page switcher for the three device views (AD / EZOffice / Consolidados),
// shown in the page header instead of a sidebar flyout. Manager + inventory only —
// the caller only renders it when the inventory API is enabled.
const TABS: { view: DeviceView; label: string; icon: React.ElementType }[] = [
  { view: "ad",           label: "AD",           icon: Server },
  { view: "ezoffice",     label: "EZOffice",     icon: Boxes },
  { view: "consolidated", label: "Consolidados", icon: Layers },
];

export default function DeviceViewTabs({
  view,
  onSelect,
}: {
  view: DeviceView;
  onSelect: (view: DeviceView) => void;
}) {
  return (
    <div role="tablist" aria-label="Vista de dispositivos" className="inline-flex items-center gap-0.5 rounded-lg bg-zinc-100 p-0.5">
      {TABS.map(({ view: v, label, icon: Icon }) => {
        const on = v === view;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(v)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              on ? "bg-white text-violet-700 shadow-sm" : "text-zinc-500 hover:text-zinc-800",
            )}
          >
            <Icon size={14} className={on ? "text-violet-600" : "text-zinc-400"} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
