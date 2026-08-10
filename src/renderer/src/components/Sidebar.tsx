import { Users, Settings, Terminal, User } from "lucide-react";
import { cn } from "../lib/cn";
import type { Page } from "../App";
import { initials } from "../lib/initials";
import logo from "../assets/bauer-media-logo.svg";

const NAV: { id: Page; label: string; icon: React.ElementType; bind: string; dev?: boolean }[] = [
  { id: "users",    label: "Users",    icon: Users,    bind: "1" },
  { id: "settings", label: "Settings", icon: Settings, bind: "2" },
  { id: "console",  label: "Console",  icon: Terminal, bind: "3", dev: true },
];

interface SidebarProps {
  active: Page;
  onNavigate: (p: Page) => void;
  /** Console is only reachable when developer mode is on. */
  devMode: boolean;
  /** Logged-in user (display name preferred) — drives the avatar initials. */
  userName: string;
  /** Live connection state: true=up, false=down/timeout, null=checking. */
  connOk: boolean | null;
}

export default function Sidebar({ active, onNavigate, devMode, userName, connOk }: SidebarProps) {
  const nav = NAV.filter((n) => !n.dev || devMode);
  const inits = initials(userName);

  const dotColor = connOk === false ? "#ef4444" : connOk === true ? "#1fd1bd" : "#f59e0b";
  const dotTitle = connOk === false ? "Sem ligação ao AD" : connOk === true ? "Ligado ao AD" : "A verificar ligação…";

  return (
    <aside className="w-16 h-full flex flex-col items-center border-r border-zinc-100 bg-white select-none">
      {/* Logo */}
      <div className="py-4 border-b border-zinc-100 w-full flex justify-center">
        <img src={logo} alt="Bauer Media" className="w-9 h-9" />
      </div>

      {/* Nav */}
      <nav className="flex-1 flex flex-col items-center justify-center gap-1 py-4">
        {nav.map(({ id, label, icon: Icon, bind }) => {
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

      {/* User avatar + live connection status */}
      <div className="pb-4">
        <div
          className="relative w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-semibold"
          style={{ backgroundColor: "#4700a3" }}
          title={`${userName || "Utilizador"} — ${dotTitle}`}
        >
          {inits || <User size={16} />}
          <span
            className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white"
            style={{ backgroundColor: dotColor }}
          />
        </div>
      </div>
    </aside>
  );
}
