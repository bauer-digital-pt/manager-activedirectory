import type { ReactNode } from "react";
import type { OnboardStep } from "../../adAPI";
import { cn } from "../../lib/cn";

// Bespoke, per-step animated iconography for the Agent onboarding (OOBE). Each
// step gets a hand-built SVG whose internals animate to *mean* the action —
// a spinning globe for regional, a breathing shield for the VPN, a scan line
// for remote-support, equalizer bars for the media player, a feeding sheet for
// printers, a lighting-up mesh for the domain join. The animation only runs
// while the step is live (`animated`); at rest the glyph is static. All motion
// is driven by the `.si-*` / `.oobe-*` classes in index.css and collapses under
// prefers-reduced-motion. Colour comes from the parent via `currentColor`.

// State → tone. On the purple OOBE backdrop everything is light-on-dark: the
// live step glows violet, a finished one turns Bauer teal, a failure goes amber,
// and anything not yet reached sits back in a faint white.
type IconState = "idle" | "running" | "done" | "error";

const TONE: Record<IconState, { glyph: string; badge: string; aura: string; dot: string }> = {
  running: { glyph: "text-violet-100", badge: "bg-violet-400/15 ring-violet-300/25", aura: "bg-violet-300/40", dot: "bg-violet-200" },
  done:    { glyph: "text-teal-100",   badge: "bg-teal-400/15 ring-teal-300/25",     aura: "bg-teal-300/40",   dot: "bg-teal-200"   },
  error:   { glyph: "text-amber-100",  badge: "bg-amber-400/15 ring-amber-300/25",   aura: "bg-amber-300/40",  dot: "bg-amber-200"  },
  idle:    { glyph: "text-white/45",   badge: "bg-white/[0.06] ring-white/10",       aura: "bg-white/20",      dot: "bg-white/40"   },
};

// The animated interior of each step's glyph. `on` gates the looping classes so
// the icon only comes alive while its step is executing. Everything is drawn on
// a 24×24 grid with round joins to match lucide's line weight.
function glyph(step: OnboardStep, on: boolean): ReactNode {
  switch (step) {
    case "regional": // a globe whose meridians rotate — "a definir região/idioma"
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <g className={on ? "si-globe" : undefined}>
            <ellipse cx="12" cy="12" rx="4.2" ry="9" />
            <line x1="3" y1="12" x2="21" y2="12" />
          </g>
        </>
      );
    case "anyconnect": // a shield that breathes, with a checkmark — "a proteger a ligação"
      return (
        <>
          <path
            className={on ? "si-shield" : undefined}
            d="M12 3 19 6 v5 c0 4.4 -2.9 7 -7 8 -4.1 -1 -7 -3.6 -7 -8 V6 Z"
          />
          <path d="M9 12.2 11 14.2 15 10" />
        </>
      );
    case "screenconnect": // a monitor with a scan line sweeping down — "acesso remoto"
      return (
        <>
          <rect x="3" y="4" width="18" height="12.5" rx="1.6" />
          <line x1="9.5" y1="20" x2="14.5" y2="20" />
          <line x1="12" y1="16.5" x2="12" y2="20" />
          <line
            className={on ? "si-scan" : undefined}
            x1="6"
            y1="7.5"
            x2="18"
            y2="7.5"
            style={{ ["--scan" as string]: "6px" }}
          />
        </>
      );
    case "smlplayer": // a player window with dancing equalizer bars — "a instalar o leitor"
      return (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="3" y1="8.5" x2="21" y2="8.5" />
          <rect className={on ? "si-bar" : undefined} x="8"    y="11"   width="1.7" height="6" rx="0.85" fill="currentColor" stroke="none" />
          <rect className={on ? "si-bar" : undefined} x="11.2" y="9"    width="1.7" height="8" rx="0.85" fill="currentColor" stroke="none" style={{ animationDelay: "0.15s" }} />
          <rect className={on ? "si-bar" : undefined} x="14.4" y="12.5" width="1.7" height="4.5" rx="0.85" fill="currentColor" stroke="none" style={{ animationDelay: "0.3s" }} />
        </>
      );
    case "printers": // a printer with a sheet feeding out — "a configurar impressoras"
      return (
        <>
          <path d="M6 9 V3 h12 v6" />
          <path d="M6 18 H4 a2 2 0 0 1 -2 -2 v-5 a2 2 0 0 1 2 -2 h16 a2 2 0 0 1 2 2 v5 a2 2 0 0 1 -2 2 h-2" />
          <rect
            className={on ? "si-paper" : undefined}
            x="7"
            y="14"
            width="10"
            height="7"
            rx="1"
            fill="currentColor"
            stroke="none"
          />
          <circle cx="17.5" cy="12" r="0.7" fill="currentColor" stroke="none" />
        </>
      );
    case "domain": // a mesh whose links draw and nodes light up — "a juntar ao domínio"
      return (
        <>
          <line className={on ? "si-link" : undefined} x1="12" y1="12" x2="5"  y2="6"  style={{ ["--len" as string]: "13" }} />
          <line className={on ? "si-link" : undefined} x1="12" y1="12" x2="19" y2="6"  style={{ ["--len" as string]: "13", animationDelay: "0.3s" }} />
          <line className={on ? "si-link" : undefined} x1="12" y1="12" x2="12" y2="20" style={{ ["--len" as string]: "8", animationDelay: "0.6s" }} />
          <circle className={on ? "si-node" : undefined} cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
          <circle className={on ? "si-node" : undefined} cx="5"  cy="6"  r="2"   fill="currentColor" stroke="none" style={{ animationDelay: "0.2s" }} />
          <circle className={on ? "si-node" : undefined} cx="19" cy="6"  r="2"   fill="currentColor" stroke="none" style={{ animationDelay: "0.4s" }} />
          <circle className={on ? "si-node" : undefined} cx="12" cy="20" r="2"   fill="currentColor" stroke="none" style={{ animationDelay: "0.6s" }} />
        </>
      );
  }
}

