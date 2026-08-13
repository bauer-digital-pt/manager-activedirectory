import { useState, useEffect, useMemo } from "react";
import { Plus, Trash2, X, Settings2, Layers, Server, Loader2, CheckCircle2, XCircle, SlidersHorizontal, RefreshCw, MonitorSmartphone } from "lucide-react";
import { getGroupConfig, setGroupConfig, DEFAULT_GROUPS, type GroupConfig } from "../lib/groupsConfig";
import { getConnection, setConnection, type ConnectionInfo } from "../lib/connectionConfig";
import { getSettings, setSettings, type AppSettings } from "../lib/appSettings";
import { getDeviceConfig, setDeviceConfig, DEVICE_DEPARTMENTS, AVAILABLE_PRINTERS, EMPTY_DEVICE_CONFIG, type DeviceConfig } from "../lib/deviceConfig";
import { getAppVersion } from "../lib/updates";
import UpdateCheckModal from "../components/UpdateCheckModal";
import { adAPI, type ADUser, type ADGroup, type DeviceOU } from "../adAPI";
import { usersCache, usersInGroup } from "../lib/usersCache";
import SearchableSelect from "../components/SearchableSelect";
import { cn } from "../lib/cn";
import { inputCls } from "../components/ui/controls";
import { FLAVOR, FLAVOR_UI, type AppFlavor } from "../lib/flavor";
import type { ExternalToast } from "sonner";

type ToastFn = (msg: string, opts?: ExternalToast) => void;
type Tab = "general" | "groups" | "devices" | "connection";

// The Agent installer doesn't manage user-onboarding groups — hide that tab.
const TABS: { id: Tab; label: string; icon: React.ElementType; flavors?: AppFlavor[] }[] = (
  [
    { id: "general", label: "General", icon: SlidersHorizontal },
    { id: "groups", label: "Onboarding Groups", icon: Layers, flavors: ["manager"] },
    { id: "devices", label: "Dispositivos", icon: MonitorSmartphone },
    { id: "connection", label: "AD Connection", icon: Server },
  ] as { id: Tab; label: string; icon: React.ElementType; flavors?: AppFlavor[] }[]
).filter((t) => !t.flavors || t.flavors.includes(FLAVOR));

interface SettingsPageProps {
  toast: { success: ToastFn; error: ToastFn };
  /** Called after any change to app settings, so the shell can refresh. */
  onSettingsChange?: () => void;
  /** Toggled while the update-check modal is open (suppresses full-screen takeover). */
  onUpdateModal?: (open: boolean) => void;
  /** Tab to open on. Defaults to "general". Used to deep-link from Devices. */
  initialTab?: Tab;
}

