import { useState, useEffect, useRef, useMemo } from "react";
import {
  Terminal, Trash2, ChevronDown, ChevronRight, CheckCircle, XCircle,
  AlertTriangle, Info, Bug, Copy, Check,
} from "lucide-react";
import { cn } from "../lib/cn";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import type { AppLogEntry, LogLevel } from "../lib/appLog";

// Severity rank for the min-level filter. "success" is an info-severity event.
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, success: 1, warn: 2, error: 3 };

const LEVEL_ICON: Record<LogLevel, typeof Info> = {
  debug: Bug, info: Info, success: CheckCircle, warn: AlertTriangle, error: XCircle,
};
const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "text-zinc-600", info: "text-sky-400", success: "text-emerald-500",
  warn: "text-amber-400", error: "text-red-500",
};

// Stable-ish color per source tag.
const SOURCE_COLOR: Record<string, string> = {
  app: "bg-violet-500/15 text-violet-300 border-violet-500/25",
  window: "bg-sky-500/15 text-sky-300 border-sky-500/25",
  net: "bg-cyan-500/15 text-cyan-300 border-cyan-500/25",
  ipc: "bg-indigo-500/15 text-indigo-300 border-indigo-500/25",
  ps: "bg-emerald-500/15 text-emerald-300 border-emerald-500/25",
  updater: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/25",
  rsat: "bg-amber-500/15 text-amber-300 border-amber-500/25",
  renderer: "bg-rose-500/15 text-rose-300 border-rose-500/25",
};
const sourceColor = (s: string) => SOURCE_COLOR[s] ?? "bg-zinc-700/40 text-zinc-300 border-zinc-600/40";

const MIN_LEVELS: { key: LogLevel | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "debug", label: "Debug+" },
  { key: "info", label: "Info+" },
  { key: "warn", label: "Warn+" },
  { key: "error", label: "Errors" },
];

