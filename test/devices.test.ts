/**
 * Device consolidation join (lib/devices.ts). Pins the cross-source key so an AD
 * computer object and its EZOffice asset merge into ONE enriched row.
 *
 * The regression this guards: AD exposes the short host name (`PT-LPT-ADM-08`)
 * while EZOffice stores the FQDN (`PT-LPT-ADM-08.bmap.lis`). A raw lowercase key
 * never matched, so the row never got an `assetId` → the SUPVAN label printed
 * without a QR ("Dispositivo sem ativo no EZOffice"). The join key now strips the
 * AD domain on both sides.
 *
 *     node --test test/devices.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { fromAD, consolidate } from "../src/renderer/src/lib/devices.ts";
import type { ADComputer, InventoryAsset } from "../src/shared/types.ts";

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

test("AD short name joins the EZOffice FQDN asset (the QR-less-label fix)", () => {
  const base = [fromAD(ad("PT-LPT-ADM-08"))];
  const rows = consolidate(base, [asset("PT-LPT-ADM-08.bmap.lis", { asset_id: "999" })]);

  assert.equal(rows.length, 1, "must merge, not produce two rows");
  const row = rows[0];
  assert.equal(row.source, "both");
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
  assert.equal(mac!.source, "ezoffice");
});

test("same-named asset-only rows each survive (3x Macbook Air M5, no collapse)", () => {
  const rows = consolidate([], [
    asset("Macbook Air M5", { asset_id: "607" }),
    asset("Macbook Air M5", { asset_id: "608" }),
    asset("Macbook Air M5", { asset_id: "609" }),
  ]);
  assert.equal(rows.length, 3, "all three physical Macs must show, not just one");
  assert.deepEqual(rows.map((r) => r.assetId).sort(), ["607", "608", "609"]);
  for (const r of rows) assert.equal(r.source, "ezoffice");
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
    const both = rows.find((r) => r.source === "both");
    const extra = rows.find((r) => r.source === "ezoffice");
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
    const both = consolidate(base, order).find((r) => r.source === "both");
    assert.equal(both!.assetId, "595", "newest id wins the tie irrespective of array order");
  }
});

test("an id-less asset never clobbers the AD row it shares a hostname with", () => {
  const base = [fromAD(ad("PT-LPT-ADM-08"))];
  const rows = consolidate(base, [
    asset("PT-LPT-ADM-08.bmap.lis", { asset_id: "999", qr_url: "q-999" }),
    asset("PT-LPT-ADM-08.bmap.lis", { asset_id: "" }), // unexpected: no id
  ]);
  const both = rows.find((r) => r.source === "both");
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
