// A tiny navigation guard so an in-progress flow (e.g. the create-user wizard)
// can veto a page switch / logout that would silently throw away typed data.
//
// The guard lives outside React state on purpose: navigation is triggered from
// App (sidebar clicks, number hotkeys, logout) while the "dirty" flow is mounted
// deep inside a page, so there's no clean prop path between them. A component
// registers a predicate while it has unsaved data and clears it on unmount.
//
// The predicate returns true to ALLOW navigation, false to cancel it — typically
// it delegates to window.confirm(...).

let guard: (() => boolean) | null = null;

export function setNavGuard(fn: (() => boolean) | null): void {
  guard = fn;
}

// Returns true if navigation may proceed. With no guard registered, always true.
export function confirmNav(): boolean {
  return guard ? guard() : true;
}
