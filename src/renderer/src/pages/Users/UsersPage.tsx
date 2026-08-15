import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Plus, Search, ServerCrash, Settings, RotateCcw, RefreshCw } from "lucide-react";
import { adAPI, type ADGroup, type ADUser } from "../../adAPI";
import { cn } from "../../lib/cn";
import type { ExternalToast } from "sonner";
import CreateUserWizard from "./CreateUserWizard";
import UserRow from "./UserRow";
import { Kbd } from "../../components/ui/Kbd";
import { usersCache, setUsersCache, type UserWithGroup } from "../../lib/usersCache";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

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
}: {
  toast: { success: ToastFn; error: ToastFn };
  onOpenSettings?: () => void;
}) {
  // Seed from the module-level cache so returning from Settings is instant and
  // doesn't re-fetch the whole directory. A first-ever mount has loaded=false.
  const [groups, setGroups] = useState<ADGroup[]>(usersCache.groups);
  const [allUsers, setAllUsers] = useState<UserWithGroup[]>(usersCache.users);
  const [loadingGroups, setLoadingGroups] = useState(!usersCache.loaded);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(usersCache.error);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "create">("list");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Lazy render: only mount the first slice of rows and grow as the user scrolls
  // near the bottom, so a large directory doesn't build thousands of DOM rows.
  const PAGE = 40;
  const [visibleCount, setVisibleCount] = useState(PAGE);

  // Keep the latest toast fns reachable without making the load callbacks depend
  // on them (the parent may pass a fresh object each render, which would
  // otherwise re-run the mount effect and re-fetch the whole directory).
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const loadAllUsers = useCallback(async (gs: ADGroup[]) => {
    setLoadingUsers(true);
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
    setLoadingUsers(false);

    const failed = results.filter((r) => r.failed).length;
    if (failed > 0) {
      toastRef.current.error(
        failed === gs.length
          ? "Não foi possível carregar os utilizadores do Active Directory. Verifica a ligação."
          : `Não foi possível carregar ${failed} de ${gs.length} grupos — a lista pode estar incompleta.`
      );
    }
  }, []);

  const loadGroups = useCallback(() => {
    setLoadingGroups(true);
    setGroupsError(null);
    adAPI
      .getGroups()
      .then((r) => {
        setLoadingGroups(false);
        if (r.ok) {
          // Windows PowerShell's ConvertTo-Json emits a bare object (not an
          // array) for a single group — normalize so one-group tenants work.
          const gs = toArray<ADGroup>(r.data);
          setGroups(gs);
          setGroupsError(null);
          setUsersCache({ groups: gs, error: null });
          loadAllUsers(gs);
        } else {
          // Explicit, recoverable error state — never a misleading "No users found".
          setGroups([]);
          setAllUsers([]);
          const err = r.error ?? "Não foi possível carregar os grupos do Active Directory.";
          setGroupsError(err);
          setUsersCache({ groups: [], users: [], error: err, loaded: true });
        }
      })
      .catch((e) => {
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

  // Recompute only when the inputs change (not on every keystroke-driven render
  // of unrelated state), and lower-case the query once instead of per user.
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return allUsers.filter((u) => {
      const matchesGroup = !activeGroup || u.groupName === activeGroup;
      const matchesSearch =
        !q ||
        u.DisplayName?.toLowerCase().includes(q) ||
        u.SamAccountName?.toLowerCase().includes(q);
      return matchesGroup && matchesSearch;
    });
  }, [allUsers, activeGroup, search]);

  // Reset the window whenever the result set changes (filter/search/reload).
  useEffect(() => { setVisibleCount(PAGE); }, [search, activeGroup, allUsers]);

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

        {/* Group pills */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setActiveGroup(null)}
            className={cn(
              "px-3 py-1 rounded-full text-xs font-medium transition-colors",
              !activeGroup
                ? "bg-violet-600 text-white"
                : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            )}
          >
            All groups
          </button>
          {loadingGroups
            ? Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-6 w-20 rounded-full bg-zinc-100 animate-pulse" />
              ))
            : groups.map((g) => (
                <button
                  key={g.Name}
                  onClick={() => setActiveGroup(activeGroup === g.Name ? null : g.Name)}
                  className={cn(
                    "px-3 py-1 rounded-full text-xs font-medium transition-colors",
                    activeGroup === g.Name
                      ? "bg-violet-600 text-white"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                  )}
                >
                  {g.Name}
                </button>
              ))}
        </div>
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
            onRetry={loadGroups}
            onOpenSettings={onOpenSettings}
          />
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-sm text-zinc-400">
            {search || activeGroup ? "No users match the current filters" : "No users found"}
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
                <UserRow key={u.SamAccountName || `row-${i}`} user={u} groupName={u.groupName} toast={toast} onRefresh={refresh} />
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
            {(search || activeGroup) && " — filtered"}
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
