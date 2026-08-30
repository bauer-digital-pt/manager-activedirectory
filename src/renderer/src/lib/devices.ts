// Consolidated device model + all the pure logic behind the single, enriched
// device list. One row = the union of what AD knows about a computer object and
// what EZOffice knows about the matching asset (joined by name), PLUS asset-only
// rows for hardware AD never sees (mice, power adapters, monitors, …).
//
// Kept framework-free (no React) so it's trivially testable and shared between
// the list page and the row. The only cross-source key is the device NAME —
// neither the PowerShell nor the inventory-API row exposes a serial to join on.
import {
  Laptop, Monitor, Mouse, Keyboard, Headphones, Smartphone, Tablet, Server,
  Printer, PlugZap, Cable, Usb, Router, Network, Webcam, Camera, Speaker,
  Projector, Watch, HardDrive, MemoryStick, Cpu, Package, type LucideIcon,
} from "lucide-react";
import type { ADComputer, InventoryAsset, InventorySourceDevice } from "../../../shared/types";

// The AD domain. Anything ending in it (a DNS suffix, a UPN/email domain, or a
// NetBIOS `DOMAIN\` prefix) is noise in the UI and stripped for display (req. C).
export const DOMAIN = "bmap.lis";

// A device is "Inativo" once it hasn't been seen / logged on in this many days.
const STALE_DAYS = 90;

/* -------------------------------------------------------------------------- */
/* Consolidated view-model                                                    */
/* -------------------------------------------------------------------------- */

// The ATOMIC origins a consolidated row draws from. A single row can carry more
// than one: sources are MERGED, so a domain-joined laptop that AD knows, EZOffice
// inventories AND ScreenConnect can reach is ONE row tagged with all three. Drives
// the "Fonte" filter (membership, not equality) and the per-source chips.
export type DeviceSource = "ad" | "ezoffice" | "screenconnect";

// Fixed display order + PT labels for the sources — shared by the filter, the
// row chips and the free-text search haystack.
export const SOURCE_ORDER: readonly DeviceSource[] = ["ad", "ezoffice", "screenconnect"];
export const SOURCE_LABEL: Record<DeviceSource, string> = {
  ad: "Active Directory",
  ezoffice: "EZOffice",
  screenconnect: "ScreenConnect",
};

// A stable, human-readable label for a row's combined provenance, sources always
// in SOURCE_ORDER (e.g. "Active Directory + EZOffice"). Empty → "—".
export function sourceLabel(sources: DeviceSource[]): string {
  return SOURCE_ORDER.filter((s) => sources.includes(s)).map((s) => SOURCE_LABEL[s]).join(" + ") || "—";
}

// Append a source to a row's provenance without duplicating it (order preserved).
function withSource(sources: DeviceSource[], add: DeviceSource): DeviceSource[] {
  return sources.includes(add) ? sources : [...sources, add];
}

export interface ConsolidatedDevice {
  // Stable de-dupe / React key (lowercased name, or the asset id when nameless).
  key: string;
  // Raw name as stored (may carry a domain suffix); use `displayName` in the UI.
  name: string;
  displayName: string;
  // Every source that contributed to this row (deduped, no fixed order). Use
  // `sourceLabel(sources)` for display and `sources.includes(...)` for the filter.
  sources: DeviceSource[];

  // AD-side
  dnsHostName?: string;
  enabled?: boolean;
  operatingSystem?: string;
  operatingSystemVersion?: string;
  description?: string;
  distinguishedName?: string;
  managedBy?: string;
  department?: string;
  lastLogonDate?: string | null;
  whenCreated?: string;

