/**
 * Device consolidation join (lib/devices.ts). Pins the cross-source key so an AD
 * computer object, its EZOffice asset AND its ScreenConnect session merge into ONE
 * enriched row, tagged with every source that contributed.
 *
 * The original regression this guards: AD exposes the short host name
 * (`PT-LPT-ADM-08`) while EZOffice stores the FQDN (`PT-LPT-ADM-08.bmap.lis`). A raw
 * lowercase key never matched, so the row never got an `assetId` → the SUPVAN label
 * printed without a QR ("Dispositivo sem ativo no EZOffice"). The join key strips the
 * AD domain on both sides.
 *
 * The provenance model is a SET, not a single enum: `sources: DeviceSource[]`. A row
 * a device is known to AD, EZOffice and ScreenConnect carries all three tags; the
 * "Fonte" filter is membership, not equality. `sig()` below flattens that set into a
 * stable string so the old `.source === "both"` assertions map cleanly onto it
 * ("both" → "ad+ezoffice").
 *
 *     node --test test/devices.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  fromAD, fromScreenConnect, mergeDeviceSources, consolidate, deviceState,
  type ConsolidatedDevice,
} from "../src/renderer/src/lib/devices.ts";
import type { ADComputer, InventoryAsset, InventorySourceDevice } from "../src/shared/types.ts";

function ad(name: string): ADComputer {
  return { Name: name, DistinguishedName: `CN=${name},OU=O365,DC=bmap,DC=lis`, Enabled: true };
}

function asset(name: string, over: Partial<InventoryAsset> = {}): InventoryAsset {
  return {
    asset_id: "611", name, serial_number: "SN-1", category: "Laptops",
    status: "In Use", purchased_on: "", assigned_user_email: "", exempt: false,
    ...over,
  };
}

function sc(name: string, over: Partial<InventorySourceDevice> = {}): InventorySourceDevice {
  return {
    name, serial_number: "", platform: "Windows 11 Pro", os_version: "",
    manufacturer: "", model: "", department: "", last_seen: null,
    assigned_user_email: "", logged_on_user: "", exempt: false, source: "screenconnect",
    ...over,
  };
}

// Stable signature of a row's provenance set — order-independent, so it survives the
// SOURCE_ORDER-preserving append order. Maps the old single-enum world onto the set:
//   "ad"        → an AD-only base row
//   "ezoffice"  → an asset-only (peripheral / Mac) row
//   "ad+ezoffice" → the old "both": AD computer enriched by its EZOffice asset
const sig = (r: ConsolidatedDevice) => r.sources.slice().sort().join("+");

test("AD short name joins the EZOffice FQDN asset (the QR-less-label fix)", () => {
  const base = [fromAD(ad("PT-LPT-ADM-08"))];
  const rows = consolidate(base, [asset("PT-LPT-ADM-08.bmap.lis", { asset_id: "999" })]);

  assert.equal(rows.length, 1, "must merge, not produce two rows");
  const row = rows[0];
  assert.equal(sig(row), "ad+ezoffice");
  assert.equal(row.assetId, "999", "assetId is what unblocks the public-link QR fetch");
  assert.equal(row.serialNumber, "SN-1");
});

test("case-insensitive on both name and domain suffix", () => {
  const base = [fromAD(ad("PT-LPT-ADM-08"))];
  const rows = consolidate(base, [asset("pt-lpt-adm-08.BMAP.LIS", { asset_id: "42" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assetId, "42");
});

test("non-domain asset (Mac) stays its own ezoffice-only row — no false merge", () => {
  const base = [fromAD(ad("PT-LPT-ADM-08"))];
  const rows = consolidate(base, [asset("Macbook Air M5", { asset_id: "77", category: "Laptops" })]);

  assert.equal(rows.length, 2, "the Mac must NOT collapse into the ADM row");
  const mac = rows.find((r) => r.assetId === "77");
  assert.ok(mac, "Mac asset present");
  assert.equal(sig(mac!), "ezoffice");
});

test("same-named asset-only rows each survive (3x Macbook Air M5, no collapse)", () => {
  const rows = consolidate([], [
    asset("Macbook Air M5", { asset_id: "607" }),
    asset("Macbook Air M5", { asset_id: "608" }),
    asset("Macbook Air M5", { asset_id: "609" }),
  ]);
  assert.equal(rows.length, 3, "all three physical Macs must show, not just one");
  assert.deepEqual(rows.map((r) => r.assetId).sort(), ["607", "608", "609"]);
  for (const r of rows) assert.equal(sig(r), "ezoffice");
});

test("N x Apple Magic Mouse do not collapse", () => {
  const rows = consolidate([], [
    asset("Apple Magic Mouse - White", { asset_id: "604", category: "Mouses" }),
    asset("Apple Magic Mouse - White", { asset_id: "605", category: "Mouses" }),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.assetId).sort(), ["604", "605"]);
});

test("duplicate hostname: the LIVE asset enriches the AD row, the dead one surfaces separately", () => {
  const base = [fromAD(ad("PT-LPT-ADM-02"))];
  // EZOffice holds two records for one machine: a retired leftover + the live one.
  const dead = asset("PT-LPT-ADM-02.bmap.lis", { asset_id: "588", status: "Retired", qr_url: "q-588" });
  const live = asset("PT-LPT-ADM-02.bmap.lis", { asset_id: "595", status: "In Use", qr_url: "q-595" });

  for (const order of [[dead, live], [live, dead]]) {
    const rows = consolidate(base, order);
    assert.equal(rows.length, 2, "both EZOffice records must show, not just one");
    const both = rows.find((r) => sig(r) === "ad+ezoffice");
    const extra = rows.find((r) => sig(r) === "ezoffice");
    assert.ok(both && extra, "one merged AD row + one standalone EZOffice row");
    // Deterministic regardless of input order: the live record wins the merged row.
    assert.equal(both!.assetId, "595", "the live (In Use) asset enriches the AD computer");
    assert.equal(both!.qrUrl, "q-595", "the merged row's QR points at the live asset");
    assert.equal(extra!.assetId, "588", "the retired duplicate is surfaced as its own row");
    assert.equal(extra!.displayName, "PT-LPT-ADM-02", "domain still stripped for display");
  }
});

test("duplicate hostname, same status: the newest (highest id) asset wins deterministically", () => {
  const base = [fromAD(ad("PT-LPT-ADM-02"))];
  const older = asset("PT-LPT-ADM-02.bmap.lis", { asset_id: "588", status: "In Use" });
  const newer = asset("PT-LPT-ADM-02.bmap.lis", { asset_id: "595", status: "In Use" });
  for (const order of [[older, newer], [newer, older]]) {
    const both = consolidate(base, order).find((r) => sig(r) === "ad+ezoffice");
    assert.equal(both!.assetId, "595", "newest id wins the tie irrespective of array order");
  }
});

test("an id-less asset never clobbers the AD row it shares a hostname with", () => {
  const base = [fromAD(ad("PT-LPT-ADM-08"))];
  const rows = consolidate(base, [
    asset("PT-LPT-ADM-08.bmap.lis", { asset_id: "999", qr_url: "q-999" }),
    asset("PT-LPT-ADM-08.bmap.lis", { asset_id: "" }), // unexpected: no id
  ]);
  const both = rows.find((r) => sig(r) === "ad+ezoffice");
  assert.ok(both, "the AD computer must remain, enriched");
  assert.equal(both!.assetId, "999", "the real asset's id survives — not wiped by the id-less one");
  assert.equal(both!.qrUrl, "q-999", "the merged row keeps the real asset's QR");
  // AD row (both) + the id-less asset's own surfaced row.
  assert.equal(rows.length, 2);
});

test("distinct FQDNs do not collide", () => {
  const base = [fromAD(ad("PT-LPT-ADM-08")), fromAD(ad("PT-LPT-ADM-09"))];
  const rows = consolidate(base, [
    asset("PT-LPT-ADM-08.bmap.lis", { asset_id: "A" }),
    asset("PT-LPT-ADM-09.bmap.lis", { asset_id: "B" }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.name === "PT-LPT-ADM-08")!.assetId, "A");
  assert.equal(rows.find((r) => r.name === "PT-LPT-ADM-09")!.assetId, "B");
});

/* -------------------------------------------------------------------------- */
/* ScreenConnect as a third source (mergeDeviceSources + fromScreenConnect)   */
/*                                                                            */
/* The join key is "hostname + serial": serial is the stronger key (survives a */
/* rename), hostname the fallback. A machine ScreenConnect can reach that AD   */
/* never saw must still appear as its own row — that's the whole point of      */
/* pulling ScreenConnect in.                                                   */
/* -------------------------------------------------------------------------- */

