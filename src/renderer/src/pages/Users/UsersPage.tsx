import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, Search } from "lucide-react";
import { adAPI, type ADGroup, type ADUser } from "../../adAPI";
import { cn } from "../../lib/cn";
import type { ExternalToast } from "sonner";
import CreateUserWizard from "./CreateUserWizard";
import UserRow from "./UserRow";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

interface UserWithGroup extends ADUser { groupName: string; }

export default function UsersPage({ toast }: { toast: { success: ToastFn; error: ToastFn } }) {
  const [groups, setGroups] = useState<ADGroup[]>([]);
  const [allUsers, setAllUsers] = useState<UserWithGroup[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "create">("list");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    adAPI.getGroups().then((r) => {
      setLoadingGroups(false);
      if (r.ok && Array.isArray(r.data)) {
        const gs = r.data as ADGroup[];
        setGroups(gs);
        loadAllUsers(gs);
      } else {
        toast.error(r.error ?? "Failed to load groups");
      }
    });
  }, []);

  const loadAllUsers = async (gs: ADGroup[]) => {
    setLoadingUsers(true);
    const results = await Promise.all(
      gs.map((g) =>
        adAPI.getGroupMembers(g.Name).then((r) => {
          if (r.ok && Array.isArray(r.data))
            return (r.data as ADUser[]).map((u) => ({ ...u, groupName: g.Name }));
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
    setLoadingUsers(false);
  };

  const refresh = () => {
    if (groups.length > 0) loadAllUsers(groups);
  };

  const goCreate = useCallback(() => setView("create"), []);

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
              onClick={() => setView("create")}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-violet-600 text-white rounded-md hover:bg-violet-700 transition-colors"
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
              {filtered.map((u) => (
                <UserRow key={u.SamAccountName} user={u} groupName={u.groupName} toast={toast} onRefresh={refresh} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      {!isLoading && filtered.length > 0 && (
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