export default function SettingsPage({ toast, onSettingsChange, onUpdateModal, initialTab = "general" }: SettingsPageProps) {
  const [tab, setTab] = useState<Tab>(initialTab);

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
      {tab === "devices" && <DevicesTab toast={toast} />}
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
            <p className="text-xs text-zinc-400 mt-0.5">{FLAVOR_UI.productName} {version || "…"}</p>
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
            <input value={server} onChange={(e) => { setServer(e.target.value); setResult(null); }} placeholder="ex: 10.4.0.12 ou pt-srv-dc02.bmap.lis" className={inputCls} />
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

function DevicesTab({ toast }: { toast: { success: ToastFn; error: ToastFn } }) {
  const [config, setConfig] = useState<DeviceConfig>(EMPTY_DEVICE_CONFIG);
  const [ous, setOUs] = useState<DeviceOU[]>([]);
  const [loadingOUs, setLoadingOUs] = useState(true);
  const [ouError, setOUError] = useState<string | null>(null);

  useEffect(() => { getDeviceConfig().then(setConfig); }, []);

  // Load the destination folders (sub-OUs under BMAP Devices → O365) once.
  useEffect(() => {
    let cancelled = false;
    setLoadingOUs(true);
    adAPI.getDeviceOUs().then((r) => {
      if (cancelled) return;
      if (r.ok && Array.isArray(r.data)) {
        setOUs(r.data as DeviceOU[]);
        setOUError(null);
      } else {
        setOUs([]);
        setOUError(r.error ?? "Não foi possível carregar as pastas de dispositivos.");
      }
      setLoadingOUs(false);
    });
    return () => { cancelled = true; };
  }, []);

  // Persist the whole config. Selects call this directly; text inputs update
  // local state on change and only persist on blur (one write per edit, not per
  // keystroke). setDeviceConfig normalizes, so empty values are dropped safely.
  const persist = async (next: DeviceConfig) => {
    setConfig(next);
    await setDeviceConfig(next);
  };

  const setOU = (dept: string, value: string) => {
    const ouMap = { ...config.ouMap };
    if (value) ouMap[dept] = value;
    else delete ouMap[dept];
    persist({ ...config, ouMap });
  };

  const togglePrinter = (dept: string, printer: string) => {
    const current = config.printerMap?.[dept] ?? [];
    const next = current.includes(printer)
      ? current.filter((p) => p !== printer)
      : [...current, printer];
    const printerMap = { ...(config.printerMap ?? {}) };
    if (next.length) printerMap[dept] = next;
    else delete printerMap[dept];
    persist({ ...config, printerMap });
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-8 py-6 space-y-8 max-w-xl">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Pastas de dispositivos por departamento</h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Quando um PC entra no domínio fica na pasta errada. Aqui defines em que pasta
            (uma sub-OU de <span className="font-medium text-zinc-500">BMAP Devices → O365</span>) os
            computadores de cada departamento devem ficar. O onboarding move o computador para lá automaticamente.
          </p>
        </div>

        {ouError && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm border bg-amber-50 border-amber-200 text-amber-700">
            <XCircle size={15} className="flex-shrink-0" />
            <span>{ouError}</span>
          </div>
        )}

        <section className="space-y-2">
          {DEVICE_DEPARTMENTS.map((dept) => {
            const stored = config.ouMap[dept] ?? "";
            const missing = stored && !ous.some((o) => o.Name === stored);
            const options = [
              ...(missing ? [{ value: stored, label: `${stored} (não encontrada)` }] : []),
              ...ous.map((o) => ({ value: o.Name, label: o.Name })),
            ];
            return (
              <div key={dept} className="flex items-center gap-3">
                <span className="w-14 flex-shrink-0 text-xs font-semibold text-zinc-600 tabular-nums">{dept}</span>
                <div className="flex-1 min-w-0">
                  <SearchableSelect
                    value={stored}
                    onChange={(v) => setOU(dept, v)}
                    options={options}
                    disabled={loadingOUs}
                    clearable
                    clearLabel="Sem pasta (localização por defeito)"
                    placeholder={loadingOUs ? "A carregar pastas…" : "Sem pasta definida"}
                    searchPlaceholder="Procurar pasta…"
                    emptyText="Nenhuma pasta encontrada"
                  />
                </div>
              </div>
            );
          })}
        </section>

        <section className="space-y-3">
          <div>
            <h3 className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">Impressoras por departamento</h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Durante o onboarding, cada PC recebe as impressoras selecionadas para o seu departamento —
              cada uma instalada pelo script <span className="font-mono text-zinc-500">add&lt;NOME&gt;.cmd</span> em RICOHPCL6.
              Sem seleção, o passo das impressoras é ignorado.
            </p>
          </div>
          <div className="space-y-3">
            {DEVICE_DEPARTMENTS.map((dept) => {
              const selected = config.printerMap?.[dept] ?? [];
              return (
                <div key={dept} className="flex items-start gap-3">
                  <span className="w-14 flex-shrink-0 pt-1 text-xs font-semibold text-zinc-600 tabular-nums">{dept}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {AVAILABLE_PRINTERS.map((p) => {
                      const on = selected.includes(p);
                      return (
                        <button
                          key={p}
                          type="button"
                          onClick={() => togglePrinter(dept, p)}
                          aria-pressed={on}
                          className={cn(
                            "px-2 py-1 text-xs font-medium rounded-md border transition-colors",
                            on
                              ? "bg-violet-600 border-violet-600 text-white hover:bg-violet-700"
                              : "bg-white border-zinc-200 text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"
                          )}
                        >
                          {p}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="space-y-4">
          <div>
            <h3 className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">Instaladores</h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Caminho de rede (NAS) ou URL para os instaladores executados durante o onboarding automático.
              Deixa em branco para usar os caminhos NAS por defeito.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">Cisco AnyConnect</label>
            <input
              value={config.anyConnectSource}
              onChange={(e) => setConfig((c) => ({ ...c, anyConnectSource: e.target.value }))}
              onBlur={() => persist(config)}
              placeholder="ex: \\pt-srv-nas\Software\AnyConnect.msi"
              className={inputCls}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">ScreenConnect</label>
            <input
              value={config.screenConnectSource}
              onChange={(e) => setConfig((c) => ({ ...c, screenConnectSource: e.target.value }))}
              onBlur={() => persist(config)}
              placeholder="ex: \\pt-srv-nas\Software\ScreenConnect.msi"
              className={inputCls}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">Impressoras (pasta RICOHPCL6)</label>
            <input
              value={config.printerSource}
              onChange={(e) => setConfig((c) => ({ ...c, printerSource: e.target.value }))}
              onBlur={() => persist(config)}
              placeholder="ex: \\pt-srv-nas\IT\Software\Printers\RICOHPCL6"
              className={inputCls}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">SMLPlayer (instalador)</label>
            <input
              value={config.smlPlayerSource}
              onChange={(e) => setConfig((c) => ({ ...c, smlPlayerSource: e.target.value }))}
              onBlur={() => persist(config)}
              placeholder="ex: \\pt-srv-nas\IT\Software\SMLPlayer\SMLPlayer-7.11.9357-Install.exe"
              className={inputCls}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">SMLPlayer (Main.ini)</label>
            <input
              value={config.smlPlayerIni}
              onChange={(e) => setConfig((c) => ({ ...c, smlPlayerIni: e.target.value }))}
              onBlur={() => persist(config)}
              placeholder="ex: \\pt-srv-nas\IT\Software\SMLPlayer\Main.ini"
              className={inputCls}
            />
            <p className="text-[11px] text-zinc-400">Copiado para %APPDATA%\SMLPlayer7 depois de abrir/fechar a aplicação.</p>
          </div>
          <button
            onClick={async () => { await persist(config); toast.success("Definições de dispositivos guardadas"); }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors"
          >
            Guardar
          </button>
        </section>
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
  // Members of the selected category (OU), used to pick a default template user.
  // Cache-first: only hits AD when the shared users cache was never warmed.
  const [groupUsers, setGroupUsers] = useState<Record<string, ADUser[]>>({});
  const [loadingGroupUsers, setLoadingGroupUsers] = useState(false);
  // The real category folders (OUs) pulled from AD — the sidebar list.
  const [categories, setCategories] = useState<ADGroup[]>(usersCache.groups);
  const [loadingCategories, setLoadingCategories] = useState(!usersCache.loaded);

  useEffect(() => {
    getGroupConfig().then(setConfig);
  }, []);

  // Load the OU folders for the sidebar — cache-first, fetch only when cold.
  useEffect(() => {
    if (usersCache.loaded || usersCache.groups.length > 0) {
      setCategories(usersCache.groups);
      setLoadingCategories(false);
      return;
    }
    let cancelled = false;
    setLoadingCategories(true);
    adAPI.getGroups().then((r) => {
      if (cancelled) return;
      const gs = r.ok && Array.isArray(r.data) ? (r.data as ADGroup[]) : [];
      setCategories(gs);
      setLoadingCategories(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selected) return;
    const cached = usersInGroup(selected);
    if (usersCache.loaded || cached.length > 0) {
      setGroupUsers((m) => ({ ...m, [selected]: cached }));
      // Clear here too: a cold fetch for a previously-selected group may still
      // be in flight (its .then is cancelled), so this branch must reset the
      // flag or the template picker stays stuck "A carregar".
      setLoadingGroupUsers(false);
      return;
    }
    let cancelled = false;
    setLoadingGroupUsers(true);
    adAPI.getGroupMembers(selected).then((r) => {
      if (cancelled) return;
      const list = (r.ok && Array.isArray(r.data) ? (r.data as ADUser[]) : []).filter((u) => u.SamAccountName);
      setGroupUsers((m) => ({ ...m, [selected]: list }));
      setLoadingGroupUsers(false);
    });
    return () => { cancelled = true; };
  }, [selected]);

  const persist = async (next: GroupConfig) => {
    setConfig(next);
    await setGroupConfig(next);
  };

  const entry = selected ? (config[selected] ?? { adGroups: [], jobTitles: [], department: "", defaultTemplateUser: "" }) : null;

  const updateEntry = async (key: string, patch: Partial<typeof entry>) => {
    if (!key) return;
    const current = config[key] ?? { adGroups: [], jobTitles: [], department: "", defaultTemplateUser: "" };
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

  const setDefaultTemplateUser = async (value: string) => {
    if (!selected) return;
    await updateEntry(selected, { defaultTemplateUser: value });
  };

  const resetDefaults = async () => {
    await persist(structuredClone(DEFAULT_GROUPS));
    setSelected(Object.keys(DEFAULT_GROUPS).sort()[0]);
    toast.success("Reset to defaults");
  };

  // The sidebar shows the real AD OU folders, unioned with any stored config
  // keys (so manually-added or renamed groups don't vanish).
  const sortedKeys = useMemo(
    () => [...new Set([...categories.map((c) => c.Name), ...Object.keys(config)])].sort(),
    [categories, config]
  );

  // Auto-select the first group once the list is known. Re-derives on any
  // membership change (not just a count change) while nothing is selected.
  useEffect(() => {
    if (!selected && sortedKeys.length > 0) setSelected(sortedKeys[0]);
  }, [selected, sortedKeys]);

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
              onClick={() => {
                if (
                  window.confirm(
                    `Remover a configuração de onboarding do grupo "${selected}"?\n\nIsto apaga apenas os valores por defeito guardados na app — não afeta o Active Directory.`
                  )
                )
                  removeOnboardingGroup(selected);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors flex-shrink-0"
            >
              <Trash2 size={11} />
              Delete
            </button>
          </div>

          <div className="px-8 py-6 space-y-8 max-w-xl">

            {/* Default template user — whose group memberships new users copy */}
            <section className="space-y-3">
              <div>
                <h3 className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">Utilizador-modelo</h3>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Novos utilizadores deste grupo copiam os grupos deste utilizador (pré-selecionado no wizard).
                </p>
              </div>
              {(() => {
                const members = groupUsers[selected] ?? [];
                const stored = entry.defaultTemplateUser ?? "";
                const missing = stored && !members.some((u) => u.SamAccountName === stored);
                const options = [
                  // Keep a stored-but-absent selection visible instead of dropping it.
                  ...(missing ? [{ value: stored, label: `${stored} (não encontrado)` }] : []),
                  ...members.map((u) => ({
                    value: u.SamAccountName,
                    label: u.DisplayName || u.SamAccountName,
                    sublabel: u.DisplayName ? u.SamAccountName : undefined,
                  })),
                ];
                return (
                  <SearchableSelect
                    value={stored}
                    onChange={setDefaultTemplateUser}
                    options={options}
                    disabled={loadingGroupUsers}
                    clearable
                    clearLabel="Sem utilizador-modelo"
                    placeholder={
                      loadingGroupUsers
                        ? "A carregar utilizadores…"
                        : members.length === 0
                          ? "Nenhum utilizador nesta pasta"
                          : "Sem utilizador-modelo"
                    }
                    searchPlaceholder="Procurar utilizador…"
                    emptyText="Nenhum utilizador nesta pasta"
                  />
                );
              })()}
            </section>

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
                className={inputCls}
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
