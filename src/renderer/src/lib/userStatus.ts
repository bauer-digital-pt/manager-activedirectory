// Single source of truth for how a user's account state is collapsed into one
// "kind" — used by the Users list badge (UserRow) and by the default ordering
// (UsersPage). Keeping it here means the badge you see and the bucket a row
// lands in can never disagree.
//
// Precedence is *disabled-dominant*: a disabled account is parked/offboarded, so
// its lock or password-expiry is moot and it always reads as "disabled" (and
// sorts to the very bottom). An *enabled* account that is locked out or has an
// expired password is a "problem" needing operator action and sorts to the top.
// Everything else is healthy/active.
import type { ADUser } from "../adAPI";

export type UserStatusKind = "disabled" | "locked" | "expired" | "active";

type StatusFields = Pick<ADUser, "Enabled" | "LockedOut" | "PasswordExpired">;

export function userStatusKind(u: StatusFields): UserStatusKind {
  if (!u.Enabled) return "disabled";
  if (u.LockedOut) return "locked";
  if (u.PasswordExpired) return "expired";
  return "active";
}

// Default-sort bucket. Lower = higher up the list:
//   0 = problem   (enabled + locked or password-expired) — needs attention first
//   1 = active    (healthy)
//   2 = disabled  (parked) — last
export function userStatusRank(u: StatusFields): number {
  const k = userStatusKind(u);
  if (k === "locked" || k === "expired") return 0;
  if (k === "active") return 1;
  return 2;
}
