import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import logo from "../assets/bauer-media-logo.svg";
import { cn } from "../lib/cn";

export interface StatusAction {
  label: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: "primary" | "ghost";
}

export interface StatusScreenProps {
  /** Accent for the hero badge + progress fill. Defaults to "brand". */
  tone?: "brand" | "success" | "error";
  /** Icon element rendered inside the hero badge (inherits the tone colour). */
  badge?: ReactNode;
  /** Small label shown next to the logo (e.g. "AD Manager"). */
  eyebrow?: string;
  title: string;
  subtitle?: ReactNode;
  /** When present, render an animated progress bar (0–100) + optional label + the % number. */
  progress?: { percent: number; label?: string } | null;
  /** Action row — the first/primary action is the most prominent; ghost is subtle. */
  actions?: StatusAction[];
  /** Optional extra content (manual instructions, notes) rendered below the actions. */
  children?: ReactNode;
}

type Tone = NonNullable<StatusScreenProps["tone"]>;

interface ToneTokens {
  icon: string;
  badgeBg: string;
  halo: string;
  ring: string;
  fill: string;
}

const TONES: Record<Tone, ToneTokens> = {
  brand: {
    icon: "#4700a3",
    badgeBg: "rgba(71, 0, 163, 0.08)",
    halo: "rgba(71, 0, 163, 0.16)",
    ring: "rgba(71, 0, 163, 0.16)",
    fill: "#4700a3",
  },
  success: {
    icon: "#0d9488",
    badgeBg: "rgba(31, 209, 189, 0.16)",
    halo: "rgba(31, 209, 189, 0.26)",
    ring: "rgba(13, 148, 136, 0.18)",
    fill: "#1fd1bd",
  },
  error: {
    icon: "#d97706",
    badgeBg: "rgba(245, 158, 11, 0.13)",
    halo: "rgba(245, 158, 11, 0.22)",
    ring: "rgba(217, 119, 6, 0.18)",
    fill: "#f59e0b",
  },
};