// A large, animated step icon for the running/done/paused OOBE screens: the
// bespoke glyph inside a soft glass badge, wrapped by a sonar aura + orbiting
// satellite dot while the step is live. `size` is the badge edge in px.
export function StepIcon({
  step,
  state,
  size = 112,
}: {
  step: OnboardStep;
  state: IconState;
  size?: number;
}) {
  const tone = TONE[state];
  const pulse = state === "running";
  const glyphSize = Math.round(size * 0.46);
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      {pulse && (
        <>
          <span className={cn("oobe-aura absolute rounded-[30%]", tone.aura)} style={{ inset: size * 0.06 }} />
          <span className={cn("oobe-aura absolute rounded-[30%]", tone.aura)} style={{ inset: size * 0.06, animationDelay: "1.2s" }} />
        </>
      )}
      <span
        className={cn("relative inline-flex items-center justify-center rounded-[28%] ring-1 backdrop-blur-sm", tone.badge)}
        style={{ width: size, height: size }}
      >
        <svg
          width={glyphSize}
          height={glyphSize}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={tone.glyph}
        >
          {glyph(step, pulse)}
        </svg>
      </span>
      {pulse && (
        <span className="oobe-orbit absolute" style={{ inset: 0 }}>
          <span className={cn("absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rounded-full", tone.dot)} />
        </span>
      )}
    </span>
  );
}

// A generic aura badge for the non-step OOBE heroes (intro laptop, reboot power,
// success check). Same framing as StepIcon but takes an arbitrary icon so those
// screens share the exact look. `pulse` runs the sonar rings; `burst` fires the
// one-shot celebration ring on the done screen.
export function AuraBadge({
  tone = "brand",
  size = 112,
  pulse = false,
  burst = false,
  children,
}: {
  tone?: "brand" | "success" | "error";
  size?: number;
  pulse?: boolean;
  burst?: boolean;
  children: ReactNode;
}) {
  const t = TONE[tone === "brand" ? "running" : tone === "success" ? "done" : "error"];
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      {pulse && (
        <>
          <span className={cn("oobe-aura absolute rounded-[30%]", t.aura)} style={{ inset: size * 0.06 }} />
          <span className={cn("oobe-aura absolute rounded-[30%]", t.aura)} style={{ inset: size * 0.06, animationDelay: "1.2s" }} />
        </>
      )}
      {burst && <span className={cn("oobe-burst absolute rounded-full", t.aura)} style={{ inset: size * 0.12 }} />}
      <span
        className={cn("relative inline-flex items-center justify-center rounded-[28%] ring-1 backdrop-blur-sm", t.badge, t.glyph)}
        style={{ width: size, height: size }}
      >
        {children}
      </span>
    </span>
  );
}
