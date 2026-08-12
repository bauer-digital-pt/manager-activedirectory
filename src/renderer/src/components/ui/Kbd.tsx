import { cn } from "../../lib/cn";

type Tone = "zinc" | "violet";

const TONE: Record<Tone, string> = {
  // Dim key hint on a light surface (row shortcuts, "Esc").
  zinc: "bg-zinc-100 text-zinc-400 border-zinc-200",
  // Bright key hint on a dark/brand surface (the "↵" and "N" accelerators).
  violet: "bg-violet-500/60 text-violet-100 border-violet-400/40",
};

// A single keyboard-hint chip. Replaces the half-dozen hand-written <kbd>
// spans that all shared the same base and one of two tones.
export function Kbd({
  children,
  tone = "zinc",
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <kbd className={cn("text-xs font-mono px-1.5 py-0.5 rounded border", TONE[tone], className)}>
      {children}
    </kbd>
  );
}