export default function StatusScreen({
  tone = "brand",
  badge,
  eyebrow,
  title,
  subtitle,
  progress,
  actions,
  children,
}: StatusScreenProps) {
  const t = TONES[tone];
  const hasActions = !!actions && actions.length > 0;
  const percent = progress
    ? Math.max(0, Math.min(100, Math.round(progress.percent)))
    : 0;

  return (
    <div className="flex-1 w-full h-full flex overflow-hidden bg-white">
      {/* ---------------- LEFT — brand hero panel (collapses below md) ---------------- */}
      <aside
        className="relative hidden shrink-0 flex-col justify-between overflow-hidden px-9 py-11 md:flex md:w-[38%] md:max-w-[420px] lg:px-11"
        style={{
          background:
            "linear-gradient(152deg, #5713bd 0%, #4700a3 52%, #37007d 100%)",
        }}
      >
        {/* Soft light glows — keep the panel airy, never flat-dark */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl"
          style={{
            background:
              "radial-gradient(closest-side, rgba(255,255,255,0.30), transparent)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -left-20 bottom-4 h-64 w-64 rounded-full blur-3xl"
          style={{
            background:
              "radial-gradient(closest-side, rgba(31,209,189,0.22), transparent)",
          }}
        />
        {/* Faint triangle motif echoing the brand mark */}
        <svg
          aria-hidden
          viewBox="0 0 120 320"
          className="pointer-events-none absolute -right-1 bottom-24 h-[52%] w-auto opacity-[0.08]"
          fill="#ffffff"
        >
          <polygon points="0,0 20,13 0,26" />
          <polygon points="0,40 20,53 0,66" />
          <polygon points="0,80 20,93 0,106" />
          <polygon points="0,120 20,133 0,146" />
          <polygon points="34,20 54,33 34,46" />
          <polygon points="34,60 54,73 34,86" />
          <polygon points="34,100 54,113 34,126" />
          <polygon points="68,40 88,53 68,66" />
          <polygon points="68,80 88,93 68,106" />
        </svg>

        {/* Logo + eyebrow */}
        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white shadow-sm">
            <img src={logo} alt="Bauer Media" className="h-7 w-7" />
          </div>
          {eyebrow && (
            <span className="text-base font-semibold tracking-wide text-white">
              {eyebrow}
            </span>
          )}
        </div>

        {/* Panel footer — static, brand-consistent supporting copy */}
        <div className="relative">
          <p className="text-sm font-medium text-white/90">
            Gestão de contas Active Directory
          </p>
          <p className="mt-1 text-xs text-white/55">Bauer Media Audio Portugal</p>
        </div>
      </aside>

      {/* ---------------- RIGHT — scrollable content column ---------------- */}
      <main className="relative h-full min-w-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full w-full flex-col px-6 py-10 sm:px-10 lg:px-16">
          {/* Compact logo header — only shows when the purple panel is collapsed */}
          <div className="mb-8 flex items-center gap-2.5 md:hidden">
            <img src={logo} alt="Bauer Media" className="h-8 w-8" />
            {eyebrow && (
              <span className="text-sm font-medium tracking-wide text-zinc-400">
                {eyebrow}
              </span>
            )}
          </div>

          {/* Content — vertically centred when there is room, scrolls when tall */}
          <div className="my-auto w-full max-w-[560px]">
            {/* Hero badge */}
            {badge && (
              <div className="relative mb-7 inline-flex items-center justify-center">
                <div
                  aria-hidden
                  className="absolute h-20 w-20 rounded-full opacity-80 blur-2xl"
                  style={{ backgroundColor: t.halo }}
                />
                <div
                  className="relative flex h-16 w-16 items-center justify-center rounded-2xl"
                  style={{
                    backgroundColor: t.badgeBg,
                    color: t.icon,
                    boxShadow: `inset 0 0 0 1px ${t.ring}`,
                  }}
                >
                  {badge}
                </div>
              </div>
            )}

            {/* Title */}
            <h1 className="text-2xl font-semibold leading-tight text-zinc-900">
              {title}
            </h1>

            {/* Subtitle */}
            {subtitle && (
              <p className="mt-3 max-w-[52ch] text-base leading-relaxed text-zinc-500">
                {subtitle}
              </p>
            )}

            {/* Progress */}
            {progress && (
              <div className="mt-8 w-full max-w-[440px]">
                <div className="mb-2 flex items-center justify-between gap-4">
                  <span className="min-w-0 truncate text-sm text-zinc-500">
                    {progress.label ?? "A processar…"}
                  </span>
                  <span className="shrink-0 font-mono text-sm font-medium tabular-nums text-zinc-700">
                    {percent}%
                  </span>
                </div>
                <div
                  className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-100"
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={progress.label ?? title}
                >
                  <div
                    className="h-full rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${percent}%`, backgroundColor: t.fill }}
                  />
                </div>
              </div>
            )}

            {/* Actions */}
            {hasActions && (
              <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                {actions!.map((action, i) => {
                  const variant =
                    action.variant ?? (i === 0 ? "primary" : "ghost");
                  const isDisabled = action.disabled || action.loading;
                  return (
                    <button
                      key={`${action.label}-${i}`}
                      type="button"
                      onClick={action.onClick}
                      disabled={isDisabled}
                      className={cn(
                        "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors",
                        "disabled:cursor-not-allowed disabled:opacity-60",
                        variant === "primary"
                          ? "bg-violet-600 px-5 py-2.5 text-white hover:bg-violet-700 disabled:hover:bg-violet-600"
                          : "px-4 py-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800",
                      )}
                    >
                      {action.loading && (
                        <Loader2 size={16} className="animate-spin" />
                      )}
                      {action.label}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Extra content (manual instructions, notes) */}
            {children && <div className="mt-8 w-full">{children}</div>}
          </div>
        </div>
      </main>
    </div>
  );
}
