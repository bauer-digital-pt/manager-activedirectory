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

// Where a consolidated row's data came from — drives the "Fonte" filter and a
// small badge. "both" = matched an AD object AND an EZOffice asset.
export type DeviceSource = "ad" | "ezoffice" | "both";

export interface ConsolidatedDevice {
  // Stable de-dupe / React key (lowercased name, or the asset id when nameless).
  key: string;
  // Raw name as stored (may carry a domain suffix); use `displayName` in the UI.
  name: string;
  displayName: string;
  source: DeviceSource;

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

function keyOf(name?: string | null): string {
  return (name || "").trim().toLowerCase();
}

// An AD computer object → a base consolidated row.
export function fromAD(d: ADComputer): ConsolidatedDevice {
  const name = d.Name || "";
  return {
    key: keyOf(name) || (d.DistinguishedName || "").toLowerCase(),
    name,
    displayName: stripDomain(name) || name,
    source: "ad",
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
    source: "ad",
    operatingSystem: s.platform || undefined,
    operatingSystemVersion: s.os_version || undefined,
    department: s.department || undefined,
    lastLogonDate: s.last_seen ?? null,
    serialNumber: s.serial_number || undefined,
    assignedUserEmail: s.assigned_user_email || undefined,
  };
}

// Overlay EZOffice assets onto a base device list, keyed by name. Matched assets
// enrich their device (authoritative for serial/category/status/holder, so
// source becomes "both"); UNmatched assets become their own "ezoffice" rows so
// peripherals AD never sees (mice, adapters, monitors) still appear (req. A).
export function consolidate(base: ConsolidatedDevice[], assets: InventoryAsset[] | null): ConsolidatedDevice[] {
  const map = new Map<string, ConsolidatedDevice>();
  for (const d of base) if (d.key) map.set(d.key, d);

  if (assets) {
    for (const a of assets) {
      const k = keyOf(a.name) || (a.asset_id ? `asset:${a.asset_id}` : "");
      if (!k) continue;
      const prev = map.get(k);
      if (prev) {
        map.set(k, {
          ...prev,
          source: prev.source === "ad" ? "both" : prev.source,
          assetId: a.asset_id || prev.assetId,
          serialNumber: a.serial_number || prev.serialNumber,
          category: a.category || prev.category,
          ezStatus: a.status || prev.ezStatus,
          assignedUserEmail: a.assigned_user_email || prev.assignedUserEmail,
        });
      } else {
        const name = a.name || a.asset_id || "";
        map.set(k, {
          key: k,
          name,
          displayName: stripDomain(name) || name,
          source: "ezoffice",
          assetId: a.asset_id || undefined,
          serialNumber: a.serial_number || undefined,
          category: a.category || undefined,
          ezStatus: a.status || undefined,
          assignedUserEmail: a.assigned_user_email || undefined,
        });
      }
    }
  }
  return Array.from(map.values());
}

/* -------------------------------------------------------------------------- */
/* Lifecycle state (req. E — fixes "ESTADO DESCONHECIDO" on every row)        */
/* -------------------------------------------------------------------------- */

export type Tone = "emerald" | "amber" | "red" | "zinc" | "violet";
export type StateId =
  | "disabled" | "broken" | "lost" | "inactive"
  | "retired" | "available" | "inuse" | "active" | "unknown";

export interface DeviceState { id: StateId; label: string; tone: Tone; }

// Ordering for the default sort + Estado buckets: attention states first,
// healthy last, genuinely-unknown dead last.
export const STATE_RANK: Record<StateId, number> = {
  disabled: 0, broken: 1, lost: 2, inactive: 3, retired: 4,
  available: 5, inuse: 6, active: 7, unknown: 8,
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
