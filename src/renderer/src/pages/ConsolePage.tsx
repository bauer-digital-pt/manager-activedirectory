import { useState, useEffect, useRef } from "react";
import { Terminal, Trash2, ChevronDown, ChevronRight, CheckCircle, XCircle } from "lucide-react";
import { cn } from "../lib/cn";

export interface ConsoleEntry {
  id: string;
  ts: number;
  type: "ps" | "info" | "error";
  script?: string;
  args?: string[];
  result?: { ok: boolean; data?: unknown; error?: string };
  message?: string;
  durationMs?: number;
  mocked?: boolean;
}


export default function ConsolePage() {
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"all" | "ok" | "error">("all");
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (!window.consoleAPI) return;
    const unsub = window.consoleAPI.onLog((entry) => {
      setEntries((prev) => [...prev, entry as ConsoleEntry]);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, autoScroll]);

  const toggle = (id: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const filtered = entries.filter((e) => {
    if (filter === "ok")    return e.result?.ok !== false;
    if (filter === "error") return e.result?.ok === false || e.type === "error";
    return true;
  });

  const fmt = (ts: number) => {
    const d = new Date(ts);
    const hms = d.toLocaleTimeString("pt-PT", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${hms}.${ms}`;
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#0f1117] text-zinc-300 font-mono text-xs">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 bg-[#0f1117] flex-shrink-0">
        <Terminal size={13} className="text-zinc-500" />
        <span className="text-zinc-500 text-xs font-sans">Console</span>
        <span className="text-zinc-700">·</span>
        <span className="text-zinc-600 font-sans">{entries.length} entries</span>

        <div className="flex items-center gap-1 ml-2">
          {(["all", "ok", "error"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={cn("px-2 py-0.5 rounded text-xs font-sans transition-colors",
                filter === f ? "bg-zinc-700 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"
              )}>
              {f}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 font-sans text-zinc-500 cursor-pointer select-none">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)}
              className="w-3 h-3 rounded border-zinc-600 bg-zinc-800" />
            Auto-scroll
          </label>
          <button onClick={() => setEntries([])}
            className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors font-sans">
            <Trash2 size={12} />
            Clear
          </button>
        </div>
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-zinc-600">
            <Terminal size={24} />
            <p className="font-sans text-sm">Waiting for commands…</p>
          </div>
        )}

        {filtered.map((entry) => {
          const isOpen = expanded.has(entry.id);
          const ok = entry.result?.ok !== false && entry.type !== "error";

          return (
            <div key={entry.id} className="group">
              <button
                onClick={() => toggle(entry.id)}
                className="w-full flex items-start gap-2 text-left hover:bg-white/5 rounded px-2 py-1 transition-colors"
              >
                <span className="text-zinc-600 flex-shrink-0 mt-0.5">
                  {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                </span>
                <span className="text-zinc-600 flex-shrink-0">{fmt(entry.ts)}</span>
                <span className="flex-shrink-0">
                  {ok
                    ? <CheckCircle size={11} className="text-emerald-500 mt-0.5" />
                    : <XCircle size={11} className="text-red-500 mt-0.5" />}
                </span>
                <span className={cn("flex-shrink-0 font-semibold", ok ? "text-[#1fd1bd]" : "text-red-400")}>
                  {entry.script ?? entry.type}
                </span>
                {entry.mocked && (
                  <span className="flex-shrink-0 text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">MOCK</span>
                )}
                {entry.args && entry.args.length > 0 && (
                  <span className="text-zinc-500 truncate">
                    {entry.args.filter(Boolean).map((a) =>
                      a.toLowerCase().includes("pass") ? "***" : a
                    ).join(" ")}
                  </span>
                )}
                {entry.message && <span className="text-zinc-400 truncate">{entry.message}</span>}
                {entry.durationMs != null && (
                  <span className="ml-auto text-zinc-600 flex-shrink-0">{entry.durationMs}ms</span>
                )}
              </button>

              {isOpen && (
                <div className="ml-9 mr-2 mb-2 rounded bg-zinc-900 border border-zinc-800 overflow-hidden">
                  {entry.script && (
                    <div className="px-3 py-2 border-b border-zinc-800">
                      <span className="text-zinc-500">script  </span>
                      <span className="text-zinc-300">{entry.script}</span>
                    </div>
                  )}
                  {entry.args && entry.args.length > 0 && (
                    <div className="px-3 py-2 border-b border-zinc-800">
                      <span className="text-zinc-500">args    </span>
                      {entry.args.map((a, i) => (
                        <span key={i} className="mr-2">
                          <span className="text-zinc-600">[{i}] </span>
                          <span className={cn(
                            a.toLowerCase().includes("pass") ? "text-zinc-600 italic" : "text-zinc-300"
                          )}>
                            {a.toLowerCase().includes("pass") ? "***" : (a || <span className="text-zinc-700">(empty)</span>)}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                  {entry.result != null && (
                    <div className="px-3 py-2 border-b border-zinc-800">
                      <span className="text-zinc-500">result  </span>
                      <span className={entry.result.ok ? "text-emerald-400" : "text-red-400"}>
                        {entry.result.ok ? "ok" : "error"}
                      </span>
                      {entry.result.error && (
                        <span className="text-red-400 ml-2">— {entry.result.error}</span>
                      )}
                    </div>
                  )}
                  {entry.result?.data != null && (
                    <div className="px-3 py-2">
                      <span className="text-zinc-500">data    </span>
                      <pre className="inline text-zinc-300 whitespace-pre-wrap break-all">
                        {JSON.stringify(entry.result.data, null, 2)}
                      </pre>
                    </div>
                  )}
                  {entry.message && (
                    <div className="px-3 py-2">
                      <span className="text-zinc-500">message </span>
                      <span className="text-zinc-300">{entry.message}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
