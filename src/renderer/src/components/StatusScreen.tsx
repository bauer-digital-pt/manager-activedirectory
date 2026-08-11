import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import AuthShell from "./AuthShell";
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
  /** When present, render an animated progress bar (0–100) + optional label + the % number.
   * `indeterminate` shows a looping sweep instead of a fixed width (unknown duration). */
  progress?: { percent: number; label?: string; indeterminate?: boolean } | null;
  /** Action row — the first/primary action is the most prominent; ghost is subtle. */
  actions?: StatusAction[];
  /** Optional extra content (manual instructions, notes) rendered below the actions. */
  children?: ReactNode;
}

type Tone = NonNullable<StatusScreenProps["tone"]>;

// Tokens tuned for the translucent purple panel (light-on-dark). `icon` colours
// the badge glyph, `fill` the progress bar.
const TONES: Record<Tone, { icon: string; fill: string }> = {
  brand: { icon: "#ffffff", fill: "#ffffff" },
  success: { icon: "#1fd1bd", fill: "#1fd1bd" },
  error: { icon: "#fbbf24", fill: "#fbbf24" },
};

// Shared status layout for setup / update screens. Uses the same AuthShell as
// the login gate (rotating hero + soft purple panel) so every gate screen looks
// identical; content is centred within the panel and scrolls when tall.
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
  const percent = progress ? Math.max(0, Math.min(100, Math.round(progress.percent))) : 0;

  return (
    <AuthShell eyebrow={eyebrow}>
      {/* Hero badge */}
      {badge && (
        <div className="relative mb-7 inline-flex items-center justify-center">
          <div
            aria-hidden
            className="absolute h-20 w-20 rounded-full opacity-70 blur-2xl"
            style={{ backgroundColor: t.icon }}
          />
          <div
            className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/15"
            style={{ color: t.icon }}
          >
            {badge}
          </div>
        </div>
      )}

      {/* Title */}
      <h1 className="text-2xl font-semibold leading-tight text-white">{title}</h1>

      {/* Subtitle */}
      {subtitle && (
        <p className="mt-3 max-w-[52ch] text-base leading-relaxed text-white/65">{subtitle}</p>
      )}

      {/* Progress */}
      {progress && (
        <div className="mt-8 w-full max-w-[440px]">
          <div className="mb-2 flex items-center justify-between gap-4">
            <span className="min-w-0 truncate text-sm text-white/60">
              {progress.label ?? "A processar…"}
            </span>
            {!progress.indeterminate && (
              <span className="shrink-0 font-mono text-sm font-medium tabular-nums text-white/85">
                {percent}%
              </span>
            )}
          </div>
          <div
            className="relative h-2.5 w-full overflow-hidden rounded-full bg-white/15"
            role="progressbar"
            aria-valuenow={progress.indeterminate ? undefined : percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={progress.label ?? title}
          >
            {progress.indeterminate ? (
              <div
                className="status-indeterminate absolute inset-y-0 w-2/5 rounded-full"
                style={{ backgroundColor: t.fill }}
              />
            ) : (
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{ width: `${percent}%`, backgroundColor: t.fill }}
              />
            )}
          </div>
        </div>
      )}

      {/* Actions */}
      {hasActions && (
        <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
          {actions!.map((action, i) => {
            const variant = action.variant ?? (i === 0 ? "primary" : "ghost");
            const isDisabled = action.disabled || action.loading;
            return (
              <button
                key={`${action.label}-${i}`}
                type="button"
                onClick={action.onClick}
                disabled={isDisabled}
                className={cn(
                  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  variant === "primary"
                    ? "bg-white px-5 py-2.5 text-[#4700a3] shadow-sm hover:bg-white/90"
                    : "px-4 py-2 font-medium text-white/70 hover:bg-white/10 hover:text-white",
                )}
              >
                {action.loading && <Loader2 size={16} className="animate-spin" />}
                {action.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Extra content (manual instructions, notes) */}
      {children && <div className="mt-8 w-full">{children}</div>}
    </AuthShell>
  );
}
