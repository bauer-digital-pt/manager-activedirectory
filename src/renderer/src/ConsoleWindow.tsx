import ConsolePage from "./pages/ConsolePage";

// Standalone shell for the detached Console window (opened via Ctrl+Shift+C).
// Deliberately unbranded — a plain dark utility that reuses the exact same log
// viewer as the Manager's Console page, but fills its own OS window instead of
// living inside the app chrome. main.tsx renders this (instead of <App/>) when
// the document loads with the "#console" hash.
export default function ConsoleWindow() {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0f1117] text-zinc-300">
      <ConsolePage />
    </div>
  );
}