test("fromScreenConnect tags the row screenconnect-only and keeps last_seen null", () => {
  const row = fromScreenConnect(sc("PT-DSK-STUDIO-01", { serial_number: "MJ0X7A2LMN" }));
  assert.equal(sig(row), "screenconnect");
  assert.equal(row.serialNumber, "MJ0X7A2LMN");
  assert.equal(row.lastLogonDate, null, "a session ping is not a real logon");
  assert.equal(row.displayName, "PT-DSK-STUDIO-01");
});

test("a nameless ScreenConnect machine still gets a stable serial-scoped key", () => {
  const row = fromScreenConnect(sc("", { serial_number: "MJ0X7A2LMN" }));
  assert.equal(row.key, "sc:mj0x7a2lmn", "serial-scoped key so a nameless row is never dropped");
  assert.equal(sig(row), "screenconnect");
});

test("ScreenConnect-only machine appears as its own row (AD never saw it)", () => {
  const base = [fromAD(ad("PT-LPT-IT-01"))];
  const scOnly = fromScreenConnect(sc("PT-DSK-STUDIO-01", { serial_number: "MJ0X7A2LMN" }));
  const rows = mergeDeviceSources(base, [scOnly]);

  assert.equal(rows.length, 2, "the ScreenConnect-only desktop must surface, not be swallowed");
  const studio = rows.find((r) => r.displayName === "PT-DSK-STUDIO-01");
  assert.ok(studio, "ScreenConnect-only row present");
  assert.equal(sig(studio!), "screenconnect");
});