  // EZOffice-side
  assetId?: string;
  serialNumber?: string;
  category?: string;
  ezStatus?: string;
  assignedUserEmail?: string;
  // Exact EZOffice public label URL (incl. the ?c= check code) for the printed QR;
  // present only once the inventory API exposes it (see InventoryAsset.qr_url).
  qrUrl?: string;
  // The asset has an open maintenance/service work order. Heuristic (derived from
  // EZOffice state on the bulk read — see InventoryAsset.in_maintenance); drives the
  // "Começar manutenção" vs "Ver manutenção" menu split. Authoritative per-asset
  // detail is fetched on demand (inventoryAPI.getMaintenance).
  ongoingMaintenance?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Domain stripping (req. C)                                                  */
/* -------------------------------------------------------------------------- */

// Strip the AD domain from a value for display: a trailing `.bmap.lis` (DNS) or
// `@bmap.lis` (UPN/email), and a leading `BMAP\` NetBIOS prefix. Case-insensitive;
// leaves anything else untouched. Empty/undefined → "".
export function stripDomain(value?: string | null): string {
  if (!value) return "";
  let v = value.trim();
  const dom = DOMAIN.toLowerCase();
  const netbios = DOMAIN.split(".")[0].toLowerCase(); // "bmap"
  // Leading NetBIOS domain (BMAP\user)
  const slash = v.indexOf("\\");
  if (slash > 0 && v.slice(0, slash).toLowerCase() === netbios) v = v.slice(slash + 1);
  // Trailing .domain or @domain
  const lower = v.toLowerCase();
  if (lower.endsWith("." + dom)) v = v.slice(0, v.length - dom.length - 1);
  else if (lower.endsWith("@" + dom)) v = v.slice(0, v.length - dom.length - 1);
  return v;
}

/* -------------------------------------------------------------------------- */
/* Consolidation (req. A)                                                     */
/* -------------------------------------------------------------------------- */

// The cross-source join key. AD exposes the SHORT host name (`PT-LPT-ADM-08`)
// while EZOffice stores the FQDN (`PT-LPT-ADM-08.bmap.lis`) for every domain-joined
// machine — so a raw lowercase compare never matches and the asset (serial, status,
// assetId → the QR public-link) is silently dropped, printing labels without a QR.
// Strip the AD domain on BOTH sides first so short name and FQDN collapse to the
// same key. `stripDomain` is a no-op on already-short names and on non-domain
// assets (Macs, peripherals), so this only *adds* matches, never false ones.
function keyOf(name?: string | null): string {
  return stripDomain(name).toLowerCase();
}

// Rank an EZOffice asset for "which duplicate is authoritative for a hostname".
// EZOffice sometimes holds two records for one machine (a live one + a retired/
// broken/lost leftover); the join must not let array order decide which serial/
// status/QR the merged row shows. A live record (in use / available) outranks any
// dead one, then the newer (higher) asset_id wins. Purely for ordering same-named
// assets — the winner enriches the AD row, the losers still get their own rows.
function assetAuthority(status?: string | null, assetId?: string | null): number {
  const s = (status || "").toLowerCase();
  const live = s === "in use" || s === "available" ? 1 : 0;
  const id = Number(assetId);
  return live * 1e15 + (Number.isFinite(id) ? id : 0);
}

// An AD computer object → a base consolidated row.
export function fromAD(d: ADComputer): ConsolidatedDevice {
  const name = d.Name || "";
  return {
    key: keyOf(name) || (d.DistinguishedName || "").toLowerCase(),
    name,
    displayName: stripDomain(name) || name,
    sources: ["ad"],
    dnsHostName: d.DNSHostName || undefined,
    enabled: d.Enabled,
    operatingSystem: d.OperatingSystem || undefined,
    operatingSystemVersion: d.OperatingSystemVersion || undefined,
    description: d.Description || undefined,
    distinguishedName: d.DistinguishedName || undefined,
    managedBy: d.ManagedBy || undefined,
    department: d.OU || undefined,
    lastLogonDate: d.LastLogonDate ?? null,
    whenCreated: d.WhenCreated || undefined,
  };
}

// An inventory-API AD device (ldap3, snake_case; no `enabled` flag — state is
// derived from `last_seen` recency instead) → a base consolidated row. Carries
// serial + holder the API already knows, so EZOffice enrichment is additive.
export function fromSource(s: InventorySourceDevice): ConsolidatedDevice {
  const name = s.name || "";
  return {
    key: keyOf(name),
    name,
    displayName: stripDomain(name) || name,
    sources: ["ad"],
    operatingSystem: s.platform || undefined,
    operatingSystemVersion: s.os_version || undefined,
    department: s.department || undefined,
    lastLogonDate: s.last_seen ?? null,
    serialNumber: s.serial_number || undefined,
    assignedUserEmail: s.assigned_user_email || undefined,
  };
}

// A ScreenConnect Access machine → a base row. Same InventorySourceDevice shape as
// the AD feed, but `source: "screenconnect"`. ScreenConnect is the one source that
// reliably carries a hardware serial for a machine AD may never have seen, so a
// ScreenConnect-ONLY device still surfaces in the list (and joins to AD/EZOffice by
// serial or hostname — see mergeDeviceSources / consolidate). `last_seen` is always
// null here (ScreenConnect's session-info ping is not a real logon), so lifecycle
// state falls back to the EZOffice status rather than a bogus recency.
export function fromScreenConnect(s: InventorySourceDevice): ConsolidatedDevice {
  const name = s.name || "";
  const serial = s.serial_number || undefined;
  return {
    // Hostname key when named, else a serial-scoped key so a nameless machine still
    // gets a stable, collision-free row (never an empty key that would be dropped).
    key: keyOf(name) || (serial ? `sc:${serial.toLowerCase()}` : ""),
    name,
    displayName: stripDomain(name) || name,
    sources: ["screenconnect"],
    operatingSystem: s.platform || undefined,
    operatingSystemVersion: s.os_version || undefined,
    department: s.department || undefined,
    lastLogonDate: s.last_seen ?? null,
    serialNumber: serial,
    assignedUserEmail: s.assigned_user_email || undefined,
  };
}

// Merge a secondary device feed (ScreenConnect) into the primary base rows (AD),
// joining on serial when both carry one, else on the hostname key — the
// "hostname + serial" cross-source join. A machine present in BOTH collapses to ONE
// row: the primary keeps its identity, the secondary only fills empty fields (serial,
// OS, holder) and adds its source tag. A machine seen ONLY by the secondary is
// appended as its own row, so a ScreenConnect-only device still appears (req. A).
// Enriches matched primary rows in place — callers pass freshly-mapped rows.
export function mergeDeviceSources(
  primary: ConsolidatedDevice[],
  extra: ConsolidatedDevice[],
): ConsolidatedDevice[] {
  const byHost = new Map<string, ConsolidatedDevice>();
  const bySerial = new Map<string, ConsolidatedDevice>();
  const index = (d: ConsolidatedDevice) => {
    if (d.key) byHost.set(d.key, d);
    const sn = (d.serialNumber || "").toLowerCase();
    if (sn) bySerial.set(sn, d);
  };
  for (const d of primary) index(d);

  const out = [...primary];
  for (const e of extra) {
    const sn = (e.serialNumber || "").toLowerCase();
    // Serial is the stronger key (survives hostname drift/renames); fall back to host.
    const match = (sn && bySerial.get(sn)) || (e.key ? byHost.get(e.key) : undefined);
    if (match) {
      if (!match.serialNumber && e.serialNumber) match.serialNumber = e.serialNumber;
      if (!match.operatingSystem && e.operatingSystem) match.operatingSystem = e.operatingSystem;
      if (!match.operatingSystemVersion && e.operatingSystemVersion) match.operatingSystemVersion = e.operatingSystemVersion;
      if (!match.department && e.department) match.department = e.department;
      if (!match.assignedUserEmail && e.assignedUserEmail) match.assignedUserEmail = e.assignedUserEmail;
      if (match.lastLogonDate == null && e.lastLogonDate != null) match.lastLogonDate = e.lastLogonDate;
      for (const s of e.sources) match.sources = withSource(match.sources, s);
      index(match); // may have just gained a serial → let later rows join on it too
      continue;
    }
    out.push(e);
    index(e);
  }
  return out;
}

// Overlay EZOffice assets onto a base device list, keyed by name. Matched assets
// enrich their device (authoritative for serial/category/status/holder, adding the
// "ezoffice" source tag); UNmatched assets become their own "ezoffice" rows so
// peripherals AD never sees (mice, adapters, monitors) still appear (req. A).
export function consolidate(base: ConsolidatedDevice[], assets: InventoryAsset[] | null): ConsolidatedDevice[] {
  const map = new Map<string, ConsolidatedDevice>();
  for (const d of base) if (d.key) map.set(d.key, d);

  if (assets) {
    // Process assets most-authoritative-first so that, among EZOffice records
    // sharing one AD hostname, the live/newest one is the one that enriches the AD
    // row — the join is then deterministic, not dependent on the API's array order
    // (which could otherwise surface a retired duplicate's serial/status/QR). Copy
    // first: never mutate the caller's (possibly memoised) array.
    const ordered = [...assets].sort(
      (x, y) => assetAuthority(y.status, y.asset_id) - assetAuthority(x.status, x.asset_id),
    );
    ordered.forEach((a, i) => {
      const nameKey = keyOf(a.name);
      // A device row (AD and/or ScreenConnect) is enriched by the FIRST asset that
      // matches its host name, which adds the "ezoffice" tag to its sources. Once
      // tagged, a SECOND asset sharing the hostname won't overwrite it — it falls
      // through to its own row below, surfacing an EZOffice duplicate rather than
      // hiding it.
      const devRow = nameKey ? map.get(nameKey) : undefined;
      if (devRow && !devRow.sources.includes("ezoffice")) {
        map.set(nameKey, {
          ...devRow,
          sources: withSource(devRow.sources, "ezoffice"),
          assetId: a.asset_id || devRow.assetId,
          serialNumber: a.serial_number || devRow.serialNumber,
          category: a.category || devRow.category,
          ezStatus: a.status || devRow.ezStatus,
          assignedUserEmail: a.assigned_user_email || devRow.assignedUserEmail,
          qrUrl: a.qr_url || devRow.qrUrl,
          ongoingMaintenance: a.in_maintenance || devRow.ongoingMaintenance,
        });
        return;
      }
      // No AD match: this asset is its OWN row, keyed by its UNIQUE asset_id — never
      // by name. Assets routinely share a generic model name (3× "Macbook Air M5",
      // N× "Apple Magic Mouse", power adapters …); name-keying collapsed them all
      // into a single last-writer-wins row. asset_id keeps each physical unit
      // distinct. An id-less asset (unexpected) gets a synthetic per-index key so it
      // still surfaces as its own row and can never clobber a device (AD/SC) row.
      const k = a.asset_id ? `asset:${a.asset_id}` : nameKey ? `asset:noid:${i}` : "";
      if (!k) return;
      const name = a.name || a.asset_id || "";
      map.set(k, {
        key: k,
        name,
        displayName: stripDomain(name) || name,
        sources: ["ezoffice"],
        assetId: a.asset_id || undefined,
        serialNumber: a.serial_number || undefined,
        category: a.category || undefined,
        ezStatus: a.status || undefined,
        assignedUserEmail: a.assigned_user_email || undefined,
        qrUrl: a.qr_url || undefined,
        ongoingMaintenance: a.in_maintenance || undefined,
      });
    });
  }
  return Array.from(map.values());
}

/* -------------------------------------------------------------------------- */
/* Lifecycle state (req. E — fixes "ESTADO DESCONHECIDO" on every row)        */
/* -------------------------------------------------------------------------- */

export type Tone = "emerald" | "amber" | "red" | "zinc" | "violet" | "sky";
export type StateId =
  | "disabled" | "maintenance" | "broken" | "lost" | "inactive"
  | "retired" | "available" | "inuse" | "active" | "unknown";

export interface DeviceState { id: StateId; label: string; tone: Tone; }

// Ordering for the default sort + Estado buckets: attention states first,
// healthy last, genuinely-unknown dead last. "Em manutenção" ranks just below
// AD-disabled — a device being actively serviced is the next most actionable
// operational state.
export const STATE_RANK: Record<StateId, number> = {
  disabled: 0, maintenance: 1, broken: 2, lost: 3, inactive: 4,
  retired: 5, available: 6, inuse: 7, active: 8, unknown: 9,
};

// Days since a "yyyy-MM-dd HH:mm:ss" (PowerShell) or ISO-8601 (inventory API)
// stamp; null when missing or unparseable.
export function daysSince(dateStr?: string | null): number | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T"));
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

// The single source of truth for a device's state. Priority (highest first):
//   1. AD says disabled            → Desativado
//   2. we have a real last-seen     → Ativo / Inativo by recency (THIS is what
//      fixes the Mac path, where `enabled` is always undefined but last_seen is
//      known, so every device used to fall through to "Estado desconhecido")
//   3. EZOffice lifecycle status    → Em uso / Disponível / Abatido / Avariado / Perdido
//   4. AD says enabled (no recency) → Ativo
//   5. otherwise                    → Desconhecido (rare: an asset-only row with
//      no status and no dates, e.g. a spare mouse)
export function deviceState(d: ConsolidatedDevice): DeviceState {
  if (d.enabled === false) return { id: "disabled", label: "Desativado", tone: "red" };

  // An open EZOffice work order overrides recency/lifecycle: a device on the
  // bench reads "Em manutenção" even if it was seen recently, so the operator
  // can filter the fleet down to what's actually being serviced.
  if (d.ongoingMaintenance) return { id: "maintenance", label: "Em manutenção", tone: "sky" };

  const days = daysSince(d.lastLogonDate);
  if (days !== null) {
    return days < STALE_DAYS
      ? { id: "active", label: "Ativo", tone: "emerald" }
      : { id: "inactive", label: "Inativo", tone: "amber" };
  }

  switch ((d.ezStatus || "").toLowerCase()) {
    case "in use":    return { id: "inuse", label: "Em uso", tone: "emerald" };
    case "available": return { id: "available", label: "Disponível", tone: "violet" };
    case "retired":   return { id: "retired", label: "Abatido", tone: "zinc" };
    case "broken":    return { id: "broken", label: "Avariado", tone: "red" };
    case "lost":      return { id: "lost", label: "Perdido", tone: "amber" };
  }

  if (d.enabled === true) return { id: "active", label: "Ativo", tone: "emerald" };
  return { id: "unknown", label: "Desconhecido", tone: "zinc" };
}

// EZOffice's terse English lifecycle tokens → PT (for the detail panel).
export function ezStatusLabel(status?: string): string {
  switch ((status || "").toLowerCase()) {
    case "in use":    return "Em uso";
    case "available": return "Disponível";
    case "retired":   return "Abatido";
    case "broken":    return "Avariado";
    case "lost":      return "Perdido";
    case "":          return "—";
    default:          return status!;
  }
}

/* -------------------------------------------------------------------------- */
/* Category → icon (req. D)                                                   */
/* -------------------------------------------------------------------------- */

// Ordered keyword → icon rules. First match on "<category> <name>" wins, so put
// the more specific patterns first (a "power adapter" must beat a bare "power").
const ICON_RULES: ReadonlyArray<{ re: RegExp; Icon: LucideIcon }> = [
  { re: /\b(power|charger|carregad|adapt|adaptad|fonte de aliment|psu)\b/, Icon: PlugZap },
  { re: /(laptop|notebook|macbook|elitebook|portát|portat|ultrabook)/,     Icon: Laptop },
  { re: /(mouse|rato|mice)/,                                               Icon: Mouse },
  { re: /(keyboard|teclad)/,                                               Icon: Keyboard },
  { re: /(headphone|headset|auscultad|earphone|earbud|fone)/,              Icon: Headphones },
  { re: /(speaker|coluna|altifalan|soundbar)/,                             Icon: Speaker },
  { re: /(webcam)/,                                                        Icon: Webcam },
  { re: /(camera|câmara|camara|dslr|gopro)/,                               Icon: Camera },
  { re: /(projector|projetor|projector|beamer)/,                           Icon: Projector },
  { re: /(monitor|screen|ecrã|ecra|display|écran)/,                        Icon: Monitor },
  { re: /(printer|impressor|multifun|scanner|digitaliz)/,                  Icon: Printer },
  { re: /(phone|telefone|telemóv|telemov|iphone|smartphone|android)/,      Icon: Smartphone },
  { re: /(tablet|ipad)/,                                                   Icon: Tablet },
  { re: /(watch|relóg|relog|wearable)/,                                    Icon: Watch },
  { re: /(server|servidor|rack|nas\b)/,                                    Icon: Server },
  { re: /(router|switch|firewall|access point|\bap\b|gateway)/,            Icon: Router },
  { re: /(network|rede|ethernet|lan\b)/,                                   Icon: Network },
  { re: /(dock|docking|hub|usb|thunderbolt)/,                              Icon: Usb },
  { re: /(cable|cabo|cord|adaptador de vídeo|hdmi|displayport)/,           Icon: Cable },
  { re: /(disk|disco|ssd|hdd|drive|storage|armazenam)/,                    Icon: HardDrive },
  { re: /(memory|memór|memor|\bram\b|dimm)/,                               Icon: MemoryStick },
  { re: /(cpu|processad|gpu|placa)/,                                       Icon: Cpu },
  { re: /(desktop|workstation|torre|\btower\b|\bpc\b)/,                     Icon: Monitor },
];

// Pick an icon for a consolidated row from its EZOffice category, falling back to
// the device name. A BMAP laptop name (PT-LPT-…) implies a laptop even with no
// category; anything unrecognised gets a neutral box.
export function categoryIcon(category?: string, name?: string): LucideIcon {
  const hay = `${category || ""} ${name || ""}`.toLowerCase();
  for (const { re, Icon } of ICON_RULES) if (re.test(hay)) return Icon;
  if (/^pt-lpt-/i.test((name || "").trim())) return Laptop;
  return Package;
}

/* -------------------------------------------------------------------------- */
/* External links (req. E — EZOffice + ScreenConnect)                         */
/* -------------------------------------------------------------------------- */

// Build a URL from an admin-configured template. The template comes from Settings
// (never fabricated here) and may use {name}, {serial}, {id} placeholders, each
// URL-encoded on substitution. Returns null when the template is empty OR when it
// references a placeholder the row can't fill (so we never open a broken link).
export function applyUrlTemplate(
  template: string | undefined,
  vars: { name?: string; serial?: string; id?: string },
): string | null {
  const tpl = (template || "").trim();
  if (!tpl) return null;
  const subs: Record<string, string | undefined> = { name: vars.name, serial: vars.serial, id: vars.id };
  let missing = false;
  const url = tpl.replace(/\{(name|serial|id)\}/g, (_m, key: string) => {
    const val = subs[key];
    if (!val) { missing = true; return ""; }
    return encodeURIComponent(val);
  });
  if (missing) return null;
  return url;
}

// Open an external URL in the user's real browser. In Electron this goes through
// the main process (shell.openExternal, protocol-checked); in the browser preview
// it falls back to window.open. Only ever called from an explicit user click.
export function openExternal(url: string): void {
  const api = (window as unknown as { appAPI?: { openExternal?: (u: string) => Promise<unknown> } }).appAPI;
  if (api?.openExternal) { void api.openExternal(url); return; }
  window.open(url, "_blank", "noopener,noreferrer");
}
