import { Users, Settings, Terminal } from "lucide-react";
import { cn } from "../lib/cn";
import type { Page } from "../App";
import logo from "../assets/bauer-media-logo.svg";

const NAV: { id: Page; label: string; icon: React.ElementType; bind: string }[] = [
  { id: "users",    label: "Users",    icon: Users,    bind: "1" },
  { id: "settings", label: "Settings", icon: Settings, bind: "2" },
  { id: "console",  label: "Console",  icon: Terminal, bind: "3" },
];

export default function Sidebar({ active, onNavigate }: { active: Page; onNavigate: (p: Page) => void }) {
  return (
    <aside className="w-16 h-full flex flex-col items-center border-r border-zinc-100 bg-white select-none">
      {/* Logo */}
      <div className="py-4 border-b border-zinc-100 w-full flex justify-center">
        <img src={logo} alt="Bauer Media" className="w-9 h-9" />
      </div>

      {/* Nav */}
      <nav className="flex-1 flex flex-col items-center justify-center gap-1 py-4">
        {NAV.map(({ id, label, icon: Icon, bind }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              title={`${label}  [${bind}]`}
              className={cn(
                "w-10 h-10 flex items-center justify-center rounded-lg transition-colors",
                isActive ? "text-white" : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              )}
              style={isActive ? { backgroundColor: "#4700a3" } : undefined}
            >
              <Icon size={20} strokeWidth={isActive ? 2.2 : 1.8} />
            </button>
          );
        })}
      </nav>

      {/* Connected indicator */}
      <div className="pb-4">
        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#1fd1bd" }} title="Connected" />
      </div>
    </aside>
  );
}