test("ScreenConnect enriches a matching AD row by hostname and adds its tag", () => {
  const base = [fromAD(ad("PT-LPT-IT-01"))];
  // AD's fromAD carries no serial; ScreenConnect fills it, matching by hostname.
  const rows = mergeDeviceSources(base, [
    fromScreenConnect(sc("PT-LPT-IT-01", { serial_number: "5CD1234ABC" })),
  ]);

  assert.equal(rows.length, 1, "same hostname collapses to one row");
  const row = rows[0];
  assert.equal(sig(row), "ad+screenconnect");
  assert.equal(row.enabled, true, "the AD identity is preserved (still the primary)");
  assert.equal(row.serialNumber, "5CD1234ABC", "ScreenConnect fills the serial AD lacked");
});

test("hostname drift: ScreenConnect still joins an AD row on serial alone", () => {
  // AD knows the machine under an old name + serial; ScreenConnect reports a renamed
  // host but the SAME serial. Serial is the stronger key, so they must still merge.
  const adRow = fromAD(ad("PT-LPT-OLD-01"));
  adRow.serialNumber = "5CD1234ABC";
  const rows = mergeDeviceSources([adRow], [
    fromScreenConnect(sc("PT-LPT-NEW-01", { serial_number: "5CD1234ABC" })),
  ]);

  assert.equal(rows.length, 1, "serial join beats the hostname mismatch");
  assert.equal(sig(rows[0]), "ad+screenconnect");
  assert.equal(rows[0].displayName, "PT-LPT-OLD-01", "primary (AD) keeps its identity");
});

