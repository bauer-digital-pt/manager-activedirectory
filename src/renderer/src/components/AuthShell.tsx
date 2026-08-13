import type { ReactNode } from "react";
import HeroBackground from "./HeroBackground";
import brandMark from "../assets/logo_2.png";
import { FLAVOR_UI } from "../lib/flavor";

interface AuthShellProps {
  /** Small label shown next to the brand mark. Defaults to the flavor's name. */
  eyebrow?: string;
  children: ReactNode;
}

// Shared full-screen brand layout used by the login gate and every status
// screen (setup / updates). Rotating hero photo fills the surface; a soft,
// slightly translucent coloured panel sits on the left with its right edge
// rounded *over* the photo, decorative blobs in the bottom-right corner, the
// brand mark top-left, and the caller's content centred within it.
export default function AuthShell({ eyebrow = FLAVOR_UI.eyebrow, children }: AuthShellProps) {
  return (
    <div className="relative flex-1 w-full h-full overflow-hidden bg-[#1a0538]">
      {/* Rotating photo — fills the whole surface; the panel covers its left part. */}
      <HeroBackground className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* Coloured panel, rounded on the right edge over the photo. Kept a touch
          translucent so the photo bleeds through softly. */}
      <aside
        className="relative z-10 flex h-full w-full flex-col overflow-hidden rounded-r-[2.5rem] shadow-2xl backdrop-blur-sm md:w-[48%] lg:w-[44%] xl:w-[41%]"
        style={{
          background:
            "linear-gradient(152deg, rgba(87,19,189,0.86) 0%, rgba(71,0,163,0.88) 52%, rgba(55,0,125,0.90) 100%)",
        }}
      >
        {/* Decorative blobs, bottom-right corner. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div
            className="absolute -bottom-16 -right-10 h-72 w-72 rounded-full"
            style={{ background: "radial-gradient(closest-side, rgba(255,255,255,0.12), transparent)" }}
          />
          <div
            className="absolute bottom-10 right-16 h-40 w-40 rounded-full"
            style={{ background: "radial-gradient(closest-side, rgba(31,209,189,0.18), transparent)" }}
          />
          <div className="absolute -bottom-6 right-24 h-24 w-24 rounded-full border border-white/10" />
          <div className="absolute bottom-24 -right-4 h-16 w-16 rounded-full border border-white/10" />
        </div>

        {/* Brand mark, top-left. */}
        <div className="relative flex items-center gap-3 px-8 pt-8 sm:px-12 lg:px-16">
          <img src={brandMark} alt="Bauer Media" className="h-9 w-auto" />
          {eyebrow && (
            <span className="text-base font-semibold tracking-wide text-white">{eyebrow}</span>
          )}
        </div>

        {/* Content — centred when short, scrolls when tall. */}
        <div className="relative flex flex-1 flex-col overflow-y-auto px-8 sm:px-12 lg:px-16">
          <div className="my-auto w-full max-w-[440px] py-8">{children}</div>
        </div>
      </aside>
    </div>
  );
}
