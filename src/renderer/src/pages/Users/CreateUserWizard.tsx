import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Check, ChevronRight, Users } from "lucide-react";
import { adAPI, type ADGroup, type ADUser } from "../../adAPI";
import { getGroupConfig, type GroupConfig } from "../../lib/groupsConfig";
import { usersCache, usersInGroup } from "../../lib/usersCache";
import SearchableSelect from "../../components/SearchableSelect";
import { cn } from "../../lib/cn";
import { setNavGuard } from "../../lib/navGuard";
import { Kbd } from "../../components/ui/Kbd";
import { inputCls } from "../../components/ui/controls";
import type { ExternalToast } from "sonner";

type ToastFn = (msg: string, opts?: ExternalToast) => void;
type Step = "group" | "info" | "address" | "password" | "confirm";

const STEPS: { id: Step; label: string }[] = [
  { id: "group",    label: "Group"    },
  { id: "info",     label: "Details"  },
  { id: "address",  label: "Address"  },
  { id: "password", label: "Password" },
  { id: "confirm",  label: "Confirm"  },
];

interface Form {
  groupName: string;
  copyFromUser: string;
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  jobTitle: string;
  department: string;
  employeeType: string;
  street: string;
  city: string;
  postalCode: string;
  password: string;
  confirmPassword: string;
  changePasswordAtLogon: boolean;
  passwordNeverExpires: boolean;
}

const EMPTY: Form = {
  groupName: "",
  copyFromUser: "",
  firstName: "",
  lastName: "",
  username: "",
  email: "",
  jobTitle: "",
  department: "",
  employeeType: "",
  street: "Rua Sampaio e Pina nº24",
  city: "Lisboa",
  postalCode: "1099-044",
  password: "Passw0rd#123",
  confirmPassword: "Passw0rd#123",
  // These two are mutually exclusive (New-ADUser rejects both-true) and each
  // CheckOption disables the other, so they must NOT both default to true —
  // that left a fresh wizard with both locked and every submit failing with
  // "ChangePasswordAtLogon and PasswordNeverExpires cannot both be true".
  changePasswordAtLogon: true,
  passwordNeverExpires: false,
};

const COMPANY = "Bauer Media Audio Portugal";

// Names in this org routinely carry Portuguese diacritics (João, Conceição) and
// sometimes hyphens/apostrophes (Sá-Carneiro, D'Almeida). AD logon names and
// email addresses must be plain ASCII, so strip accents and drop any character
// that isn't a letter or digit when deriving a login token from a name.
const deaccent = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const slug = (s: string) => deaccent(s).replace(/[^a-z0-9]/g, "");

const buildEmail = (first: string, last: string) => {
  const f = slug(first);
  const l = slug(last);
  return f && l ? `${f}.${l}@bauermedia.pt` : "";
};