test("full three-source pipeline: AD → ScreenConnect merge → EZOffice overlay", () => {
  const base = [fromAD(ad("PT-LPT-IT-01"))];
  // ScreenConnect adds a serial + a ScreenConnect-only desktop.
  const merged = mergeDeviceSources(base, [
    fromScreenConnect(sc("PT-LPT-IT-01", { serial_number: "5CD1234ABC" })),
    fromScreenConnect(sc("PT-DSK-STUDIO-01", { serial_number: "MJ0X7A2LMN" })),
  ]);
  // EZOffice inventories the domain laptop (FQDN) but not the ScreenConnect desktop.
  const rows = consolidate(merged, [
    asset("PT-LPT-IT-01.bmap.lis", { asset_id: "1", qr_url: "q-1" }),
  ]);

  const it01 = rows.find((r) => r.displayName === "PT-LPT-IT-01");
  const studio = rows.find((r) => r.displayName === "PT-DSK-STUDIO-01");
  assert.ok(it01 && studio, "both machines present");
  assert.equal(sig(it01!), "ad+ezoffice+screenconnect", "IT-01 carries all three sources");
  assert.equal(it01!.assetId, "1", "EZOffice enrichment landed on the merged row");
  assert.equal(it01!.qrUrl, "q-1");
  assert.equal(sig(studio!), "screenconnect", "the ScreenConnect-only desktop stays single-source");
});

test("mergeDeviceSources does not double-tag a source on repeat merges", () => {
  const base = [fromAD(ad("PT-LPT-IT-01"))];
  const scRow = fromScreenConnect(sc("PT-LPT-IT-01", { serial_number: "5CD1234ABC" }));
  const once = mergeDeviceSources(base, [scRow]);
  const twice = mergeDeviceSources(once, [fromScreenConnect(sc("PT-LPT-IT-01", { serial_number: "5CD1234ABC" }))]);
  assert.equal(twice.length, 1);
  assert.deepEqual(twice[0].sources.slice().sort(), ["ad", "screenconnect"], "no duplicate tags");
});

// The bulk /assets read carries a heuristic in_maintenance flag; consolidate() must
// surface it as ongoingMaintenance so DeviceRow can flip the menu item between
// "Começar manutenção" and "Ver manutenção" without a per-asset probe.
test("in_maintenance flag surfaces as ongoingMaintenance on an enriched AD row", () => {
  const base = [fromAD(ad("PT-LPT-ADM-08"))];
  const rows = consolidate(base, [asset("PT-LPT-ADM-08.bmap.lis", { asset_id: "999", in_maintenance: true })]);
  const both = rows.find((r) => sig(r) === "ad+ezoffice");
  assert.ok(both, "the AD row joined its asset");
  assert.equal(both!.ongoingMaintenance, true, "the maintenance flag rode the join");
});

test("in_maintenance flag surfaces on an asset-only (peripheral/Mac) row", () => {
  const rows = consolidate([], [asset("Macbook Air M5", { asset_id: "77", category: "Laptops", in_maintenance: true })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ongoingMaintenance, true);
});

test("no in_maintenance flag leaves ongoingMaintenance falsy (menu shows Começar)", () => {
  const base = [fromAD(ad("PT-LPT-ADM-08"))];
  const merged = consolidate(base, [asset("PT-LPT-ADM-08.bmap.lis", { asset_id: "999" })]);
  const only = consolidate([], [asset("Magic Mouse", { asset_id: "5" })]);
  assert.ok(!merged[0].ongoingMaintenance, "enriched row not falsely flagged");
  assert.ok(!only[0].ongoingMaintenance, "asset-only row not falsely flagged");
});

// A device with an open work order reads "Em manutenção" — and that state wins
// over last-seen recency, so a recently-seen laptop on the bench is still
// filterable as under maintenance (it does NOT fall through to "Ativo").
test("ongoingMaintenance yields the 'Em manutenção' state, overriding recency", () => {
  const base = [fromAD(ad("PT-LPT-IT-01"))];
  const [row] = consolidate(base, [
    asset("PT-LPT-IT-01.bmap.lis", { asset_id: "1", in_maintenance: true }),
  ]);
  // Seen today — normally "Ativo".
  row.lastLogonDate = new Date().toISOString();
  const st = deviceState(row);
  assert.equal(st.id, "maintenance");
  assert.equal(st.label, "Em manutenção");
});

// An AD-disabled device still reads "Desativado": maintenance does not mask a
// decommissioned machine.
test("AD-disabled outranks maintenance", () => {
  const base = [fromAD({ Name: "OLD-PC", DistinguishedName: "CN=OLD-PC,DC=bmap,DC=lis", Enabled: false })];
  const [row] = consolidate(base, [
    asset("OLD-PC.bmap.lis", { asset_id: "2", in_maintenance: true }),
  ]);
  assert.equal(deviceState(row).id, "disabled");
});
