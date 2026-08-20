import { useState } from "react";
import { Users, Laptop, Settings, Terminal, User, LogOut, Lock } from "lucide-react";
import { cn } from "../lib/cn";
import { focusRing } from "./ui/controls";
import type { Page } from "../App";
import { initials } from "../lib/initials";
import { useOutsideClick } from "../hooks/useOutsideClick";
import { FLAVOR, IS_AGENT, type AppFlavor } from "../lib/flavor";
import brandFull from "../assets/logo_1.png";

// `flavors` restricts an item to specific installers; omit = shown in both.
// The Agent installer is the onboarding wizard only — no user administration; its
// "devices" tab IS that wizard ("Onboarding PC"), whereas the Manager's is the
// single consolidated fleet list ("Dispositivos") — the union of every AD computer
// object and every EZOffice asset, enriched and joined by name.
const NAV: { id: Page; label: string; icon: React.ElementType; bind: string; dev?: boolean; flavors?: AppFlavor[]; needsInventory?: boolean }[] = [
  { id: "users",     label: "Utilizadores",                              icon: Users,    bind: "1", flavors: ["manager"] },
  { id: "devices",   label: IS_AGENT ? "Onboarding PC" : "Dispositivos", icon: Laptop,   bind: "2" },
  { id: "settings",  label: "Definições",                                icon: Settings, bind: "4" },
  { id: "console",   label: "Consola",                                   icon: Terminal, bind: "5", dev: true },
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
  /** End the session and return to the login screen. */
  onLogout: () => void;
  /** Soft-lock the session (keeps it alive; unlock via biometric or password). */
  onLock: () => void;
}

export default function Sidebar({ active, onNavigate, devMode, userName, connOk, onLogout, onLock }: SidebarProps) {
  const nav = NAV.filter(
    (n) =>
      (!n.dev || devMode) &&
      (!n.flavors || n.flavors.includes(FLAVOR)),
  );
  const inits = initials(userName);
  const [menuOpen, setMenuOpen] = useState(false);
  // Close the account menu on an outside click or Escape.
  const menuRef = useOutsideClick<HTMLDivElement>(menuOpen, () => setMenuOpen(false), { escape: true });

  // The dot conveys state by colour, so it's always paired with a text/aria label
  // (menu row + the avatar dot's aria-label). The "ok" hue is a darker emerald
  // (#059669) rather than the brand teal so the dot itself clears WCAG 3:1 and the
  // three states aren't distinguished by hue alone.
  const dotColor = connOk === false ? "#ef4444" : connOk === true ? "#059669" : "#f59e0b";
  const dotTitle = connOk === false ? "Sem ligação ao AD" : connOk === true ? "Ligado ao AD" : "A verificar ligação…";

  return (
    <aside className="w-16 h-full flex flex-col items-center border-r border-zinc-100 bg-white select-none">
      {/* Logo — full brand mark cropped in-place to just the "B" glyph. */}
      <div className="py-4 border-b border-zinc-100 w-full flex justify-center">
        <div className="h-9 w-9 overflow-hidden flex items-center justify-start" title="Bauer Media">
          {/* logo_1 is the full "Bauer Media" lockup; scale it up and clip so only
              the "B" glyph on the left shows (the wordmark + arrow fall outside). */}
          <img src={brandFull} alt="Bauer Media" className="h-11 w-auto max-w-none object-left" />
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 flex flex-col items-center justify-center gap-1 py-4">
        {nav.map(({ id, label, icon: Icon, bind }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onNavigate(id)}
              title={`${label}  [${bind}]`}
              aria-label={label}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "w-10 h-10 flex items-center justify-center rounded-lg transition-colors",
                isActive ? "bg-brand text-white" : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700",
                focusRing,
              )}
            >
              <Icon size={20} strokeWidth={isActive ? 2.2 : 1.8} />
            </button>
          );
        })}
      </nav>

      {/* User avatar → account menu (logout). Live connection status on the dot. */}
      <div className="relative pb-4" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className={cn(
            "relative w-9 h-9 rounded-full flex items-center justify-center bg-brand text-white text-xs font-semibold transition-shadow hover:ring-2 hover:ring-brand/30",
            focusRing,
          )}
          title={`${userName || "Utilizador"} — ${dotTitle}`}
        >
          {inits || <User size={16} />}
          <span
            role="img"
            aria-label={dotTitle}
            title={dotTitle}
            className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white"
            style={{ backgroundColor: dotColor }}
          />
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="anim-menu absolute bottom-0 left-full ml-3 w-56 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-xl z-50"
          >
            <div className="px-2.5 py-2">
              <p className="truncate text-sm font-medium text-zinc-800">{userName || "Utilizador"}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-400">
                <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: dotColor }} />
                {dotTitle}
              </p>
            </div>
            <div className="my-1 h-px bg-zinc-100" />
            <button
              type="button"
              role="menuitem"
              onClick={() => { setMenuOpen(false); onLock(); }}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100",
                focusRing,
              )}
            >
              <Lock size={16} />
              Bloquear
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { setMenuOpen(false); onLogout(); }}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-red-50 hover:text-red-600",
                focusRing,
              )}
            >
              <LogOut size={16} />
              Terminar sessão
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
