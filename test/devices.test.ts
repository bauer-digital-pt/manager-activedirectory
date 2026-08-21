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
