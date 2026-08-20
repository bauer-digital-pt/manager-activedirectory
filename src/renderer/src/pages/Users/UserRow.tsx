import { useState, useEffect, useRef, useId, memo } from "react";
import { Lock, Unlock, KeyRound, MoreHorizontal, X, User, UserMinus, AlertTriangle, Clock } from "lucide-react";
import { adAPI, type ADUser } from "../../adAPI";
import { cn } from "../../lib/cn";
import { initials as computeInitials } from "../../lib/initials";
import { useOutsideClick } from "../../hooks/useOutsideClick";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { userStatusKind } from "../../lib/userStatus";
import { Kbd } from "../../components/ui/Kbd";
import { Button } from "../../components/ui/Button";
import { inputCls, focusRing } from "../../components/ui/controls";
import type { ExternalToast } from "sonner";

type ToastFn = (msg: string, opts?: ExternalToast) => void;

const DEFAULT_PASSWORD = "Passw0rd#123";

function UserRow({
  user,
  groupName,
  toast,
  onRefresh,
  ensureFreshAuth,
}: {
  user: ADUser;
  groupName?: string;
  toast: { success: ToastFn; error: ToastFn };
  onRefresh: () => void;
  // Kiosk gate: privileged actions call this before running. It resolves true
  // once the operator's session is fresh (re-authenticating via a modal if the
  // last auth was over the kiosk window ago), false if they cancel. Absent
  // outside kiosk mode, in which case actions run unguarded as before.
  ensureFreshAuth?: () => Promise<boolean>;
}) {
  const [menu, setMenu]   = useState(false);
  const [modal, setModal] = useState<"reset" | "unblock" | "details" | "offboard" | null>(null);
  const [busy, setBusy]   = useState(false);
  // Offboard confirmation inputs (re-typed username + re-confirmed admin password).
  const [confirmName, setConfirmName] = useState("");
  const [adminPw, setAdminPw]         = useState("");
  // Close the dropdown menu on an outside click.
  const menuRef = useOutsideClick<HTMLDivElement>(menu, () => setMenu(false));
  // Trap Tab focus inside the open modal and restore it on close. The primary
  // action (Reset / Unlock) takes initial focus so Enter confirms it directly;
  // Escape is still owned by the keyboard effect below.
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const modalRef = useFocusTrap<HTMLDivElement>(!!modal, { initialFocus: primaryActionRef });
  const titleId = useId();

  const canOffboard = confirmName.trim() === user.SamAccountName && adminPw.length > 0 && !busy;

  // Clear the offboard inputs whenever we leave that modal (don't keep a typed
  // password around).
  useEffect(() => {
    if (modal !== "offboard") { setConfirmName(""); setAdminPw(""); }
  }, [modal]);

  // Move focus to the primary action when the overlay switches to a variant that
  // has one (e.g. details → reset/unblock via a footer icon-action). The focus
  // trap's focus-in only fires when it activates, so a variant swap while it's
  // already open wouldn't otherwise land focus on the button — leaving it on the
  // now-unmounted trigger (i.e. on <body>).
  useEffect(() => {
    if (modal === "reset" || modal === "unblock") primaryActionRef.current?.focus();
  }, [modal]);

  // Keyboard binds while dropdown menu is open
  useEffect(() => {
    if (!menu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setMenu(false); return; }
      const k = e.key.toLowerCase();
      if (k === "o") { e.preventDefault(); setMenu(false); setModal("details"); }
      if (k === "r") { e.preventDefault(); setMenu(false); setModal("reset"); }
      if (k === "u" && user.LockedOut) { e.preventDefault(); setMenu(false); setModal("unblock"); }
      if (k === "f") { e.preventDefault(); setMenu(false); setModal("offboard"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [menu, user.LockedOut]);

  // Keyboard binds while a modal is open
  useEffect(() => {
    if (!modal) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (!busy) setModal(null); return; }
      // When focus is on a button (the trap parks it on the primary action), let
      // that button's own Enter→click fire instead of also submitting here — else
      // Enter double-runs the action.
      if (e.key === "Enter" && !busy && !(e.target as HTMLElement).closest("button")) {
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
  // Shared helper (strips DOMAIN\ prefixes + accents); keep the "?" fallback for
  // records whose name has no letters at all.
  const initials = computeInitials(displayName) || "?";

  const doReset = async () => {
    if (ensureFreshAuth && !(await ensureFreshAuth())) return;
    setBusy(true);
    const r = await adAPI.resetPassword({ username: user.SamAccountName, newPassword: DEFAULT_PASSWORD });
    setBusy(false);
    if (r.ok) {
      // The reset can succeed while a secondary step (force change at next logon)
      // is skipped — e.g. on a PasswordNeverExpires account. The script reports
      // that via `warning`; surface it so the operator isn't told it fully worked.
      const warning = (r.data as { warning?: string } | undefined)?.warning;
      if (warning) toast.success(`Palavra-passe reposta para ${user.SamAccountName} — ${warning}`);
      else toast.success(`Palavra-passe reposta para ${user.SamAccountName}`);
      setModal(null);
    } else toast.error(r.error ?? "Não foi possível repor a palavra-passe");
  };

  const doUnlock = async () => {
    if (ensureFreshAuth && !(await ensureFreshAuth())) return;
    setBusy(true);
    const r = await adAPI.unlockUser(user.SamAccountName);
    setBusy(false);
    if (r.ok) { toast.success(`${user.SamAccountName} desbloqueado`); setModal(null); onRefresh(); }
    else toast.error(r.error ?? "Não foi possível desbloquear a conta");
  };

  const doOffboard = async () => {
    // No ensureFreshAuth gate here: offboard already re-verifies the operator's
    // password inline (the modal's own field, checked against the live session
    // in main), so the kiosk re-auth is already satisfied — gating it too would
    // double-prompt for the password.
    if (!canOffboard) return;
    setBusy(true);
    const r = await adAPI.offboardUser({
      username: user.SamAccountName,
      confirmUsername: confirmName.trim(),
      adminPassword: adminPw,
    });
    setBusy(false);
    if (r.ok) {
      toast.success(`${user.SamAccountName} offboarded — conta desativada e movida para a morgue`);
      setModal(null);
      onRefresh();
    } else toast.error(r.error ?? "Não foi possível dar offboard.");
  };

  // One dominant badge per row, matching the default-sort buckets (see
  // lib/userStatus): disabled dominates (parked), then locked, then password
  // expired, then active. Keeping the precedence in the shared helper means the
  // badge and the row's sort bucket can never disagree.
  const statusBadge = () => {
    switch (userStatusKind(user)) {
      case "disabled":
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-600 border border-amber-200">Desativado</span>;
      case "locked":
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-600 border border-red-200"><Lock size={10} />Bloqueado</span>;
      case "expired":
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-50 text-orange-600 border border-orange-200"><Clock size={10} />Palavra-passe expirada</span>;
      default:
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-600 border border-emerald-200"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Ativo</span>;
    }
  };

  return (
    <>
      <tr
        className="group hover:bg-zinc-50/80 transition-colors select-none"
        // Double-click anywhere on the row opens details; right-click opens the
        // same actions menu the kebab does (parity with DeviceRow).
        onDoubleClick={() => setModal("details")}
        onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}
      >
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
              aria-label="Ações do utilizador"
              aria-haspopup="menu"
              aria-expanded={menu}
              className={cn(
                "p-1.5 rounded-md transition-colors",
                focusRing,
                menu
                  ? "bg-zinc-200 text-zinc-700"
                  // Hidden until row hover, but revealed on keyboard focus so it's
                  // reachable without a mouse.
                  : "text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
              )}
            >
              <MoreHorizontal size={15} />
            </button>

            {menu && (
              <div role="menu" className="anim-popover absolute right-0 mt-1 w-52 bg-white border border-zinc-200 rounded-xl shadow-lg overflow-hidden z-20">
                <MenuItem
                  icon={<User size={13} />}
                  label="Abrir"
                  bind="O"
                  onClick={() => { setMenu(false); setModal("details"); }}
                />
                <div className="border-t border-zinc-100" />
                <MenuItem
                  icon={<KeyRound size={13} />}
                  label="Repor palavra-passe"
                  bind="R"
                  onClick={() => { setMenu(false); setModal("reset"); }}
                />
                <MenuItem
                  icon={<Unlock size={13} />}
                  label="Desbloquear"
                  bind="U"
                  disabled={!user.LockedOut}
                  onClick={() => { setMenu(false); setModal("unblock"); }}
                />
                <div className="border-t border-zinc-100" />
                <MenuItem
                  icon={<UserMinus size={13} />}
                  label="Offboard"
                  bind="F"
                  danger
                  onClick={() => { setMenu(false); setModal("offboard"); }}
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
              aria-labelledby={titleId}
              className="anim-overlay fixed inset-0 z-30 bg-black/30 backdrop-blur-sm flex items-center justify-center"
              // Don't dismiss on a backdrop click while an action is in flight.
              onClick={() => { if (!busy) setModal(null); }}
            >
              <div
                ref={modalRef}
                tabIndex={-1}
                className="anim-modal bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden focus:outline-none"
                onClick={(e) => e.stopPropagation()}
              >

                {/* Reset password */}
                {modal === "reset" && (
                  <>
                    <ModalHeader icon={<KeyRound size={15} />} title="Repor palavra-passe" titleId={titleId} subtitle={user.DisplayName || user.SamAccountName} onClose={() => setModal(null)} />
                    <div className="px-6 py-5">
                      <p className="text-sm text-zinc-600">
                        A palavra-passe de <span className="font-medium text-zinc-900">{user.SamAccountName}</span> será reposta para a palavra-passe temporária predefinida.
                      </p>
                      <p className="mt-2 font-mono text-sm text-zinc-500 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 select-all">{DEFAULT_PASSWORD}</p>
                    </div>
                    <ModalFooter>
                      <Bind label="Esc" />
                      <Button variant="ghost" onClick={() => setModal(null)} disabled={busy}>Cancelar</Button>
                      <Bind label="↵" />
                      <Button ref={primaryActionRef} onClick={doReset} disabled={busy}>
                        {busy ? "A repor…" : "Repor"}
                      </Button>
                    </ModalFooter>
                  </>
                )}

                {/* Unblock */}
                {modal === "unblock" && (
                  <>
                    <ModalHeader icon={<Unlock size={15} />} title="Desbloquear conta" titleId={titleId} subtitle={user.DisplayName || user.SamAccountName} onClose={() => setModal(null)} />
                    <div className="px-6 py-5">
                      <p className="text-sm text-zinc-600">
                        A conta <span className="font-medium text-zinc-900">{user.SamAccountName}</span> está bloqueada. Desbloquear?
                      </p>
                    </div>
                    <ModalFooter>
                      <Bind label="Esc" />
                      <Button variant="ghost" onClick={() => setModal(null)} disabled={busy}>Cancelar</Button>
                      <Bind label="↵" />
                      <Button ref={primaryActionRef} onClick={doUnlock} disabled={busy}>
                        {busy ? "A desbloquear…" : "Desbloquear"}
                      </Button>
                    </ModalFooter>
                  </>
                )}

                {/* Offboard */}
                {modal === "offboard" && (
                  <>
                    <ModalHeader icon={<UserMinus size={15} />} title="Offboard do utilizador" titleId={titleId} subtitle={user.DisplayName || user.SamAccountName} onClose={() => setModal(null)} />
                    <div className="px-6 py-5 space-y-4">
                      <div className="flex items-start gap-2.5 rounded-lg bg-red-50 border border-red-200 px-3 py-2.5 text-sm text-red-700">
                        <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />
                        <span>
                          Vai <strong>desativar</strong> a conta <span className="font-medium">{user.SamAccountName}</span> e <strong>movê-la para a OU morgue</strong>. Confirma os dois campos para continuar.
                        </span>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-zinc-500 mb-1">
                          Escreve o username para confirmar
                        </label>
                        <input
                          value={confirmName}
                          onChange={(e) => setConfirmName(e.target.value)}
                          autoFocus
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={user.SamAccountName}
                          className={inputCls}
                        />
                        {confirmName.length > 0 && confirmName.trim() !== user.SamAccountName && (
                          <p className="mt-1 text-xs text-red-500">Não corresponde a <span className="font-medium">{user.SamAccountName}</span>.</p>
                        )}
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-zinc-500 mb-1">
                          Re-confirma a tua palavra-passe de administrador
                        </label>
                        <input
                          type="password"
                          value={adminPw}
                          onChange={(e) => setAdminPw(e.target.value)}
                          autoComplete="off"
                          placeholder="Palavra-passe"
                          className={inputCls}
                        />
                      </div>
                    </div>
                    <ModalFooter>
                      <Bind label="Esc" />
                      <Button variant="ghost" onClick={() => setModal(null)} disabled={busy}>Cancelar</Button>
                      <Button variant="danger" onClick={doOffboard} disabled={!canOffboard}>
                        {busy ? "A dar offboard…" : "Offboard"}
                      </Button>
                    </ModalFooter>
                  </>
                )}

                {/* Details */}
                {modal === "details" && (
                  <>
                    <ModalHeader icon={<User size={15} />} title="Detalhes do utilizador" titleId={titleId} subtitle={user.DisplayName || user.SamAccountName} onClose={() => setModal(null)} />
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

                      <DetailSection title="Conta">
                        <DetailRow label="Nome de utilizador" value={user.SamAccountName} />
                        {user.UserPrincipalName && <DetailRow label="UPN" value={user.UserPrincipalName} />}
                        {user.EmailAddress      && <DetailRow label="Email" value={user.EmailAddress} />}
                      </DetailSection>

                      {(user.Department || user.Company || user.Description) && (
                        <DetailSection title="Organização">
                          {user.Department  && <DetailRow label="Departamento" value={user.Department} />}
                          {user.Company     && <DetailRow label="Empresa"      value={user.Company} />}
                          {user.Description && <DetailRow label="Descrição"    value={user.Description} />}
                        </DetailSection>
                      )}

                      {(user.StreetAddress || user.City || user.PostalCode || user.Office) && (
                        <DetailSection title="Morada">
                          {user.Office        && <DetailRow label="Escritório"    value={user.Office} />}
                          {user.StreetAddress && <DetailRow label="Rua"           value={user.StreetAddress} />}
                          {user.City          && <DetailRow label="Cidade"        value={user.City} />}
                          {user.PostalCode    && <DetailRow label="Código postal" value={user.PostalCode} />}
                        </DetailSection>
                      )}

                      {user.DistinguishedName && (
                        <DetailSection title="Diretório">
                          <DetailRow label="DN" value={user.DistinguishedName} mono />
                        </DetailSection>
                      )}
                    </div>
                    <ModalFooter>
                      {/* Icon-only quick actions (hover = native tooltip). These
                          switch the shared overlay to the matching confirm flow,
                          so every action keeps its own confirmation step. */}
                      <div className="mr-auto flex items-center gap-0.5">
                        <IconAction
                          icon={<KeyRound size={15} />}
                          label="Repor palavra-passe"
                          onClick={() => setModal("reset")}
                        />
                        <IconAction
                          icon={<Unlock size={15} />}
                          label={user.LockedOut ? "Desbloquear conta" : "Conta não bloqueada"}
                          disabled={!user.LockedOut}
                          onClick={() => setModal("unblock")}
                        />
                        <IconAction
                          icon={<UserMinus size={15} />}
                          label="Offboard"
                          danger
                          onClick={() => setModal("offboard")}
                        />
                      </div>
                      <Bind label="Esc / ↵" />
                      <Button variant="ghost" onClick={() => setModal(null)}>Fechar</Button>
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

// Memoised: UsersPage re-renders on every search keystroke and scroll-driven
// window growth, but each row's props (user object, group name, the stable
// `toast` + `onRefresh` callbacks) are unchanged — so a shallow compare skips
// re-rendering the whole visible list (and its menu/modal machinery) on input.
export default memo(UserRow);

function MenuItem({ icon, label, bind, disabled, danger, onClick }: { icon: React.ReactNode; label: string; bind: string; disabled?: boolean; danger?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      role="menuitem"
      className={cn(
        "w-full flex items-center justify-between px-3.5 py-2.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/30",
        danger ? "text-red-600 hover:bg-red-50" : "text-zinc-700 hover:bg-zinc-50",
      )}
    >
      <span className="flex items-center gap-2.5">
        <span className={danger ? "text-red-400" : "text-zinc-400"}>{icon}</span>
        {label}
      </span>
      <Kbd>{bind}</Kbd>
    </button>
  );
}

function Bind({ label }: { label: string }) {
  return <Kbd>{label}</Kbd>;
}

// Icon-only action button with a native hover tooltip (title/aria-label). Used
// in the details modal footer so the common actions are one click away without
// re-opening the row dropdown.
function IconAction({ icon, label, onClick, disabled, danger }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "p-2 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
        focusRing,
        danger ? "text-red-500 hover:bg-red-50 hover:text-red-600" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800",
      )}
    >
      {icon}
    </button>
  );
}

function ModalHeader({ icon, title, titleId, subtitle, onClose }: { icon: React.ReactNode; title: string; titleId?: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="px-6 py-4 border-b border-zinc-100 flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <span className="text-zinc-400">{icon}</span>
        <div>
          <p id={titleId} className="text-sm font-semibold text-zinc-900">{title}</p>
          <p className="text-xs text-zinc-500">{subtitle}</p>
        </div>
      </div>
      <button onClick={onClose} aria-label="Fechar" className={cn("p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition-colors", focusRing)}>
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
