import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, Search, ServerCrash, Settings, RotateCcw, RefreshCw } from "lucide-react";
import { adAPI, type ADGroup, type ADUser } from "../../adAPI";
import { cn } from "../../lib/cn";
import type { ExternalToast } from "sonner";
import CreateUserWizard from "./CreateUserWizard";
import UserRow from "./UserRow";
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

  const loadAllUsers = useCallback(async (gs: ADGroup[]) => {
    setLoadingUsers(true);
    const results = await Promise.all(
      gs.map((g) =>
        adAPI.getGroupMembers(g.Name).then((r) => {
          if (r.ok)
            // Same single-item serialization quirk as groups (one-member group).
            return toArray<ADUser>(r.data).map((u) => ({ ...u, groupName: g.Name }));
          return [] as UserWithGroup[];
        })
      )
    );
    // Dedupe by SamAccountName, keeping first occurrence
    const seen = new Set<string>();
    const merged: UserWithGroup[] = [];
    for (const group of results) {
      for (const u of group) {
        if (!seen.has(u.SamAccountName)) {
          seen.add(u.SamAccountName);
          merged.push(u);
        }
      }
    }
    setAllUsers(merged);
    setUsersCache({ users: merged, loaded: true });
    setLoadingUsers(false);
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
  }, [goCreate]);

  const filtered = allUsers.filter((u) => {
    const matchesGroup = !activeGroup || u.groupName === activeGroup;
    const matchesSearch =
      !search ||
      u.DisplayName?.toLowerCase().includes(search.toLowerCase()) ||
      u.SamAccountName?.toLowerCase().includes(search.toLowerCase());
    return matchesGroup && matchesSearch;
  });

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
              <kbd className="ml-1 text-xs font-mono bg-violet-500/60 text-violet-100 px-1.5 py-0.5 rounded border border-violet-400/40">N</kbd>
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
      <div className="flex-1 overflow-y-auto">
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
          <table className="w-full">
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
              {filtered.map((u, i) => (
                <UserRow key={u.SamAccountName || `row-${i}`} user={u} groupName={u.groupName} toast={toast} onRefresh={refresh} />
              ))}
            </tbody>
          </table>
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
