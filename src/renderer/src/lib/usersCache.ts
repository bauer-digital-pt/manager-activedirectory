// In-memory cache for the Users page. The page unmounts whenever the user opens
// Settings (App toggles `page`), so without this every return would re-fetch all
// groups and all members. We keep the last successful load here and reuse it;
// an explicit refresh (the refresh button, or after creating a user) reloads.
import type { ADGroup, ADUser } from "../adAPI";
import { readCache, writeCache } from "./persistCache";

export interface UserWithGroup extends ADUser {
  groupName: string;
}

// On-disk key + shape for the stale-while-revalidate paint (see persistCache).
// The directory is single-source (the connected AD), so one fixed key is enough.
const DISK_KEY = "users|directory";
type PersistedUsers = { groups: ADGroup[]; users: UserWithGroup[] };

interface UsersCache {
  groups: ADGroup[];
  users: UserWithGroup[];
  loaded: boolean;
  error: string | null;
}

export const usersCache: UsersCache = {
  groups: [],
  users: [],
  loaded: false,
  error: null,
};

export function setUsersCache(next: Partial<UsersCache>): void {
  Object.assign(usersCache, next);
}

// Persist the last-good directory so the next cold launch paints instantly.
// Only a successful, fully-loaded state (never an error) is written to disk.
export function persistUsersCache(): void {
  if (!usersCache.loaded || usersCache.error) return;
  writeCache<PersistedUsers>(DISK_KEY, { groups: usersCache.groups, users: usersCache.users });
}

// Seed the in-memory cache from disk on a cold mount. Returns true when it filled
// the cache with a stale directory (the caller then refreshes in the background).
export function hydrateUsersCacheFromDisk(): boolean {
  if (usersCache.loaded) return true;
  const disk = readCache<PersistedUsers>(DISK_KEY);
  if (disk && disk.groups.length > 0) {
    Object.assign(usersCache, { groups: disk.groups, users: disk.users, loaded: true, error: null });
    return true;
  }
  return false;
}

// Users already living in a category (OU), read straight from the cache — used
// to populate the "copy groups from" dropdowns without re-hitting AD. Callers
// should still fall back to a fetch when `usersCache.loaded` is false.
export function usersInGroup(groupName: string): UserWithGroup[] {
  return usersCache.users.filter((u) => u.groupName === groupName && u.SamAccountName);
}