export default function ConsolePage() {
  const [entries, setEntries] = useState<AppLogEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [minLevel, setMinLevel] = useState<LogLevel | "all">("all");
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const { copied, copy } = useCopyFeedback(1500);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Subscribe first, then back-fill history — so nothing emitted in the gap is
  // lost. Both paths dedupe by id.
  useEffect(() => {
    if (!window.consoleAPI) return;
    let mounted = true;

    const unsub = window.consoleAPI.onLog((entry) => {
      if (!mounted) return;
      const e = entry as AppLogEntry;
      setEntries((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, e]));
    });

    window.consoleAPI.getHistory?.().then((hist) => {
      if (!mounted || !hist) return;
      setEntries((prev) => {
        const map = new Map<string, AppLogEntry>();
        for (const e of hist as AppLogEntry[]) map.set(e.id, e);
        for (const e of prev) map.set(e.id, e);
        return [...map.values()].sort((a, b) => a.ts - b.ts);
      });
    });

    return () => { mounted = false; unsub(); };
  }, []);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, autoScroll]);

  const sources = useMemo(
    () => [...new Set(entries.map((e) => e.source))].sort(),
    [entries],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const min = minLevel === "all" ? -1 : RANK[minLevel];
    return entries.filter((e) => {
      if (RANK[e.level] < min) return false;
      if (hiddenSources.has(e.source)) return false;
      if (q) {
        const hay = `${e.source} ${e.label} ${e.detail ?? ""} ${JSON.stringify(e.data ?? "")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [entries, minLevel, hiddenSources, query]);

  const counts = useMemo(() => {
    let errors = 0, warns = 0;
    for (const e of entries) { if (e.level === "error") errors++; else if (e.level === "warn") warns++; }
    return { errors, warns };
  }, [entries]);

  const toggle = (id: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const toggleSource = (s: string) =>
    setHiddenSources((h) => { const n = new Set(h); n.has(s) ? n.delete(s) : n.add(s); return n; });

  const clearAll = () => { setEntries([]); setExpanded(new Set()); window.consoleAPI?.clear?.(); };

  const copyAll = () => copy(filtered.map(fmtLine).join("\n"));

  const fmt = (ts: number) => {
    const d = new Date(ts);
    const hms = d.toLocaleTimeString("pt-PT", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return `${hms}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  };
  const fmtLine = (e: AppLogEntry) =>
    `${fmt(e.ts)} [${e.level}] ${e.source}/${e.label}${e.detail ? ` — ${e.detail}` : ""}${e.durationMs != null ? ` (${e.durationMs}ms)` : ""}`;

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#0f1117] text-zinc-300 font-mono text-xs">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 bg-[#0f1117] flex-shrink-0 flex-wrap">
        <Terminal size={13} className="text-zinc-500" />
        <span className="text-zinc-400 text-xs font-sans font-medium">Console</span>
        <span className="text-zinc-700">·</span>
        <span className="text-zinc-600 font-sans">{filtered.length}/{entries.length}</span>
        {counts.errors > 0 && <span className="text-red-400 font-sans">{counts.errors} err</span>}
        {counts.warns > 0 && <span className="text-amber-400 font-sans">{counts.warns} warn</span>}

        <div className="flex items-center gap-1 ml-1">
          {MIN_LEVELS.map((f) => (
            <button key={f.key} onClick={() => setMinLevel(f.key)}
              className={cn("px-2 py-0.5 rounded text-xs font-sans transition-colors",
                minLevel === f.key ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300")}>
              {f.label}
            </button>
          ))}
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter…"
          className="px-2 py-1 w-40 rounded bg-zinc-900 border border-zinc-800 text-zinc-200 placeholder-zinc-600 font-sans focus:outline-none focus:border-zinc-600"
        />

        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 font-sans text-zinc-500 cursor-pointer select-none">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)}
              className="w-3 h-3 rounded border-zinc-600 bg-zinc-800" />
            Auto-scroll
          </label>
          <button onClick={copyAll} className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors font-sans">
            {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
            {copied ? "Copiado" : "Copiar"}
          </button>
          <button onClick={clearAll} className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors font-sans">
            <Trash2 size={12} />
            Limpar
          </button>
        </div>

        {/* Source toggles */}
        {sources.length > 0 && (
          <div className="w-full flex items-center gap-1.5 pt-1">
            {sources.map((s) => (
              <button key={s} onClick={() => toggleSource(s)}
                className={cn("px-1.5 py-0.5 rounded border text-[11px] font-sans transition-opacity",
                  sourceColor(s), hiddenSources.has(s) && "opacity-30 line-through")}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-0.5">
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-zinc-600">
            <Terminal size={24} />
            <p className="font-sans text-sm">{entries.length === 0 ? "À espera de atividade…" : "Nada corresponde ao filtro."}</p>
          </div>
        )}

        {filtered.map((entry) => {
          const isOpen = expanded.has(entry.id);
          const LevelIcon = LEVEL_ICON[entry.level];
          const hasData = entry.data != null && (typeof entry.data !== "object" || Object.keys(entry.data as object).length > 0);

          return (
            <div key={entry.id} className="group">
              <button
                onClick={() => hasData && toggle(entry.id)}
                className={cn("w-full flex items-start gap-2 text-left rounded px-2 py-1 transition-colors",
                  hasData ? "hover:bg-white/5 cursor-pointer" : "cursor-default")}
              >
                <span className="text-zinc-600 flex-shrink-0 mt-0.5 w-3">
                  {hasData ? (isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />) : null}
                </span>
                <span className="text-zinc-600 flex-shrink-0 tabular-nums">{fmt(entry.ts)}</span>
                <LevelIcon size={12} className={cn("flex-shrink-0 mt-0.5", LEVEL_COLOR[entry.level])} />
                <span className={cn("flex-shrink-0 px-1.5 rounded border text-[11px] leading-4 mt-px", sourceColor(entry.source))}>
                  {entry.source}
                </span>
                <span className={cn("flex-shrink-0 font-semibold", entry.level === "error" ? "text-red-300" : "text-zinc-200")}>
                  {entry.label}
                </span>
                {entry.mocked && (
                  <span className="flex-shrink-0 text-[10px] px-1 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 mt-px">MOCK</span>
                )}
                {entry.detail && <span className="text-zinc-400 truncate">{entry.detail}</span>}
                {entry.durationMs != null && (
                  <span className="ml-auto text-zinc-600 flex-shrink-0 tabular-nums">{entry.durationMs}ms</span>
                )}
              </button>

              {isOpen && hasData && (
                <pre className="ml-9 mr-2 mb-2 px-3 py-2 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 whitespace-pre-wrap break-all overflow-x-auto">
                  {JSON.stringify(entry.data, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
