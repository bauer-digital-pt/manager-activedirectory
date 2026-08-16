import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Plus, Search, ServerCrash, Settings, RotateCcw, RefreshCw,
  Folder, Activity, Building2, BadgeCheck, ArrowUpNarrowWide, ArrowDownWideNarrow, X,
} from "lucide-react";
import { adAPI, type ADGroup, type ADUser } from "../../adAPI";
import { cn } from "../../lib/cn";
import type { ExternalToast } from "sonner";
import CreateUserWizard from "./CreateUserWizard";
import UserRow from "./UserRow";
import FilterDropdown, { type FilterOption } from "../../components/ui/FilterDropdown";
import { Kbd } from "../../components/ui/Kbd";
import { userStatusRank } from "../../lib/userStatus";
import { usersCache, setUsersCache, type UserWithGroup } from "../../lib/usersCache";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

// Estado (account-state) filter. Values are matched against the raw AD flags —
// deliberately overlapping-friendly: "Locked out" shows every locked account
// even if it's also disabled, whereas "Active" means a clean, healthy account.
type Estado = "active" | "disabled" | "locked" | "expired";
const ESTADO_OPTIONS: FilterOption[] = [
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
  { value: "locked", label: "Locked out" },
  { value: "expired", label: "Password expired" },
];
function matchesEstado(u: ADUser, estado: Estado): boolean {
  switch (estado) {
    case "active":   return !!u.Enabled && !u.LockedOut && !u.PasswordExpired;
    case "disabled": return !u.Enabled;
    case "locked":   return !!u.LockedOut;
    case "expired":  return !!u.PasswordExpired;
  }
}

// "Ordenar por" options. "estado" is the default: bucketed (problem accounts
// first, disabled last), alphabetical within each bucket.
type SortBy = "estado" | "name" | "created" | "updated";
const SORT_OPTIONS: FilterOption[] = [
  { value: "estado",  label: "Estado (padrão)" },
  { value: "name",    label: "Nome" },
  { value: "created", label: "Data de criação" },
  { value: "updated", label: "Último update" },
];

// Parse a directory timestamp — PowerShell "yyyy-MM-dd HH:mm:ss" or the API's
// ISO-8601 — into a comparable epoch, or null when absent/unparseable (nulls
// always sort last, regardless of direction).
function toTime(v?: string | null): number | null {
  if (!v) return null;
  const t = Date.parse(v.includes("T") ? v : v.replace(" ", "T"));
  return Number.isNaN(t) ? null : t;
}
function nameOf(u: ADUser): string {
  return (u.DisplayName || u.SamAccountName || "").toLowerCase();
}
function nameCmp(a: ADUser, b: ADUser): number {
  return nameOf(a).localeCompare(nameOf(b), "pt");
}

// Windows PowerShell's ConvertTo-Json returns a bare object for a single result
// and null for none — normalize any of those shapes to a plain array.
function toArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data == null) return [];
  return [data as T];
}

