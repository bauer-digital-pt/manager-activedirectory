// In-memory cache for the Users page. The page unmounts whenever the user opens
// Settings (App toggles `page`), so without this every return would re-fetch all
// groups and all members. We keep the last successful load here and reuse it;
// an explicit refresh (the refresh button, or after creating a user) reloads.
import type { ADGroup, ADUser } from "../adAPI";

export interface UserWithGroup extends ADUser {
  groupName: string;
}

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
