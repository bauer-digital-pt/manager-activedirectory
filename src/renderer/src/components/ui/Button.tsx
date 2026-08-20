// The one primary-action button for the app. Before this, the primary-button
// class was hand-retyped ~28× with drifting radius (md/lg/xl), disabled opacity
// (40/50/60) and focus recipes, and the brand hue was split between `#4700a3`
// (chrome) and `violet-600` (buttons). This encapsulates one radius, one disabled
// state, one hover, and the keyboard focus ring so they can't drift again.
//
// `variant` picks the role colour, `size` the padding. `type` defaults to
// "button" so a Button inside a <form> never submits by accident. Extra classes
// are merged with cn(), so callers can still tweak width/margins or override the
// focus-ring colour on a dark surface (tailwind-merge resolves the conflict).
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const base =
  "inline-flex items-center justify-center gap-1.5 font-medium rounded-lg transition-colors " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white " +
  "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none";

const variantCls: Record<ButtonVariant, string> = {
  primary: "bg-brand text-white hover:bg-brand-hover focus-visible:ring-brand/40",
  secondary:
    "bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50 hover:text-zinc-900 focus-visible:ring-brand/30",
  danger: "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500/40",
  ghost: "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-brand/30",
};

const sizeCls: Record<ButtonSize, string> = {
  sm: "text-sm px-3 py-1.5",
  md: "text-sm px-4 py-2",
  lg: "text-sm px-5 py-2.5",
  icon: "p-2", // square icon-only button; pair with a fixed w/h in className if needed
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", type = "button", className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(base, variantCls[variant], sizeCls[size], className)}
      {...props}
    />
  );
});
