import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Check, ChevronRight } from "lucide-react";
import { adAPI, type ADGroup } from "../../adAPI";
import { getGroupConfig, type GroupConfig } from "../../lib/groupsConfig";
import { cn } from "../../lib/cn";
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
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  jobTitle: string;
  department: string;
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
  firstName: "",
  lastName: "",
  username: "",
  email: "",
  jobTitle: "",
  department: "",
  street: "Rua Sampaio e Pina nº24",
  city: "Lisboa",
  postalCode: "1099-044",
  password: "Passw0rd#123",
  confirmPassword: "Passw0rd#123",
  changePasswordAtLogon: true,
  passwordNeverExpires: true,
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
  const [loginInfoOpen, setLoginInfoOpen]       = useState(false);
  const [groupConfig, setGroupConfig_]        = useState<GroupConfig>({});

  useEffect(() => { getGroupConfig().then(setGroupConfig_); }, []);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const stepIdx = STEPS.findIndex((s) => s.id === step);

  const groupEntry = groupConfig[form.groupName];

  const suggestDefaults = () => {
    setForm((f) => ({
      ...f,
      username:   f.username   || (slug(f.firstName) && slug(f.lastName) ? `${slug(f.firstName)}.${slug(f.lastName)}` : f.username),
      email:      buildEmail(f.firstName, f.lastName),
      department: f.department || groupConfig[f.groupName]?.department || "",
    }));
  };

  const canProceed = () => {
    if (step === "group")    return !!form.groupName;
    if (step === "info")     return !!form.firstName && !!form.lastName && !!form.username;
    if (step === "address")  return !!form.street && !!form.city && !!form.postalCode;
    if (step === "password") return form.password.length >= 8 && form.password === form.confirmPassword;
    return true;
  };

  const next = () => { if (stepIdx < STEPS.length - 1) setStep(STEPS[stepIdx + 1].id); };
  const prev = () => { if (stepIdx > 0) setStep(STEPS[stepIdx - 1].id); };

  const typeaheadRef = useState({ buffer: "", timer: 0 })[0];

  const firstNameRef   = useRef<HTMLInputElement>(null);
  const lastNameRef    = useRef<HTMLInputElement>(null);
  const usernameRef    = useRef<HTMLInputElement>(null);
  const emailRef       = useRef<HTMLInputElement>(null);
  const jobTitleRef    = useRef<HTMLInputElement>(null);
  const departmentRef  = useRef<HTMLInputElement>(null);
  const streetRef      = useRef<HTMLInputElement>(null);
  const cityRef        = useRef<HTMLInputElement>(null);
  const postalCodeRef  = useRef<HTMLInputElement>(null);
  const activeGroupRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (step === "info")    firstNameRef.current?.focus();
    if (step === "address") streetRef.current?.focus();
  }, [step]);

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
      else prev();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [stepIdx]);

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
            const matches = groups.filter((g) => g.Name.startsWith(letter));
            if (matches.length > 0) {
              const currentMatchIdx = matches.findIndex((g) => g.Name === form.groupName);
              set("groupName", matches[(currentMatchIdx + 1) % matches.length].Name);
            }
          } else {
            typeaheadRef.buffer += letter;
            const buf = typeaheadRef.buffer;
            const matches = groups.filter((g) => g.Name.startsWith(buf));
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
          else if (t === lastNameRef.current)   { suggestDefaults(); usernameRef.current?.focus(); }
          else if (t === usernameRef.current)   { emailRef.current?.focus(); }
          else if (t === emailRef.current)      { jobTitleRef.current?.focus(); }
          else if (t === jobTitleRef.current)   { departmentRef.current?.focus(); }
          else if (t === departmentRef.current) { if (canProceed()) next(); }
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
  }, [step, groups, form, saving]);

  const submit = async () => {
    setSaving(true);
    const r = await adAPI.createUser({
      firstName:             form.firstName,
      lastName:              form.lastName,
      username:              form.username,
      password:              form.password,
      groupName:             form.groupName,
      description:           form.jobTitle,
      street:                form.street,
      city:                  form.city,
      postalCode:            form.postalCode,
      changePasswordAtLogon: String(form.changePasswordAtLogon),
      passwordNeverExpires:  String(form.passwordNeverExpires),
      jobTitle:              form.jobTitle,
      department:            form.department,
      company:               COMPANY,
      email:                 form.email,
    });
    setSaving(false);
    if (r.ok) { toast.success(`User ${form.username} created successfully`); onClose(); }
    else toast.error(r.error ?? "Failed to create user");
  };

  const jobTitleSuggestions = groupEntry?.jobTitles ?? [];
  const filteredJobTitles   = jobTitleSuggestions.filter((s) => s.toLowerCase().includes(form.jobTitle.toLowerCase()));
  const allDepartments      = [...new Set(Object.values(groupConfig).map((e) => e.department).filter(Boolean))];
  const filteredDepts       = allDepartments.filter((d) => d.toLowerCase().includes(form.department.toLowerCase()));

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
                          {g.Name[0]}
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
                    placeholder={groupEntry?.jobTitles[0] ?? "Ex: Jornalista"}
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
                    placeholder={groupEntry?.department ?? "Ex: Redação"}
                    className={inputCls} />
                  {deptFocused && filteredDepts.length > 0 && (
                    <Dropdown items={filteredDepts} selected={form.department}
                      onSelect={(s) => { set("department", s); setDeptFocused(false); }} />
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
                    ["Full name",  `${form.firstName} ${form.lastName}`],
                    ["Username",   `BMAP\\${form.username}`],
                    ["Email",      form.email],
                    ...(form.jobTitle  ? [["Job title",  form.jobTitle]]   : []),
                    ...(form.department? [["Department", form.department]] : []),
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
          <kbd className="text-xs font-mono bg-zinc-100 text-zinc-400 px-1.5 py-0.5 rounded border border-zinc-200">Esc</kbd>
          {step === "group" ? "Cancel" : "Back"}
        </button>
        {step !== "confirm" ? (
          <button
            onClick={next}
            disabled={!canProceed()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Continue
            <kbd className="text-xs font-mono bg-violet-500/60 text-violet-100 px-1.5 py-0.5 rounded border border-violet-400/40">↵</kbd>
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? "Creating…" : "Create user"}
            {!saving && <kbd className="text-xs font-mono bg-violet-500/60 text-violet-100 px-1.5 py-0.5 rounded border border-violet-400/40">↵</kbd>}
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

const inputCls = "w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all placeholder:text-zinc-300";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-zinc-600">{label}</label>
      {children}
    </div>
  );
}
