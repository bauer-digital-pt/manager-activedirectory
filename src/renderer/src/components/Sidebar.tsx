import { useState } from "react";
import { Users, Laptop, Server, Boxes, Layers, Settings, Terminal, User, LogOut, Lock, ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";
import type { Page, DeviceView } from "../App";
import { initials } from "../lib/initials";
import { useOutsideClick } from "../hooks/useOutsideClick";
import { FLAVOR, IS_AGENT, type AppFlavor } from "../lib/flavor";
import brandFull from "../assets/logo_1.png";

// `flavors` restricts an item to specific installers; omit = shown in both.
// The Agent installer is the onboarding wizard only — no user administration; its
// "devices" tab IS that wizard ("Onboarding PC"), whereas the Manager's is the
// read-only fleet list ("Dispositivos"), which fans out into three sub-views via
// a flyout (see DevicesNavItem) once the inventory API is enabled.
const NAV: { id: Page; label: string; icon: React.ElementType; bind: string; dev?: boolean; flavors?: AppFlavor[]; needsInventory?: boolean }[] = [
  { id: "users",     label: "Users",                                     icon: Users,    bind: "1", flavors: ["manager"] },
  { id: "devices",   label: IS_AGENT ? "Onboarding PC" : "Dispositivos", icon: Laptop,   bind: "2" },
  { id: "settings",  label: "Settings",                                  icon: Settings, bind: "4" },
  { id: "console",   label: "Console",                                   icon: Terminal, bind: "5", dev: true },
];

// The three sub-views under "Dispositivos" (Manager only, inventory enabled).
const DEVICE_VIEWS: { view: DeviceView; label: string; icon: React.ElementType }[] = [
  { view: "ad",           label: "Dispositivos AD",           icon: Server },
  { view: "ezoffice",     label: "Dispositivos EZOffice",     icon: Boxes },
  { view: "consolidated", label: "Dispositivos Consolidados", icon: Layers },
];

interface SidebarProps {
  active: Page;
  onNavigate: (p: Page) => void;
  /** Which device sub-view is active (highlights the matching flyout item). */
  deviceView: DeviceView;
  /** Navigate to a device sub-view (opens the Devices page on that view). */
  onNavigateDevice: (view: DeviceView) => void;
  /** Console is only reachable when developer mode is on. */
  devMode: boolean;
  /** The Dispositivos flyout (AD/EZOffice/Consolidados) needs the inventory API. */
  inventoryEnabled: boolean;
  /** Logged-in user (display name preferred) — drives the avatar initials. */
  userName: string;
  /** Live connection state: true=up, false=down/timeout, null=checking. */
  connOk: boolean | null;
  /** End the session and return to the login screen. */
  onLogout: () => void;
  /** Soft-lock the session (keeps it alive; unlock via biometric or password). */
  onLock: () => void;
}

export default function Sidebar({ active, onNavigate, deviceView, onNavigateDevice, devMode, inventoryEnabled, userName, connOk, onLogout, onLock }: SidebarProps) {
  const nav = NAV.filter(
    (n) =>
      (!n.dev || devMode) &&
      (!n.flavors || n.flavors.includes(FLAVOR)),
  );
  const inits = initials(userName);
  const [menuOpen, setMenuOpen] = useState(false);
  // Close the account menu on an outside click or Escape.
  const menuRef = useOutsideClick<HTMLDivElement>(menuOpen, () => setMenuOpen(false), { escape: true });
  // The Dispositivos flyout is only offered on the Manager once the inventory API
  // is on — otherwise there's a single view (AD only) and the item just navigates.
  const showDeviceFlyout = !IS_AGENT && inventoryEnabled;

  const dotColor = connOk === false ? "#ef4444" : connOk === true ? "#1fd1bd" : "#f59e0b";
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
          // "Dispositivos" fans out into AD / EZOffice / Consolidados via a flyout
          // (Manager + inventory on). Everywhere else it's a plain nav button.
          if (id === "devices" && showDeviceFlyout) {
            return (
              <DevicesNavItem
                key={id}
                label={label}
                bind={bind}
                icon={Icon}
                active={isActive}
                deviceView={deviceView}
                onNavigateDevice={onNavigateDevice}
              />
            );
          }
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

      {/* User avatar → account menu (logout). Live connection status on the dot. */}
      <div className="relative pb-4" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="relative w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-semibold transition-shadow hover:ring-2 hover:ring-violet-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
          style={{ backgroundColor: "#4700a3" }}
          title={`${userName || "Utilizador"} — ${dotTitle}`}
        >
          {inits || <User size={16} />}
          <span
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
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
            >
              <Lock size={16} />
              Bloquear
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { setMenuOpen(false); onLogout(); }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-red-50 hover:text-red-600"
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

// The "Dispositivos" nav item with its sub-view flyout. The whole button opens a
// popover listing AD / EZOffice / Consolidados; picking one navigates to that
// view. A small chevron marks it as a dropdown; the icon lights up while any
// device view is active.
function DevicesNavItem({
  label,
  bind,
  icon: Icon,
  active,
  deviceView,
  onNavigateDevice,
}: {
  label: string;
  bind: string;
  icon: React.ElementType;
  active: boolean;
  deviceView: DeviceView;
  onNavigateDevice: (view: DeviceView) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClick<HTMLDivElement>(open, () => setOpen(false), { escape: true });

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={`${label}  [${bind}]`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "relative w-10 h-10 flex items-center justify-center rounded-lg transition-colors",
          active ? "text-white" : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700",
        )}
        style={active ? { backgroundColor: "#4700a3" } : undefined}
      >
        <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
        {/* Dropdown affordance — the "setinha" requested for the title. */}
        <ChevronRight
          size={10}
          className={cn(
            "absolute bottom-0.5 right-0.5 transition-transform",
            active ? "text-white/80" : "text-zinc-400",
            open && "rotate-90",
          )}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="anim-menu absolute top-0 left-full ml-3 w-56 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-xl z-50"
        >
          <p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{label}</p>
          {DEVICE_VIEWS.map(({ view, label: viewLabel, icon: ViewIcon }) => {
            const on = active && deviceView === view;
            return (
              <button
                key={view}
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); onNavigateDevice(view); }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
                  on ? "bg-violet-50 text-violet-700" : "text-zinc-700 hover:bg-zinc-100",
                )}
              >
                <ViewIcon size={16} className={on ? "text-violet-600" : "text-zinc-400"} />
                {viewLabel}
                {on && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-violet-500" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