// Distinct non-empty values of a field across the OU's current members, ordered
// most-common first. Drives job-title / department / employee-type suggestions
// from real neighbours in the same OU rather than only the static group config.
const freqValues = (users: ADUser[], pick: (u: ADUser) => string | undefined): string[] => {
  const counts = new Map<string, number>();
  for (const u of users) {
    const v = (pick(u) ?? "").trim();
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
};

// De-duplicate while preserving first-seen order (OU-derived values come first).
const dedupeStrings = (arr: string[]): string[] => [...new Set(arr.filter(Boolean))];

export default function CreateUserWizard({
  groups,
  toast,
  onClose,
}: {
  groups: ADGroup[];
  toast: { success: ToastFn; error: ToastFn };
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>("group");
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [jobTitleFocused, setJobTitleFocused]   = useState(false);
  const [deptFocused, setDeptFocused]           = useState(false);
  const [empTypeFocused, setEmpTypeFocused]     = useState(false);
  const [loginInfoOpen, setLoginInfoOpen]       = useState(false);
  const [groupConfig, setGroupConfig_]        = useState<GroupConfig>({});
  // Users already living in the selected OU — offered as "copy groups from" templates.
  const [templateUsers, setTemplateUsers]     = useState<ADUser[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  // The Department / Employee type we last auto-filled from an OU. Lets an OU
  // switch REFRESH those fields (they'd otherwise keep the first OU's values,
  // since the prefill only fills blanks) — but never clobber a value the
  // operator typed, which won't match what we recorded here.
  const autoFilledRef = useRef<{ department: string; employeeType: string }>({ department: "", employeeType: "" });
  // Latest committed form, readable inside effects that must decide from current
  // field values without re-running on every keystroke (the OU prefill below).
  const formRef = useRef(form);
  formRef.current = form;

  useEffect(() => { getGroupConfig().then(setGroupConfig_); }, []);

  // Warn before a page switch / logout that would discard a half-filled wizard.
  // "Dirty" = the user has picked a group or entered any identity field (the
  // prefilled address/password defaults don't count). Cleared on unmount.
  const dirty = !!(
    form.groupName || form.firstName || form.lastName ||
    form.username || form.email || form.jobTitle ||
    form.department || form.copyFromUser
  );
  useEffect(() => {
    if (!dirty) { setNavGuard(null); return; }
    setNavGuard(() =>
      window.confirm("Tens um utilizador por criar que ainda não foi guardado. Sair e perder os dados?")
    );
    return () => setNavGuard(null);
  }, [dirty]);

  // When the category (OU) changes, offer its current users as "copy groups
  // from" templates. Served straight from the shared users cache — no refetch —
  // and only falls back to AD when the cache was never warmed. The group's
  // configured default template user is pre-selected when present.
  useEffect(() => {
    if (!form.groupName) { setTemplateUsers([]); setForm((f) => ({ ...f, copyFromUser: "" })); return; }

    const applyDefault = (list: ADUser[]) => {
      const def = groupConfig[form.groupName]?.defaultTemplateUser ?? "";
      const preselect = def && list.some((u) => u.SamAccountName === def) ? def : "";
      setForm((f) => ({ ...f, copyFromUser: preselect }));
    };

    const cached = usersInGroup(form.groupName);
    if (usersCache.loaded || cached.length > 0) {
      setTemplateUsers(cached);
      setLoadingTemplates(false);
      applyDefault(cached);
      return;
    }

    // Cache never loaded (wizard opened cold) — fetch this OU's members once.
    let cancelled = false;
    setLoadingTemplates(true);
    setForm((f) => ({ ...f, copyFromUser: "" }));
    adAPI.getGroupMembers(form.groupName).then((r) => {
      if (cancelled) return;
      const list = (r.ok && Array.isArray(r.data) ? (r.data as ADUser[]) : []).filter((u) => u.SamAccountName);
      setTemplateUsers(list);
      setLoadingTemplates(false);
      applyDefault(list);
    });
    return () => { cancelled = true; };
  }, [form.groupName, groupConfig]);

  // Whenever the OU's members change (including an OU *switch*), seed Department
  // / Employee type from what they actually use. Kept separate from the name-blur
  // suggestDefaults() so it fires even if the operator never touches the name
  // fields (e.g. jumps straight to Job title). A field is ours to (re)fill when
  // it's blank or still holds the value we auto-filled from the previous OU;
  // once the operator types something else it's left untouched.
  useEffect(() => {
    const dept = freqValues(templateUsers, (u) => u.Department)[0] ?? "";
    const emp  = freqValues(templateUsers, (u) => u.employeeType)[0] ?? "";
    const f = formRef.current;
    const ownsDept = !f.department   || f.department   === autoFilledRef.current.department;
    const ownsEmp  = !f.employeeType || f.employeeType === autoFilledRef.current.employeeType;
    const nextDept = ownsDept ? dept : f.department;
    const nextEmp  = ownsEmp  ? emp  : f.employeeType;
    // Record what we own now so the next OU switch can replace it. Done in the
    // effect body, NOT inside the setForm updater: an updater must be pure, and
    // StrictMode double-invokes it — a ref mutated on the first (discarded) pass
    // would flip the ownership check on the second pass and silently drop the
    // refresh (and corrupt the ref for good).
    autoFilledRef.current = {
      department:   ownsDept ? nextDept : autoFilledRef.current.department,
      employeeType: ownsEmp  ? nextEmp  : autoFilledRef.current.employeeType,
    };
    if (nextDept === f.department && nextEmp === f.employeeType) return;
    setForm((prev) => ({ ...prev, department: nextDept, employeeType: nextEmp }));
  }, [templateUsers]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const stepIdx = STEPS.findIndex((s) => s.id === step);

  const groupEntry = groupConfig[form.groupName];

  // Titles / departments / employee types actually in use by the OU's current
  // members, most-common first. These drive the suggestions (and the prefill)
  // so a new hire inherits what their real colleagues have, per the request:
  // "Jobtitle suggestions deve ser com base nos outros users desse OU. Same for
  // Department." — employeeType likewise (it was never being filled at all).
  const ouTitles   = freqValues(templateUsers, (u) => u.Title);
  const ouDepts    = freqValues(templateUsers, (u) => u.Department);
  const ouEmpTypes = freqValues(templateUsers, (u) => u.employeeType);

  const suggestDefaults = () => {
    setForm((f) => {
      // Prefer what the OU's members actually have; fall back to the static
      // group config, then leave blank.
      const department   = f.department   || ouDepts[0]    || groupConfig[f.groupName]?.department || "";
      const employeeType = f.employeeType || ouEmpTypes[0] || "";
      // Record anything we auto-filled so a later OU switch can refresh it (the
      // prefill effect keys off this ref to tell auto-filled from operator-typed).
      if (!f.department   && department)   autoFilledRef.current.department   = department;
      if (!f.employeeType && employeeType) autoFilledRef.current.employeeType = employeeType;
      return {
        ...f,
        username:   f.username   || (slug(f.firstName) && slug(f.lastName) ? `${slug(f.firstName)}.${slug(f.lastName)}` : f.username),
        // Don't clobber an email the user typed (or one already derived) — only
        // fill it when still empty, mirroring the username rule above.
        email:      f.email      || buildEmail(f.firstName, f.lastName),
        department,
        employeeType,
      };
    });
  };

  const canProceed = () => {
    if (step === "group")    return !!form.groupName;
    // AD caps SamAccountName at 20 chars; block Continue rather than let the
    // create fail at the very end with a cryptic AD error.
    if (step === "info")     return !!form.firstName && !!form.lastName && !!form.username && form.username.length <= 20;
    if (step === "address")  return !!form.street && !!form.city && !!form.postalCode;
    if (step === "password") return form.password.length >= 8 && form.password === form.confirmPassword;
    return true;
  };

  const next = () => { if (stepIdx < STEPS.length - 1) setStep(STEPS[stepIdx + 1].id); };
  const prev = () => { if (stepIdx > 0) setStep(STEPS[stepIdx - 1].id); };

  const typeaheadRef = useRef({ buffer: "", timer: 0 }).current;

  const firstNameRef   = useRef<HTMLInputElement>(null);
  const lastNameRef    = useRef<HTMLInputElement>(null);
  const usernameRef    = useRef<HTMLInputElement>(null);
  const emailRef       = useRef<HTMLInputElement>(null);
  const jobTitleRef    = useRef<HTMLInputElement>(null);
  const departmentRef  = useRef<HTMLInputElement>(null);
  const empTypeRef     = useRef<HTMLInputElement>(null);
  const streetRef      = useRef<HTMLInputElement>(null);
  const cityRef        = useRef<HTMLInputElement>(null);
  const postalCodeRef  = useRef<HTMLInputElement>(null);
  const activeGroupRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (step === "info")    firstNameRef.current?.focus();
    if (step === "address") streetRef.current?.focus();
  }, [step]);

  // If the derived (or typed) logon name exceeds AD's 20-char limit, reveal the
  // collapsed Login Info panel so the user can see and shorten it — otherwise
  // Continue is disabled with no visible reason.
  useEffect(() => {
    if (form.username.length > 20) setLoginInfoOpen(true);
  }, [form.username.length]);

  useEffect(() => {
    activeGroupRef.current?.scrollIntoView({ block: "nearest" });
  }, [form.groupName]);

  // Esc goes back / closes wizard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      if (stepIdx === 0) onClose();
      else setStep(STEPS[stepIdx - 1].id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [stepIdx, onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA";

      if (!inInput) {
        if (e.key === "ArrowRight" && canProceed()) { e.preventDefault(); next(); return; }
        if (e.key === "ArrowLeft")                  { e.preventDefault(); prev(); return; }
      }

      if (step === "group" && groups.length > 0) {
        const idx = groups.findIndex((g) => g.Name === form.groupName);

        if (e.key === "ArrowDown") {
          e.preventDefault();
          set("groupName", (groups[idx + 1] ?? groups[0]).Name);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          set("groupName", (groups[idx - 1] ?? groups[groups.length - 1]).Name);
          return;
        }

        if (!inInput && e.key.length === 1 && /[A-Za-z]/.test(e.key)) {
          e.preventDefault();
          clearTimeout(typeaheadRef.timer);
          const letter = e.key.toUpperCase();
          // If repeating the same letter, cycle instead of extending buffer
          const isRepeat = typeaheadRef.buffer.length > 0 && typeaheadRef.buffer.split("").every((c) => c === letter);
          if (isRepeat) {
            const matches = groups.filter((g) => g.Name?.startsWith(letter));
            if (matches.length > 0) {
              const currentMatchIdx = matches.findIndex((g) => g.Name === form.groupName);
              set("groupName", matches[(currentMatchIdx + 1) % matches.length].Name);
            }
          } else {
            typeaheadRef.buffer += letter;
            const buf = typeaheadRef.buffer;
            const matches = groups.filter((g) => g.Name?.startsWith(buf));
            if (matches.length > 0) set("groupName", matches[0].Name);
          }
          typeaheadRef.timer = window.setTimeout(() => { typeaheadRef.buffer = ""; }, 600);
          return;
        }
      }

      if (e.key === "Enter" && step === "info" && inInput) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          if (canProceed()) next();
        } else {
          const t = e.target as HTMLInputElement;
          if (t === firstNameRef.current)       { suggestDefaults(); lastNameRef.current?.focus(); }
          // The username/email inputs live inside the collapsed "Login Info"
          // panel, so their refs are null while it's closed (the default). Skip
          // straight to Job title in that case, otherwise Enter dead-ends here.
          else if (t === lastNameRef.current)   { suggestDefaults(); (loginInfoOpen ? usernameRef.current : jobTitleRef.current)?.focus(); }
          else if (t === usernameRef.current)   { emailRef.current?.focus(); }
          else if (t === emailRef.current)      { jobTitleRef.current?.focus(); }
          else if (t === jobTitleRef.current)   { departmentRef.current?.focus(); }
          else if (t === departmentRef.current) { empTypeRef.current?.focus(); }
          else if (t === empTypeRef.current)    { if (canProceed()) next(); }
        }
        return;
      }

      if (e.key === "Enter" && step === "address" && inInput) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          if (canProceed()) next();
        } else {
          const t = e.target as HTMLInputElement;
          if (t === streetRef.current)          { cityRef.current?.focus(); }
          else if (t === cityRef.current)       { postalCodeRef.current?.focus(); }
          else if (t === postalCodeRef.current) { if (canProceed()) next(); }
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && (step === "info" || step === "address")) {
        e.preventDefault();
        if (canProceed()) next();
        return;
      }

      if (e.key === "Enter" && (!inInput || step === "group")) {
        e.preventDefault();
        if (step === "confirm") { if (!saving) submit(); }
        else if (canProceed()) next();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // groupConfig is read via suggestDefaults() inside this handler; without it
    // an Enter pressed before the next form/step change would run against a
    // stale (empty) config and skip the department default. loginInfoOpen gates
    // the Enter focus chain (skips the hidden username/email inputs when closed).
  }, [step, groups, form, saving, groupConfig, loginInfoOpen]);

  const submit = async () => {
    setSaving(true);
    const r = await adAPI.createUser({
      firstName:             form.firstName,
      lastName:              form.lastName,
      username:              form.username,
      password:              form.password,
      groupName:             form.groupName,
      copyFromUser:          form.copyFromUser,
      description:           form.jobTitle,
      street:                form.street,
      city:                  form.city,
      postalCode:            form.postalCode,
      changePasswordAtLogon: String(form.changePasswordAtLogon),
      passwordNeverExpires:  String(form.passwordNeverExpires),
      jobTitle:              form.jobTitle,
      department:            form.department,
      employeeType:          form.employeeType,
      company:               COMPANY,
      email:                 form.email,
    });
    setSaving(false);
    if (r.ok) {
      // The account was created; a warning means a best-effort follow-up (e.g.
      // copying the template user's groups) didn't fully succeed — surface it
      // so it isn't silently lost behind the success toast.
      const warning = (r.data as { warning?: string } | undefined)?.warning;
      toast.success(`User ${form.username} created successfully`);
      if (warning) toast.error(warning);
      onClose();
    } else toast.error(r.error ?? "Failed to create user");
  };

  // Suggestions lead with what the OU's members actually have (ouTitles/…),
  // then fall back to the static group config, de-duplicated.
  const jobTitleSuggestions = dedupeStrings([...ouTitles, ...(groupEntry?.jobTitles ?? [])]);
  const filteredJobTitles   = jobTitleSuggestions.filter((s) => s.toLowerCase().includes(form.jobTitle.toLowerCase()));
  const allDepartments      = dedupeStrings([...ouDepts, ...Object.values(groupConfig).map((e) => e.department)]);
  const filteredDepts       = allDepartments.filter((d) => d.toLowerCase().includes(form.department.toLowerCase()));
  // Employee type has no static config source — it's purely OU-derived.
  const filteredEmpTypes    = ouEmpTypes.filter((t) => t.toLowerCase().includes(form.employeeType.toLowerCase()));

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-zinc-200 flex items-center gap-3">
        <button
          onClick={onClose}
          className="p-1.5 rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <div>
          <h2 className="text-base font-semibold text-zinc-900">New User</h2>
          <p className="text-xs text-zinc-400 mt-0.5">Add a new user to Active Directory</p>
        </div>
      </div>

      {/* Step indicator */}
      <div className="px-6 py-3 border-b border-zinc-100 flex items-center gap-1">
        {STEPS.map((s, i) => {
          const done = i < stepIdx;
          const current = i === stepIdx;
          return (
            <div key={s.id} className="flex items-center gap-1">
              <div className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all",
                current ? "bg-violet-600 text-white" :
                done    ? "bg-violet-100 text-violet-700" :
                          "bg-zinc-100 text-zinc-400"
              )}>
                {done ? <Check size={10} strokeWidth={3} /> : <span>{i + 1}</span>}
                {s.label}
              </div>
              {i < STEPS.length - 1 && (
                <ChevronRight size={12} className={cn("text-zinc-300", done && "text-violet-300")} />
              )}
            </div>
          );
        })}
      </div>

      {/* Content */}
      <div className={cn(
        "flex-1 overflow-y-auto flex flex-col items-center px-6 py-8",
        step === "group" ? "justify-start" : "justify-center"
      )}>
        <div className="w-full max-w-md space-y-5">

          {/* ── Step: Group ── */}
          {step === "group" && (
            <>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900">Select a group</h3>
                <p className="text-xs text-zinc-400 mt-0.5">The user will be onboarded into this group.</p>
              </div>
              <div className="rounded-xl border border-zinc-200 overflow-hidden divide-y divide-zinc-100">
                {groups.map((g) => {
                  const active = form.groupName === g.Name;
                  return (
                    <button
                      key={g.Name}
                      ref={active ? activeGroupRef : undefined}
                      onClick={() => set("groupName", g.Name)}
                      className={cn(
                        "w-full flex items-center justify-between px-4 py-3 text-left transition-colors",
                        active ? "bg-violet-50" : "bg-white hover:bg-zinc-50"
                      )}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={cn(
                          "w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold flex-shrink-0",
                          active ? "bg-violet-600 text-white" : "bg-zinc-100 text-zinc-500"
                        )}>
                          {g.Name?.[0] ?? "?"}
                        </div>
                        <span className={cn(
                          "text-sm font-medium truncate",
                          active ? "text-violet-700" : "text-zinc-800"
                        )}>
                          {g.Name}
                        </span>
                      </div>
                      {active && <Check size={14} className="text-violet-500 flex-shrink-0" strokeWidth={2.5} />}
                    </button>
                  );
                })}
              </div>

              {/* Copy group memberships from an existing user in this OU (optional). */}
              {form.groupName && (
                <div className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-600">
                    <Users size={13} className="text-zinc-400" />
                    Copiar grupos de <span className="text-zinc-400">(opcional)</span>
                  </label>
                  <SearchableSelect
                    value={form.copyFromUser}
                    onChange={(v) => set("copyFromUser", v)}
                    options={templateUsers.map((u) => ({
                      value: u.SamAccountName,
                      label: u.DisplayName || u.SamAccountName,
                      sublabel: u.DisplayName ? u.SamAccountName : undefined,
                    }))}
                    disabled={loadingTemplates}
                    clearable
                    clearLabel="Não copiar grupos"
                    placeholder={
                      loadingTemplates
                        ? "A carregar utilizadores…"
                        : templateUsers.length === 0
                          ? "Nenhum utilizador nesta pasta"
                          : "Não copiar grupos"
                    }
                    searchPlaceholder="Procurar utilizador…"
                    emptyText="Nenhum utilizador nesta pasta"
                  />
                  <p className="text-xs text-zinc-400">
                    O novo utilizador fica na pasta <span className="font-medium text-zinc-500">{form.groupName}</span>
                    {form.copyFromUser && " e herda os grupos do utilizador escolhido"}.
                  </p>
                </div>
              )}
            </>
          )}

          {/* ── Step: Info ── */}
          {step === "info" && (
            <>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900">User details</h3>
                <p className="text-xs text-zinc-400 mt-0.5">Fill in the user's personal information.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="First name">
                  <input ref={firstNameRef} value={form.firstName}
                    onChange={(e) => set("firstName", e.target.value)}
                    onBlur={suggestDefaults} placeholder="João" className={inputCls} />
                </Field>
                <Field label="Last name">
                  <input ref={lastNameRef} value={form.lastName}
                    onChange={(e) => set("lastName", e.target.value)}
                    onBlur={suggestDefaults} placeholder="Silva" className={inputCls} />
                </Field>
              </div>
              {/* Login Info — collapsible */}
              <div>
                <button
                  type="button"
                  onClick={() => setLoginInfoOpen((o) => !o)}
                  className="flex items-center gap-2 w-full group"
                >
                  <span className="text-xs font-medium text-zinc-400 group-hover:text-zinc-500 transition-colors whitespace-nowrap">Login Info</span>
                  <hr className="flex-1 border-zinc-200" />
                  <svg
                    className={cn("w-3 h-3 text-zinc-400 group-hover:text-zinc-500 transition-all flex-shrink-0", loginInfoOpen ? "rotate-180" : "")}
                    viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                  >
                    <path d="M2 4l4 4 4-4" />
                  </svg>
                </button>
                {loginInfoOpen && (
                  <div className="mt-4 space-y-4">
                    <Field label="User logon name">
                      <div className="flex gap-2">
                        <span className={cn(inputCls, "w-auto flex-shrink-0 text-zinc-400 bg-zinc-50 cursor-default select-none")}>
                          BMAP\
                        </span>
                        <input ref={usernameRef} value={form.username}
                          onChange={(e) => set("username", deaccent(e.target.value).replace(/[^a-z0-9._-]/g, ""))}
                          placeholder="joao.silva" className={cn(inputCls, "flex-1")} />
                      </div>
                      {form.username.length > 20 && (
                        <p className="text-xs text-red-500">
                          {form.username.length} caracteres — o máximo do Active Directory é 20. Encurta o nome de utilizador.
                        </p>
                      )}
                    </Field>
                    <Field label="Email">
                      <input ref={emailRef} value={form.email}
                        onChange={(e) => set("email", deaccent(e.target.value).replace(/[^a-z0-9._%+@-]/g, ""))}
                        placeholder="joao.silva@bauermedia.pt" className={inputCls} />
                    </Field>
                  </div>
                )}
              </div>

              {/* Job Title */}
              <Field label="Job title">
                <div className="relative">
                  <input ref={jobTitleRef} value={form.jobTitle}
                    onChange={(e) => set("jobTitle", e.target.value)}
                    onFocus={() => setJobTitleFocused(true)}
                    onBlur={() => setTimeout(() => setJobTitleFocused(false), 150)}
                    placeholder={groupEntry?.jobTitles?.[0] ?? "Ex: Jornalista"}
                    className={inputCls} />
                  {jobTitleFocused && filteredJobTitles.length > 0 && (
                    <Dropdown items={filteredJobTitles} selected={form.jobTitle}
                      onSelect={(s) => { set("jobTitle", s); setJobTitleFocused(false); }} />
                  )}
                </div>
              </Field>

              {/* Department */}
              <Field label="Department">
                <div className="relative">
                  <input ref={departmentRef} value={form.department}
                    onChange={(e) => set("department", e.target.value)}
                    onFocus={() => setDeptFocused(true)}
                    onBlur={() => setTimeout(() => setDeptFocused(false), 150)}
                    placeholder={ouDepts[0] ?? groupEntry?.department ?? "Ex: Redação"}
                    className={inputCls} />
                  {deptFocused && filteredDepts.length > 0 && (
                    <Dropdown items={filteredDepts} selected={form.department}
                      onSelect={(s) => { set("department", s); setDeptFocused(false); }} />
                  )}
                </div>
              </Field>

              {/* Employee type — suggestions come from the OU's current members. */}
              <Field label="Employee type">
                <div className="relative">
                  <input ref={empTypeRef} value={form.employeeType}
                    onChange={(e) => set("employeeType", e.target.value)}
                    onFocus={() => setEmpTypeFocused(true)}
                    onBlur={() => setTimeout(() => setEmpTypeFocused(false), 150)}
                    placeholder={ouEmpTypes[0] ?? "Ex: Efetivo"}
                    className={inputCls} />
                  {empTypeFocused && filteredEmpTypes.length > 0 && (
                    <Dropdown items={filteredEmpTypes} selected={form.employeeType}
                      onSelect={(s) => { set("employeeType", s); setEmpTypeFocused(false); }} />
                  )}
                </div>
              </Field>

            </>
          )}

          {/* ── Step: Address ── */}
          {step === "address" && (
            <>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900">Address</h3>
                <p className="text-xs text-zinc-400 mt-0.5">Office address — edit if needed.</p>
              </div>
              <Field label="Street">
                <input ref={streetRef} value={form.street}
                  onChange={(e) => set("street", e.target.value)} className={inputCls} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="City">
                  <input ref={cityRef} value={form.city}
                    onChange={(e) => set("city", e.target.value)} className={inputCls} />
                </Field>
                <Field label="Postal code">
                  <input ref={postalCodeRef} value={form.postalCode}
                    onChange={(e) => set("postalCode", e.target.value)} className={inputCls} />
                </Field>
              </div>
            </>
          )}

          {/* ── Step: Password ── */}
          {step === "password" && (
            <>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900">Temporary password</h3>
                <p className="text-xs text-zinc-400 mt-0.5">Set the account password and options.</p>
              </div>
              <Field label="Password">
                <input type="password" value={form.password}
                  onChange={(e) => set("password", e.target.value)} className={inputCls} />
              </Field>
              <Field label="Confirm password">
                <input type="password" value={form.confirmPassword}
                  onChange={(e) => set("confirmPassword", e.target.value)} className={inputCls} />
              </Field>
              {form.password && form.confirmPassword && form.password !== form.confirmPassword && (
                <p className="text-xs text-red-500">Passwords do not match</p>
              )}
              {form.password && form.password.length < 8 && (
                <p className="text-xs text-amber-500">Minimum 8 characters</p>
              )}
              <div className="space-y-3 pt-1">
                <CheckOption
                  checked={form.changePasswordAtLogon}
                  disabled={form.passwordNeverExpires}
                  onChange={(v) => set("changePasswordAtLogon", v)}
                  label="User must change password at next login"
                  hint={form.passwordNeverExpires ? "Incompatível com password que nunca expira" : undefined}
                />
                <CheckOption
                  checked={form.passwordNeverExpires}
                  disabled={form.changePasswordAtLogon}
                  onChange={(v) => set("passwordNeverExpires", v)}
                  label="Password never expires"
                  hint={form.changePasswordAtLogon ? "Incompatível com alteração obrigatória no próximo login" : undefined}
                />
              </div>
            </>
          )}

          {/* ── Step: Confirm ── */}
          {step === "confirm" && (
            <>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900">Review & confirm</h3>
                <p className="text-xs text-zinc-400 mt-0.5">Please review the details before creating the user.</p>
              </div>
              <div className="rounded-xl border border-zinc-200 divide-y divide-zinc-100 overflow-hidden">
                {(
                  [
                    ["Group",      form.groupName],
                    ...(form.copyFromUser
                      ? [["Grupos de", templateUsers.find((u) => u.SamAccountName === form.copyFromUser)?.DisplayName ?? form.copyFromUser]] as [string, string][]
                      : []),
                    ["Full name",  `${form.firstName} ${form.lastName}`],
                    ["Username",   `BMAP\\${form.username}`],
                    ["Email",      form.email],
                    ...(form.jobTitle    ? [["Job title",     form.jobTitle]]    : []),
                    ...(form.department  ? [["Department",    form.department]]  : []),
                    ...(form.employeeType? [["Employee type", form.employeeType]]: []),
                    ["Address",    `${form.street}, ${form.postalCode} ${form.city}`],
                    ["Password",   "••••••••"],
                  ] as [string, string][]
                ).map(([label, val]) => (
                  <div key={label} className="flex items-center justify-between px-4 py-3">
                    <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">{label}</span>
                    <span className="text-sm font-medium text-zinc-800 text-right max-w-xs">{val}</span>
                  </div>
                ))}
                <div className="px-4 py-3 space-y-1">
                  <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider block">Account options</span>
                  <p className="text-sm text-zinc-700">
                    {form.changePasswordAtLogon ? "✓ Must change password at next login" : "✗ No forced password change"}
                  </p>
                  <p className="text-sm text-zinc-700">
                    {form.passwordNeverExpires ? "✓ Password never expires" : "✗ Password expires normally"}
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-zinc-200 flex items-center justify-between">
        <button
          onClick={step === "group" ? onClose : prev}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg transition-colors"
        >
          <Kbd>Esc</Kbd>
          {step === "group" ? "Cancel" : "Back"}
        </button>
        {step !== "confirm" ? (
          <button
            onClick={next}
            disabled={!canProceed()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Continue
            <Kbd tone="violet">↵</Kbd>
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? "Creating…" : "Create user"}
            {!saving && <Kbd tone="violet">↵</Kbd>}
          </button>
        )}
      </div>
    </div>
  );
}

function Dropdown({ items, selected, onSelect }: { items: string[]; selected: string; onSelect: (s: string) => void }) {
  return (
    <div className="absolute z-10 mt-1 w-full bg-white border border-zinc-200 rounded-lg shadow-lg overflow-hidden">
      {items.map((s) => (
        <button key={s} type="button" onMouseDown={() => onSelect(s)}
          className={cn(
            "w-full text-left px-3 py-2 text-sm transition-colors",
            selected === s ? "bg-violet-50 text-violet-700 font-medium" : "text-zinc-700 hover:bg-zinc-50"
          )}>
          {s}
        </button>
      ))}
    </div>
  );
}

function CheckOption({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; hint?: string }) {
  return (
    <label className={cn("flex items-start gap-3 select-none", disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 rounded border-zinc-300 text-violet-600 focus:ring-violet-500/20 disabled:cursor-not-allowed" />
      <span className="text-sm text-zinc-700">
        {label}
        {hint && <span className="block text-xs text-amber-500 mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-zinc-600">{label}</label>
      {children}
    </div>
  );
}
