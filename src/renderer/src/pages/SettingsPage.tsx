import { useState, useEffect } from "react";
import { Plus, Trash2, X, Settings2, Layers, Server, Loader2, CheckCircle2, XCircle, SlidersHorizontal, RefreshCw } from "lucide-react";
import { getGroupConfig, setGroupConfig, DEFAULT_GROUPS, type GroupConfig } from "../lib/groupsConfig";
import { getConnection, setConnection, type ConnectionInfo } from "../lib/connectionConfig";
import { getSettings, setSettings, type AppSettings } from "../lib/appSettings";
import { getAppVersion } from "../lib/updates";
import UpdateCheckModal from "../components/UpdateCheckModal";
import { adAPI } from "../adAPI";
import { cn } from "../lib/cn";
import type { ExternalToast } from "sonner";

type ToastFn = (msg: string, opts?: ExternalToast) => void;
type Tab = "general" | "groups" | "connection";

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "groups", label: "Onboarding Groups", icon: Layers },
  { id: "connection", label: "AD Connection", icon: Server },
];

interface SettingsPageProps {
  toast: { success: ToastFn; error: ToastFn };
  /** Called after any change to app settings, so the shell can refresh. */
  onSettingsChange?: () => void;
  /** Toggled while the update-check modal is open (suppresses full-screen takeover). */
  onUpdateModal?: (open: boolean) => void;
}

export default function SettingsPage({ toast, onSettingsChange, onUpdateModal }: SettingsPageProps) {
  const [tab, setTab] = useState<Tab>("general");

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b border-zinc-200 px-6">
        <div className="flex items-center gap-6 h-12">
          <span className="text-sm font-semibold text-zinc-900">Settings</span>
          <div className="flex items-center gap-1 h-full">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={cn(
                  "flex items-center gap-1.5 px-3 h-full text-xs font-medium border-b-2 transition-colors",
                  tab === id
                    ? "border-violet-600 text-violet-700"
                    : "border-transparent text-zinc-500 hover:text-zinc-800"
                )}
              >
                <Icon size={13} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {tab === "general" && <GeneralTab toast={toast} onSettingsChange={onSettingsChange} onUpdateModal={onUpdateModal} />}
      {tab === "groups" && <GroupsTab toast={toast} />}
      {tab === "connection" && <ConnectionTab toast={toast} />}
    </div>
  );
}

function GeneralTab({ toast, onSettingsChange, onUpdateModal }: {
  toast: { success: ToastFn; error: ToastFn };
  onSettingsChange?: () => void;
  onUpdateModal?: (open: boolean) => void;
}) {
  const [devMode, setDevMode] = useState(false);
  const [timeout, setTimeoutMin] = useState(30);
  const [version, setVersion] = useState("");
  const [showUpdate, setShowUpdate] = useState(false);

  useEffect(() => {
    getSettings().then((s) => { setDevMode(s.devMode); setTimeoutMin(s.loginTimeoutMin); });
    getAppVersion().then(setVersion);
  }, []);

  const persist = async (patch: Partial<AppSettings>) => {
    const next = await setSettings(patch);
    setDevMode(next.devMode);
    setTimeoutMin(next.loginTimeoutMin);
    onSettingsChange?.();
  };

  const toggleDev = async () => {
    await persist({ devMode: !devMode });
    toast.success(!devMode ? "Modo developer ativado" : "Modo developer desativado");
  };

  const openUpdate = () => { onUpdateModal?.(true); setShowUpdate(true); };
  const closeUpdate = () => { setShowUpdate(false); onUpdateModal?.(false); };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-8 py-6 space-y-8 max-w-xl">
        {/* Developer mode */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">Modo developer</h3>
              <p className="text-xs text-zinc-400 mt-0.5">Mostra a Consola de atividade na barra lateral.</p>
            </div>
            <button
              onClick={toggleDev}
              role="switch"
              aria-checked={devMode}
              className={cn(
                "relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors",
                devMode ? "bg-violet-600" : "bg-zinc-200"
              )}
            >
              <span className={cn(
                "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
                devMode ? "translate-x-5" : "translate-x-0.5"
              )} />
            </button>
          </div>
        </section>

        {/* Login timeout */}
        <section className="space-y-3">
          <div>
            <h3 className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">Tempo de inatividade</h3>
            <p className="text-xs text-zinc-400 mt-0.5">Ao fim deste tempo sem atividade, a sessão bloqueia e pede a palavra-passe.</p>
          </div>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={5}
              max={60}
              step={5}
              value={timeout}
              onChange={(e) => setTimeoutMin(Number(e.target.value))}
              onMouseUp={() => persist({ loginTimeoutMin: timeout })}
              onKeyUp={() => persist({ loginTimeoutMin: timeout })}
              className="flex-1 accent-violet-600"
            />
            <span className="w-16 text-right text-sm font-medium tabular-nums text-zinc-700">{timeout} min</span>
          </div>
        </section>

        {/* Version + updates */}
        <section className="space-y-3">
          <div>
            <h3 className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">Versão</h3>
            <p className="text-xs text-zinc-400 mt-0.5">AD Manager {version || "…"}</p>
          </div>
          <button
            onClick={openUpdate}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium border border-zinc-200 rounded-lg text-zinc-700 hover:bg-zinc-50 transition-colors"
          >
            <RefreshCw size={14} />
            Procurar atualizações
          </button>
        </section>
      </div>

      {showUpdate && <UpdateCheckModal onClose={closeUpdate} />}
    </div>
  );
}

