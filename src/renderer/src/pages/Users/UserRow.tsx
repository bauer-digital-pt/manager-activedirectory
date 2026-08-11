import { useState, useEffect, useRef } from "react";
import { Lock, Unlock, KeyRound, MoreHorizontal, X, User } from "lucide-react";
import { adAPI, type ADUser } from "../../adAPI";
import { cn } from "../../lib/cn";
import type { ExternalToast } from "sonner";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

const DEFAULT_PASSWORD = "Passw0rd#123";

export default function UserRow({
  user,
  groupName,
  toast,
  onRefresh,
}: {
  user: ADUser;
  groupName?: string;
  toast: { success: ToastFn; error: ToastFn };
  onRefresh: () => void;
}) {
  const [menu, setMenu]   = useState(false);
  const [modal, setModal] = useState<"reset" | "unblock" | "details" | null>(null);
  const [busy, setBusy]   = useState(false);
  const menuRef           = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menu]);

  // Keyboard binds while dropdown menu is open
  useEffect(() => {
    if (!menu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setMenu(false); return; }
      const k = e.key.toLowerCase();
      if (k === "o") { e.preventDefault(); setMenu(false); setModal("details"); }
      if (k === "r") { e.preventDefault(); setMenu(false); setModal("reset"); }
      if (k === "u" && user.LockedOut) { e.preventDefault(); setMenu(false); setModal("unblock"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [menu, user.LockedOut]);

  // Keyboard binds while a modal is open
  useEffect(() => {
    if (!modal) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setModal(null); }
      if (e.key === "Enter" && !busy) {
        e.preventDefault();
        if (modal === "reset") doReset();
        if (modal === "unblock") doUnlock();
        if (modal === "details") setModal(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [modal, busy]);

  // Guard against malformed AD records (a member with no DisplayName *and* no
  // SamAccountName — e.g. a nested group or computer account). A raw
  // `.split()` on undefined here throws and, without a boundary, blanks the app.
  const displayName = user.DisplayName || user.SamAccountName || "—";
  const initials =
    (displayName
      .split(" ")
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?");

  const doReset = async () => {
    setBusy(true);
    const r = await adAPI.resetPassword({ username: user.SamAccountName, newPassword: DEFAULT_PASSWORD });
    setBusy(false);
    if (r.ok) { toast.success(`Password reset for ${user.SamAccountName}`); setModal(null); }
    else toast.error(r.error ?? "Failed to reset password");
  };

  const doUnlock = async () => {
    setBusy(true);
    const r = await adAPI.unlockUser(user.SamAccountName);
    setBusy(false);
    if (r.ok) { toast.success(`${user.SamAccountName} unlocked`); setModal(null); onRefresh(); }
    else toast.error(r.error ?? "Failed to unlock account");
  };

  const statusBadge = () => {
    if (user.LockedOut)
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-600 border border-red-200"><Lock size={10} />Locked</span>;
    if (!user.Enabled)
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-600 border border-amber-200">Disabled</span>;
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-600 border border-emerald-200"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Active</span>;
  };

  return (
    <>
      <tr className="group hover:bg-zinc-50/80 transition-colors">
        <td className="px-6 py-3.5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-violet-100 flex items-center justify-center flex-shrink-0">
              <span className="text-xs font-semibold text-violet-700">{initials}</span>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-900 truncate">{user.DisplayName || user.SamAccountName}</p>
              <p className="text-xs text-zinc-400 truncate">{user.SamAccountName}</p>
            </div>
          </div>
        </td>
        <td className="px-6 py-3.5 hidden sm:table-cell">
          <span className="text-sm text-zinc-500 truncate">{user.EmailAddress || "—"}</span>
        </td>
        <td className="px-6 py-3.5">
          {groupName && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-100 text-zinc-500">{groupName}</span>
          )}
        </td>
        <td className="px-6 py-3.5">{statusBadge()}</td>
        <td className="px-6 py-3.5 text-right">
          <div className="relative inline-block" ref={menuRef}>
            <button
              onClick={(e) => { e.stopPropagation(); setMenu((v) => !v); }}
              className={cn(
                "p-1.5 rounded-md transition-colors",
                menu
                  ? "bg-zinc-200 text-zinc-700"
                  : "text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 opacity-0 group-hover:opacity-100"
              )}
            >
              <MoreHorizontal size={15} />
            </button>

            {menu && (
              <div className="absolute right-0 mt-1 w-52 bg-white border border-zinc-200 rounded-xl shadow-lg overflow-hidden z-20">
                <MenuItem
                  icon={<User size={13} />}
                  label="Open"
                  bind="O"
                  onClick={() => { setMenu(false); setModal("details"); }}
                />
                <div className="border-t border-zinc-100" />
                <MenuItem
                  icon={<KeyRound size={13} />}
                  label="Reset password"
                  bind="R"
                  onClick={() => { setMenu(false); setModal("reset"); }}
                />
                <MenuItem
                  icon={<Unlock size={13} />}
                  label="Unblock"
                  bind="U"
                  disabled={!user.LockedOut}
                  onClick={() => { setMenu(false); setModal("unblock"); }}
                />
              </div>
            )}
          </div>
        </td>
      </tr>

      {/* ── Modals ── */}
      {modal && (
        <tr>
          <td colSpan={5} className="p-0 border-0">
            <div
              role="dialog"
              aria-modal="true"
              className="fixed inset-0 z-30 bg-black/30 backdrop-blur-sm flex items-center justify-center"
              onClick={() => setModal(null)}
            >
              <div
                className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden"
                onClick={(e) => e.stopPropagation()}
              >

                {/* Reset password */}
                {modal === "reset" && (
                  <>
                    <ModalHeader icon={<KeyRound size={15} />} title="Reset password" subtitle={user.DisplayName || user.SamAccountName} onClose={() => setModal(null)} />
                    <div className="px-6 py-5">
                      <p className="text-sm text-zinc-600">
                        The password for <span className="font-medium text-zinc-900">{user.SamAccountName}</span> will be reset to the default temporary password.
                      </p>
                      <p className="mt-2 font-mono text-sm text-zinc-500 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 select-all">{DEFAULT_PASSWORD}</p>
                    </div>
                    <ModalFooter>
                      <Bind label="Esc" />
                      <button onClick={() => setModal(null)} className="px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 rounded-lg transition-colors">Cancel</button>
                      <Bind label="↵" />
                      <button onClick={doReset} disabled={busy} className="px-4 py-2 text-sm font-medium bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-40 transition-colors">
                        {busy ? "Resetting…" : "Reset"}
                      </button>
                    </ModalFooter>
                  </>
                )}

                {/* Unblock */}
                {modal === "unblock" && (
                  <>
                    <ModalHeader icon={<Unlock size={15} />} title="Unblock account" subtitle={user.DisplayName || user.SamAccountName} onClose={() => setModal(null)} />
                    <div className="px-6 py-5">
                      <p className="text-sm text-zinc-600">
                        The account <span className="font-medium text-zinc-900">{user.SamAccountName}</span> is currently locked. Unlock it?
                      </p>
                    </div>
                    <ModalFooter>
                      <Bind label="Esc" />
                      <button onClick={() => setModal(null)} className="px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 rounded-lg transition-colors">Cancel</button>
                      <Bind label="↵" />
                      <button onClick={doUnlock} disabled={busy} className="px-4 py-2 text-sm font-medium bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-40 transition-colors">
                        {busy ? "Unlocking…" : "Unlock"}
                      </button>
                    </ModalFooter>
                  </>
                )}

                {/* Details */}
                {modal === "details" && (
                  <>
                    <ModalHeader icon={<User size={15} />} title="User details" subtitle={user.DisplayName || user.SamAccountName} onClose={() => setModal(null)} />
                    <div className="px-6 py-5 space-y-4 max-h-[60vh] overflow-y-auto">
                      <div className="flex items-center gap-4 pb-4 border-b border-zinc-100">
                        <div className="w-14 h-14 rounded-full bg-violet-100 flex items-center justify-center flex-shrink-0">
                          <span className="text-xl font-semibold text-violet-700">{initials}</span>
                        </div>
                        <div>
                          <p className="text-base font-semibold text-zinc-900">{user.DisplayName || user.SamAccountName}</p>
                          {user.Title && <p className="text-sm text-zinc-500">{user.Title}</p>}
                          <div className="mt-1">{statusBadge()}</div>
                        </div>
                      </div>

                      <DetailSection title="Account">
                        <DetailRow label="Username" value={user.SamAccountName} />
                        {user.UserPrincipalName && <DetailRow label="UPN" value={user.UserPrincipalName} />}
                        {user.EmailAddress      && <DetailRow label="Email" value={user.EmailAddress} />}
                      </DetailSection>

                      {(user.Department || user.Company || user.Description) && (
                        <DetailSection title="Organisation">
                          {user.Department  && <DetailRow label="Department"  value={user.Department} />}
                          {user.Company     && <DetailRow label="Company"     value={user.Company} />}
                          {user.Description && <DetailRow label="Description" value={user.Description} />}
                        </DetailSection>
                      )}

                      {(user.StreetAddress || user.City || user.PostalCode || user.Office) && (
                        <DetailSection title="Address">
                          {user.Office        && <DetailRow label="Office"      value={user.Office} />}
                          {user.StreetAddress && <DetailRow label="Street"      value={user.StreetAddress} />}
                          {user.City          && <DetailRow label="City"        value={user.City} />}
                          {user.PostalCode    && <DetailRow label="Postal code" value={user.PostalCode} />}
                        </DetailSection>
                      )}

                      {user.DistinguishedName && (
                        <DetailSection title="Directory">
                          <DetailRow label="DN" value={user.DistinguishedName} mono />
                        </DetailSection>
                      )}
                    </div>
                    <ModalFooter>
                      <Bind label="Esc / ↵" />
                      <button onClick={() => setModal(null)} className="px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 rounded-lg transition-colors">Close</button>
                    </ModalFooter>
                  </>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function MenuItem({ icon, label, bind, disabled, onClick }: { icon: React.ReactNode; label: string; bind: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center justify-between px-3.5 py-2.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      <span className="flex items-center gap-2.5">
        <span className="text-zinc-400">{icon}</span>
        {label}
      </span>
      <kbd className="text-xs font-mono bg-zinc-100 text-zinc-400 px-1.5 py-0.5 rounded border border-zinc-200">{bind}</kbd>
    </button>
  );
}

function Bind({ label }: { label: string }) {
  return <kbd className="text-xs font-mono bg-zinc-100 text-zinc-400 px-1.5 py-0.5 rounded border border-zinc-200">{label}</kbd>;
}

function ModalHeader({ icon, title, subtitle, onClose }: { icon: React.ReactNode; title: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="px-6 py-4 border-b border-zinc-100 flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <span className="text-zinc-400">{icon}</span>
        <div>
          <p className="text-sm font-semibold text-zinc-900">{title}</p>
          <p className="text-xs text-zinc-400">{subtitle}</p>
        </div>
      </div>
      <button onClick={onClose} className="p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition-colors">
        <X size={14} />
      </button>
    </div>
  );
}

function ModalFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-6 py-4 border-t border-zinc-100 flex items-center justify-end gap-2">
      {children}
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{title}</p>
      <div className="rounded-xl border border-zinc-100 divide-y divide-zinc-50 overflow-hidden">{children}</div>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between px-4 py-2.5 gap-4">
      <span className="text-xs text-zinc-400 flex-shrink-0 pt-0.5">{label}</span>
      <span className={cn("text-sm text-zinc-800 text-right break-all", mono && "font-mono text-xs")}>{value}</span>
    </div>
  );
}