export default function UsersPage({
  toast,
  onOpenSettings,
  kiosk = false,
  ensureFreshAuth,
}: {
  toast: { success: ToastFn; error: ToastFn };
  onOpenSettings?: () => void;
  // Kiosk mode: auto-refresh the directory every 5 min so the top problem
  // accounts (locked / password-expired) stay live on a wall display.
  kiosk?: boolean;
  // Threaded down to each row to gate privileged actions behind a re-auth.
  ensureFreshAuth?: () => Promise<boolean>;
}) {
  // Seed from the module-level cache so returning from Settings is instant and
  // doesn't re-fetch the whole directory. A first-ever mount has loaded=false.
  const [groups, setGroups] = useState<ADGroup[]>(usersCache.groups);
  const [allUsers, setAllUsers] = useState<UserWithGroup[]>(usersCache.users);
  const [loadingGroups, setLoadingGroups] = useState(!usersCache.loaded);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(usersCache.error);
  // The four filter TYPES (null = "all") + the sort control.
  const [activeOU, setActiveOU] = useState<string | null>(null);
  const [estado, setEstado] = useState<string | null>(null);
  const [departamento, setDepartamento] = useState<string | null>(null);
  const [tipoConta, setTipoConta] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("estado");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [view, setView] = useState<"list" | "create">("list");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Lazy render: only mount the first slice of rows and grow as the user scrolls
  // near the bottom, so a large directory doesn't build thousands of DOM rows.
  const PAGE = 30;
  const [visibleCount, setVisibleCount] = useState(PAGE);

  // Keep the latest toast fns reachable without making the load callbacks depend
  // on them (the parent may pass a fresh object each render, which would
  // otherwise re-run the mount effect and re-fetch the whole directory).
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // `background` (kiosk auto-refresh) reloads without the loading skeleton and,
  // on a partial/total failure, keeps the last-good list instead of wiping it or
  // nagging with a toast — a wall display should stay showing stale-but-useful
  // data rather than flashing an error every 5 minutes.
  const loadAllUsers = useCallback(async (gs: ADGroup[], background = false) => {
    if (!background) setLoadingUsers(true);
    const results = await Promise.all(
      gs.map((g) =>
        adAPI.getGroupMembers(g.Name).then((r) => {
          if (r.ok)
            // Same single-item serialization quirk as groups (one-member group).
            return { failed: false, members: toArray<ADUser>(r.data).map((u) => ({ ...u, groupName: g.Name })) };
          // A query failure (unreachable DC, bad credentials) must NOT silently
          // look like an empty team — track it so we can warn the user.
          return { failed: true, members: [] as UserWithGroup[] };
        })
      )
    );
    const failed = results.filter((r) => r.failed).length;

    // In the background, only swap in a fully-successful reload — a transient
    // failure must not blank out teams the operator can still see.
    if (background && failed > 0) return;

    // Dedupe by SamAccountName, keeping first occurrence
    const seen = new Set<string>();
    const merged: UserWithGroup[] = [];
    for (const { members } of results) {
      for (const u of members) {
        if (!seen.has(u.SamAccountName)) {
          seen.add(u.SamAccountName);
          merged.push(u);
        }
      }
    }
    setAllUsers(merged);
    setUsersCache({ users: merged, loaded: true });
    if (!background) setLoadingUsers(false);

    if (failed > 0 && !background) {
      toastRef.current.error(
        failed === gs.length
          ? "Não foi possível carregar os utilizadores do Active Directory. Verifica a ligação."
          : `Não foi possível carregar ${failed} de ${gs.length} grupos — a lista pode estar incompleta.`
      );
    }
  }, []);

  const loadGroups = useCallback((background = false) => {
    if (!background) { setLoadingGroups(true); setGroupsError(null); }
    adAPI
      .getGroups()
      .then((r) => {
        if (!background) setLoadingGroups(false);
        if (r.ok) {
          // Windows PowerShell's ConvertTo-Json emits a bare object (not an
          // array) for a single group — normalize so one-group tenants work.
          const gs = toArray<ADGroup>(r.data);
          setGroups(gs);
          setGroupsError(null);
          setUsersCache({ groups: gs, error: null });
          loadAllUsers(gs, background);
        } else if (!background) {
          // Explicit, recoverable error state — never a misleading "No users found".
          setGroups([]);
          setAllUsers([]);
          const err = r.error ?? "Não foi possível carregar os grupos do Active Directory.";
          setGroupsError(err);
          setUsersCache({ groups: [], users: [], error: err, loaded: true });
        }
        // background + failure: keep the last-good view untouched.
      })
      .catch((e) => {
        if (background) return; // keep last-good on a background hiccup
        setLoadingGroups(false);
        setGroups([]);
        setAllUsers([]);
        const err =
          typeof e?.message === "string"
            ? e.message
            : "Não foi possível comunicar com o Active Directory.";
        setGroupsError(err);
        setUsersCache({ groups: [], users: [], error: err, loaded: true });
      });
  }, [loadAllUsers]);

  useEffect(() => {
    // Only fetch on the first ever mount; subsequent mounts reuse the cache.
    if (!usersCache.loaded) loadGroups();
  }, [loadGroups]);

  // Kiosk: silently refresh the directory every 5 minutes so the live view (and
  // the top locked/expired bucket) stays current without any operator action.
  useEffect(() => {
    if (!kiosk) return;
    const id = setInterval(() => loadGroups(true), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [kiosk, loadGroups]);

  // Full reload — used by the toolbar refresh button and after creating a user.
  const refresh = useCallback(() => {
    loadGroups();
  }, [loadGroups]);

  // Creating a user requires at least one group to place them in. With no
  // groups the wizard would be a dead-end, so the entry points no-op instead.
  const canCreate = groups.length > 0;
  const goCreate = useCallback(() => {
    if (groups.length > 0) setView("create");
  }, [groups.length]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // The wizard mounts in place of the list (view === "create") but this
      // component's hooks keep running, so bail out or we'd fight the wizard's
      // own global key handlers and poke a now-unmounted search input.
      if (view !== "list") return;
      // A per-row modal (reset / unblock / details) is open — don't steal its
      // keystrokes into the search box hidden behind it.
      if (document.querySelector('[role="dialog"]')) return;
      const tag = (e.target as HTMLElement).tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA";
      if (inInput) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "n") { e.preventDefault(); goCreate(); return; }

      // Any printable character focuses search and inserts it
      if (e.key.length === 1) {
        e.preventDefault();
        searchRef.current?.focus();
        setSearch((s) => s + e.key);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goCreate, view]);

  // Distinct Departamento / Tipo de conta values, drawn from the loaded users so
  // the dropdowns only ever offer values that actually exist in the directory.
  const departamentoOptions = useMemo<FilterOption[]>(() => {
    const set = new Set<string>();
    for (const u of allUsers) if (u.Department) set.add(u.Department);
    return [...set].sort((a, b) => a.localeCompare(b, "pt")).map((d) => ({ value: d, label: d }));
  }, [allUsers]);
  const tipoContaOptions = useMemo<FilterOption[]>(() => {
    const set = new Set<string>();
    for (const u of allUsers) if (u.employeeType) set.add(u.employeeType);
    return [...set].sort((a, b) => a.localeCompare(b, "pt")).map((t) => ({ value: t, label: t }));
  }, [allUsers]);

  const ouOptions = useMemo<FilterOption[]>(
    () => groups.map((g) => ({ value: g.Name, label: g.Name })),
    [groups],
  );

  const anyFilterActive = !!(activeOU || estado || departamento || tipoConta || search.trim());
  const clearFilters = useCallback(() => {
    setActiveOU(null); setEstado(null); setDepartamento(null); setTipoConta(null); setSearch("");
  }, []);

  // Filter by all four types + free-text, then sort. Recomputes only when an
  // input actually changes (not on every unrelated keystroke-driven render).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = allUsers.filter((u) => {
      if (activeOU && u.groupName !== activeOU) return false;
      if (departamento && (u.Department ?? "") !== departamento) return false;
      if (tipoConta && (u.employeeType ?? "") !== tipoConta) return false;
      if (estado && !matchesEstado(u, estado as Estado)) return false;
      if (
        q &&
        !(
          u.DisplayName?.toLowerCase().includes(q) ||
          u.SamAccountName?.toLowerCase().includes(q) ||
          u.EmailAddress?.toLowerCase().includes(q)
        )
      )
        return false;
      return true;
    });

    const dir = sortDir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => {
      switch (sortBy) {
        case "name":
          return dir * nameCmp(a, b);
        case "created":
        case "updated": {
          const ta = toTime(sortBy === "created" ? a.WhenCreated : a.WhenChanged);
          const tb = toTime(sortBy === "created" ? b.WhenCreated : b.WhenChanged);
          if (ta === null && tb === null) return nameCmp(a, b);
          if (ta === null) return 1;  // missing timestamps always sort last
          if (tb === null) return -1;
          return dir * (ta - tb) || nameCmp(a, b);
        }
        case "estado":
        default:
          // Buckets first (problem → active → disabled), alphabetical within.
          return dir * (userStatusRank(a) - userStatusRank(b)) || nameCmp(a, b);
      }
    });
  }, [allUsers, activeOU, departamento, tipoConta, estado, search, sortBy, sortDir]);

  // Reset the render window whenever the filter/sort inputs change. Note this is
  // deliberately NOT keyed on `allUsers`, so a kiosk background refresh swaps the
  // data in place without yanking the operator back to the top of the list.
  useEffect(() => {
    setVisibleCount(PAGE);
  }, [search, activeOU, estado, departamento, tipoConta, sortBy, sortDir]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  // Grow the window as the scroll position approaches the bottom.
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 280) {
      setVisibleCount((n) => Math.min(n + PAGE, filtered.length));
    }
  };

  if (view === "create") {
    return (
      <CreateUserWizard
        groups={groups}
        toast={toast}
        ensureFreshAuth={ensureFreshAuth}
        onClose={() => { setView("list"); refresh(); }}
      />
    );
  }

  const isLoading = loadingGroups || loadingUsers;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="px-6 pt-5 pb-4 border-b border-zinc-200 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900">Users</h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
              <input
                ref={searchRef}
                placeholder="Search users..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 pr-3 py-1.5 text-sm bg-zinc-50 border border-zinc-200 rounded-md w-52 focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all"
              />
            </div>
            <button
              onClick={refresh}
              disabled={isLoading}
              title="Recarregar do Active Directory"
              className="inline-flex items-center justify-center p-1.5 text-zinc-500 bg-zinc-50 border border-zinc-200 rounded-md hover:bg-zinc-100 hover:text-zinc-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw size={14} className={cn(isLoading && "animate-spin")} />
            </button>
            <button
              onClick={goCreate}
              disabled={!canCreate}
              title={canCreate ? undefined : "Sem grupos disponíveis para criar utilizadores"}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-violet-600 text-white rounded-md hover:bg-violet-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-violet-600"
            >
              <Plus size={14} strokeWidth={2.5} />
              New user
              <Kbd tone="violet" className="ml-1">N</Kbd>
            </button>
          </div>
        </div>

        {/* Filter types + sort control */}
        {loadingGroups ? (
          <div className="flex items-center gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 w-28 rounded-lg bg-zinc-100 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <FilterDropdown
              label="OU"
              icon={<Folder size={13} />}
              allLabel="Todas"
              value={activeOU}
              options={ouOptions}
              onChange={setActiveOU}
            />
            <FilterDropdown
              label="Estado"
              icon={<Activity size={13} />}
              allLabel="Todos"
              value={estado}
              options={ESTADO_OPTIONS}
              onChange={setEstado}
            />
            <FilterDropdown
              label="Departamento"
              icon={<Building2 size={13} />}
              allLabel="Todos"
              value={departamento}
              options={departamentoOptions}
              onChange={setDepartamento}
            />
            <FilterDropdown
              label="Tipo de conta"
              icon={<BadgeCheck size={13} />}
              allLabel="Todos"
              value={tipoConta}
              options={tipoContaOptions}
              onChange={setTipoConta}
            />

            {/* Sort: choose the key, then toggle asc/desc. */}
            <div className="ml-auto flex items-center gap-1.5">
              <FilterDropdown
                label="Ordenar por"
                allowAll={false}
                value={sortBy}
                options={SORT_OPTIONS}
                onChange={(v) => setSortBy((v as SortBy) ?? "estado")}
              />
              <button
                type="button"
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                title={sortDir === "asc" ? "Ascendente" : "Descendente"}
                className="inline-flex items-center justify-center rounded-lg border border-zinc-200 bg-white p-1.5 text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-700"
              >
                {sortDir === "asc" ? <ArrowUpNarrowWide size={15} /> : <ArrowDownWideNarrow size={15} />}
              </button>
            </div>

            {anyFilterActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
              >
                <X size={13} />
                Limpar
              </button>
            )}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto" onScroll={onScroll}>
        {isLoading ? (
          <div className="px-6 py-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-14 bg-zinc-50 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : groupsError ? (
          <GroupsError
            message={groupsError}
            onRetry={() => loadGroups()}
            onOpenSettings={onOpenSettings}
          />
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-sm text-zinc-400">
            {anyFilterActive ? "No users match the current filters" : "No users found"}
          </div>
        ) : (
          <table className="anim-fade-in w-full">
            <thead>
              <tr className="border-b border-zinc-100">
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider">User</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider hidden sm:table-cell">Email</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider">Group</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-zinc-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50">
              {visible.map((u, i) => (
                <UserRow key={u.SamAccountName || `row-${i}`} user={u} groupName={u.groupName} toast={toast} onRefresh={refresh} ensureFreshAuth={ensureFreshAuth} />
              ))}
            </tbody>
          </table>
        )}
        {hasMore && (
          <div className="px-6 py-3 text-center text-xs text-zinc-400">
            A mostrar {visible.length} de {filtered.length} — continua a fazer scroll para ver mais
          </div>
        )}
      </div>

      {/* Footer */}
      {!isLoading && !groupsError && filtered.length > 0 && (
        <div className="px-6 py-3 border-t border-zinc-100">
          <span className="text-xs text-zinc-400">
            {filtered.length} {filtered.length === 1 ? "user" : "users"}
            {anyFilterActive && " — filtered"}
          </span>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

// Inline, recoverable error shown when groups can't be loaded — points the user
// straight at the AD connection settings instead of a dead "No users found".
function GroupsError({
  message,
  onRetry,
  onOpenSettings,
}: {
  message: string;
  onRetry: () => void;
  onOpenSettings?: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 ring-1 ring-amber-200/70">
        <ServerCrash size={26} strokeWidth={2} />
      </div>
      <h3 className="mt-5 text-base font-semibold text-zinc-900">
        Não foi possível carregar os grupos
      </h3>
      <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-zinc-500">
        {message}
      </p>
      <p className="mt-1 max-w-[46ch] text-xs leading-relaxed text-zinc-400">
        Verifica a ligação ao Active Directory em{" "}
        <span className="font-medium text-zinc-500">Definições → Ligação AD</span>.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700"
        >
          <RotateCcw size={15} />
          Tentar novamente
        </button>
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-800"
          >
            <Settings size={15} />
            Abrir definições
          </button>
        )}
      </div>
    </div>
  );
}