function ConnectionTab({ toast }: { toast: { success: ToastFn; error: ToastFn } }) {
  const [server, setServer] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    getConnection().then((c: ConnectionInfo) => {
      setServer(c.server);
      setUsername(c.username);
      setHasStoredPassword(c.hasPassword);
    });
  }, []);

  // Only send the password when the user actually typed a new one.
  const passwordPayload = () => (passwordTouched ? password : undefined);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await adAPI.testConnection({ server: server.trim(), username: username.trim(), password: passwordPayload() });
      if (res.ok) {
        const d = res.data as { domain?: string; dc?: string } | undefined;
        setResult({ ok: true, message: d?.domain ? `Connected to ${d.domain}` : "Connection successful" });
      } else {
        setResult({ ok: false, message: res.error ?? "Connection failed" });
      }
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : "Connection failed" });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await setConnection({ server: server.trim(), username: username.trim(), password: passwordPayload() });
      if (passwordTouched && password) setHasStoredPassword(true);
      if (passwordTouched && !password) setHasStoredPassword(false);
      setPassword("");
      setPasswordTouched(false);
      toast.success("Connection settings saved");
    } catch {
      toast.error("Failed to save connection settings");
    } finally {
      setSaving(false);
    }
  };

  const clearConnection = async () => {
    await setConnection({ server: "", username: "", password: "" });
    setServer("");
    setUsername("");
    setPassword("");
    setHasStoredPassword(false);
    setPasswordTouched(false);
    setResult(null);
    toast.success("Connection cleared — using local domain");
  };

  const inputCls =
    "w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all placeholder:text-zinc-300";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-8 py-6 space-y-8 max-w-xl">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Remote Active Directory</h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Point the app at a domain controller and authenticate with a specific account.
            Leave the fields empty to use the local domain and the current Windows user.
          </p>
        </div>

        <section className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">Domain controller (IP or host)</label>
            <input value={server} onChange={(e) => { setServer(e.target.value); setResult(null); }} placeholder="ex: pt-srv-dc02 (bmap.lis)" className={inputCls} />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">Username</label>
            <input value={username} onChange={(e) => { setUsername(e.target.value); setResult(null); }} placeholder="e.g. BMAP\administrador" className={inputCls} autoComplete="off" />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setPasswordTouched(true); setResult(null); }}
              placeholder={hasStoredPassword && !passwordTouched ? "•••••••• (saved)" : "Enter password"}
              className={inputCls}
              autoComplete="new-password"
            />
            <p className="text-[11px] text-zinc-400">
              Stored encrypted on this machine. Leave blank to keep the saved password.
            </p>
          </div>
        </section>

        {result && (
          <div className={cn(
            "flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm border",
            result.ok ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-red-50 border-red-200 text-red-600"
          )}>
            {result.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
            <span className="truncate">{result.message}</span>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={test}
            disabled={testing || !server.trim()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium border border-zinc-200 rounded-lg text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 transition-colors"
          >
            {testing ? <Loader2 size={14} className="animate-spin" /> : <Server size={14} />}
            Test connection
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-40 transition-colors"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            Save
          </button>
          <button
            onClick={clearConnection}
            className="ml-auto text-xs text-zinc-400 hover:text-red-500 transition-colors"
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}

function GroupsTab({ toast }: { toast: { success: ToastFn; error: ToastFn } }) {
  const [config, setConfig] = useState<GroupConfig>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [newOnboarding, setNewOnboarding] = useState("");
  const [newADGroup, setNewADGroup] = useState("");
  const [newJobTitle, setNewJobTitle] = useState("");

  useEffect(() => {
    getGroupConfig().then((c) => {
      setConfig(c);
      const keys = Object.keys(c).sort();
      if (keys.length > 0) setSelected(keys[0]);
    });
  }, []);

  const persist = async (next: GroupConfig) => {
    setConfig(next);
    await setGroupConfig(next);
  };

  const entry = selected ? (config[selected] ?? { adGroups: [], jobTitles: [], department: "" }) : null;

  const updateEntry = async (key: string, patch: Partial<typeof entry>) => {
    if (!key) return;
    const current = config[key] ?? { adGroups: [], jobTitles: [], department: "" };
    await persist({ ...config, [key]: { ...current, ...patch } });
  };

  const addOnboardingGroup = async () => {
    const key = newOnboarding.trim().toUpperCase().replace(/\s+/g, "_");
    if (!key || key in config) return;
    await persist({ ...config, [key]: { adGroups: [], jobTitles: [], department: "" } });
    setNewOnboarding("");
    setSelected(key);
    toast.success(`Group "${key}" created`);
  };

  const removeOnboardingGroup = async (key: string) => {
    const next = { ...config };
    delete next[key];
    await persist(next);
    const remaining = Object.keys(next).sort();
    setSelected(remaining[0] ?? null);
    toast.success(`Group "${key}" removed`);
  };

  const addADGroup = async () => {
    if (!selected || !newADGroup.trim()) return;
    const val = newADGroup.trim();
    const current = entry?.adGroups ?? [];
    if (current.includes(val)) return;
    await updateEntry(selected, { adGroups: [...current, val] });
    setNewADGroup("");
  };

  const removeADGroup = async (adGroup: string) => {
    if (!selected || !entry) return;
    await updateEntry(selected, { adGroups: entry.adGroups.filter((g) => g !== adGroup) });
  };

  const addJobTitle = async () => {
    if (!selected || !newJobTitle.trim()) return;
    const val = newJobTitle.trim();
    const current = entry?.jobTitles ?? [];
    if (current.includes(val)) return;
    await updateEntry(selected, { jobTitles: [...current, val] });
    setNewJobTitle("");
  };

  const removeJobTitle = async (title: string) => {
    if (!selected || !entry) return;
    await updateEntry(selected, { jobTitles: entry.jobTitles.filter((t) => t !== title) });
  };

  const setDepartment = async (value: string) => {
    if (!selected) return;
    await updateEntry(selected, { department: value });
  };

  const resetDefaults = async () => {
    await persist(structuredClone(DEFAULT_GROUPS));
    setSelected(Object.keys(DEFAULT_GROUPS).sort()[0]);
    toast.success("Reset to defaults");
  };

  const sortedKeys = Object.keys(config).sort();

  return (
    <div className="flex flex-1 overflow-hidden">

      {/* Left — group list */}
      <div className="w-56 flex-shrink-0 border-r border-zinc-200 flex flex-col overflow-hidden bg-zinc-50/40">
        <div className="px-4 py-4 space-y-3">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Groups</p>
          <div className="flex gap-2">
            <input
              value={newOnboarding}
              onChange={(e) => setNewOnboarding(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addOnboardingGroup()}
              placeholder="Add group…"
              className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-white border border-zinc-200 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all placeholder:text-zinc-300"
            />
            <button
              onClick={addOnboardingGroup}
              disabled={!newOnboarding.trim()}
              className="w-7 h-7 flex items-center justify-center rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40 transition-colors flex-shrink-0"
            >
              <Plus size={13} strokeWidth={2.5} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sortedKeys.map((key) => {
            const isActive = selected === key;
            const count = (config[key]?.adGroups ?? []).length;
            return (
              <button
                key={key}
                onClick={() => setSelected(key)}
                className={cn(
                  "w-full flex items-center justify-between px-4 py-2.5 text-sm transition-colors text-left group",
                  isActive
                    ? "bg-white border-r-2 border-violet-500 text-zinc-900 font-medium"
                    : "text-zinc-600 hover:bg-white/60 hover:text-zinc-900"
                )}
              >
                <span className="truncate">{key}</span>
                {count > 0 && (
                  <span className={cn(
                    "text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0",
                    isActive ? "bg-violet-100 text-violet-700" : "bg-zinc-100 text-zinc-400"
                  )}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-zinc-200">
          <button onClick={resetDefaults} className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
            Reset to defaults
          </button>
        </div>
      </div>

      {/* Right — detail panel */}
      {!selected || !entry ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-zinc-400">
          <Settings2 size={24} className="text-zinc-300" />
          <p className="text-sm">Select a group to configure</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Header */}
          <div className="px-8 py-5 border-b border-zinc-200 flex items-start justify-between">
            <div>
              <h2 className="text-sm font-semibold text-zinc-900">{selected}</h2>
              <p className="text-xs text-zinc-400 mt-0.5">Configure onboarding defaults for <span className="text-zinc-600 font-medium">{selected}</span></p>
            </div>
            <button
              onClick={() => removeOnboardingGroup(selected)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors flex-shrink-0"
            >
              <Trash2 size={11} />
              Delete
            </button>
          </div>

          <div className="px-8 py-6 space-y-8 max-w-xl">

            {/* Department */}
            <section className="space-y-3">
              <div>
                <h3 className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">Department</h3>
                <p className="text-xs text-zinc-400 mt-0.5">Pre-filled when creating a user in this group.</p>
              </div>
              <input
                value={entry.department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder="Ex: Redação"
                className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all placeholder:text-zinc-300"
              />
            </section>

            {/* Job Titles */}
            <section className="space-y-3">
              <div>
                <h3 className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">Job title suggestions</h3>
                <p className="text-xs text-zinc-400 mt-0.5">Shown as autocomplete when creating a user in this group.</p>
              </div>
              <div className="flex gap-2">
                <input
                  value={newJobTitle}
                  onChange={(e) => setNewJobTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addJobTitle()}
                  placeholder="Ex: Jornalista"
                  className="flex-1 px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all placeholder:text-zinc-300"
                />
                <button
                  onClick={addJobTitle}
                  disabled={!newJobTitle.trim()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-40 transition-colors"
                >
                  <Plus size={14} strokeWidth={2.5} />
                  Add
                </button>
              </div>
              {entry.jobTitles.length === 0 ? (
                <div className="flex items-center justify-center h-20 rounded-xl border-2 border-dashed border-zinc-200 text-zinc-400">
                  <p className="text-sm">No job title suggestions</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {entry.jobTitles.map((t) => (
                    <div key={t} className="flex items-center justify-between px-4 py-2.5 bg-white border border-zinc-200 rounded-xl group hover:border-zinc-300 transition-colors">
                      <span className="text-sm text-zinc-800">{t}</span>
                      <button
                        onClick={() => removeJobTitle(t)}
                        className="p-1.5 rounded-md text-zinc-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* AD Groups */}
            <section className="space-y-3">
              <div>
                <h3 className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">AD Groups</h3>
                <p className="text-xs text-zinc-400 mt-0.5">AD groups the user is added to during onboarding.</p>
              </div>
              <div className="flex gap-2">
                <input
                  value={newADGroup}
                  onChange={(e) => setNewADGroup(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addADGroup()}
                  placeholder="e.g. GRP_REDACAO_EDITOR"
                  className="flex-1 px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all placeholder:text-zinc-300"
                />
                <button
                  onClick={addADGroup}
                  disabled={!newADGroup.trim()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-40 transition-colors"
                >
                  <Plus size={14} strokeWidth={2.5} />
                  Add
                </button>
              </div>
              {entry.adGroups.length === 0 ? (
                <div className="flex items-center justify-center h-20 rounded-xl border-2 border-dashed border-zinc-200 text-zinc-400">
                  <p className="text-sm">No AD groups configured</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {entry.adGroups.map((g) => (
                    <div key={g} className="flex items-center justify-between px-4 py-2.5 bg-white border border-zinc-200 rounded-xl group hover:border-zinc-300 transition-colors">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-6 h-6 rounded-md bg-violet-50 border border-violet-100 flex items-center justify-center flex-shrink-0">
                          <span className="text-xs font-bold text-violet-400">#</span>
                        </div>
                        <span className="text-sm font-medium text-zinc-800 truncate">{g}</span>
                      </div>
                      <button
                        onClick={() => removeADGroup(g)}
                        className="p-1.5 rounded-md text-zinc-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
