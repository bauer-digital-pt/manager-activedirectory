import { useEffect, useState } from "react";
import { cn } from "../lib/cn";

// All photos dropped into assets/hero are bundled at build time. Adding or
// removing a file there is enough — no code change needed here.
const modules = import.meta.glob("../assets/hero/*.{jpg,jpeg,png}", {
  eager: true,
  import: "default",
});
const IMAGES: string[] = Object.keys(modules)
  .sort()
  .map((k) => modules[k] as string);

const ROTATE_MS = 10_000;

/** Pick a random index different from `current` (falls back gracefully for 0/1 images). */
function pickNext(current: number, len: number): number {
  if (len <= 1) return 0;
  let n = current;
  while (n === current) n = Math.floor(Math.random() * len);
  return n;
}

// Full-bleed background that cross-fades between the hero photos every 10s in a
// random order. All images are stacked; only the active one is opaque, so the
// swap is a smooth 1s opacity transition. `aria-hidden` — purely decorative.
export default function HeroBackground({ className }: { className?: string }) {
  const [idx, setIdx] = useState(() =>
    Math.floor(Math.random() * Math.max(1, IMAGES.length)),
  );

  useEffect(() => {
    if (IMAGES.length <= 1) return;
    // Respect the OS "reduce motion" setting: skip the 10s cross-fade rotation
    // entirely and leave a single static hero image in place.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(
      () => setIdx((cur) => pickNext(cur, IMAGES.length)),
      ROTATE_MS,
    );
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className={cn("overflow-hidden bg-deep-purple", className)} aria-hidden>
      {IMAGES.map((src, i) => (
        <img
          key={src}
          src={src}
          alt=""
          className={cn(
            "pointer-events-none absolute inset-0 h-full w-full select-none object-cover transition-opacity duration-1000 ease-in-out",
            i === idx ? "opacity-100" : "opacity-0",
          )}
        />
      ))}
    </div>
  );
}
