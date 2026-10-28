/**
 * Inventory API address migration (shared/constants.ts).
 *
 * The inventory API is moving off the legacy pyexp-inventory container on
 * pt-srv-pyexp-01 (`http://10.4.4.69:8000`, `version: 0.1.0`) to its own host
 * pt-srv-pyexp-03 on :8760 behind TLS. The move is not port-preserving, so the
 * client address has to change — and that is where the trap is:
 *
 *     baseUrl: stored || DEFAULT_INVENTORY_BASE_URL
 *
 * A stored address WINS. Changing the default alone would move only the installs
 * that were never configured; every machine where anyone opened Definições →
 * Inventário has the old address in inventory.json and would keep calling it in
 * silence, including after that container is switched off. `migrateInventoryBaseUrl`
 * is what makes the cutover a one-line change instead of a visit to every laptop,
 * and these tests pin the two halves that make it safe: it catches every spelling
 * of OUR old default, and it never touches an address somebody chose themselves.
 *
 * It lives in shared/constants.ts (not beside LEGACY_DCS in main.ts) precisely so
 * this file can import it — `node --test` cannot load an electron-bound module.
 *
 *     node --test test/inventoryBaseUrl.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_INVENTORY_BASE_URL,
  LEGACY_INVENTORY_BASE_URLS,
  migrateInventoryBaseUrl,
} from "../src/shared/constants.ts";

const LEGACY = "http://10.4.4.69:8000";

test("a blank or missing address falls back to the default", () => {
  // Same contract as migrateServer(""): a missing/blank value self-heals rather
  // than leaving the Manager pointed at nothing.
  assert.equal(migrateInventoryBaseUrl(""), DEFAULT_INVENTORY_BASE_URL);
  assert.equal(migrateInventoryBaseUrl("   "), DEFAULT_INVENTORY_BASE_URL);
});

test("every spelling of the legacy default is migrated", () => {
  // Trailing slashes and case both reach this setting: the Definições field accepts
  // a trailing slash and the transport strips it. A stored "…:8000/" that dodged
  // the migration would pin that install to a dead address, which is the whole
  // failure this guards.
  for (const stored of [
    LEGACY,
    `${LEGACY}/`,
    `${LEGACY}///`,
    `  ${LEGACY}  `,
    LEGACY.toUpperCase(),
    "HTTP://10.4.4.69:8000/",
  ]) {
    assert.equal(
      migrateInventoryBaseUrl(stored),
      DEFAULT_INVENTORY_BASE_URL,
      `${JSON.stringify(stored)} should have been migrated`,
    );
  }
});

test("an address the user chose is left alone", () => {
  // The migration is scoped to values WE shipped. Someone pointing the Manager at
  // a staging API, a port-forward or a neighbouring host has done so on purpose.
  for (const stored of [
    "https://pyexp-03.bmap.lis:8760",
    "http://10.4.4.69:8001", // same host, different port
    "http://10.4.4.70:8000", // same port, different host
    "http://localhost:8000",
    "https://10.4.4.69:8000", // different scheme — not what we shipped
  ]) {
    assert.equal(migrateInventoryBaseUrl(stored), stored, `${stored} should be untouched`);
  }
});

test("today the migration is a no-op, and that is deliberate", () => {
  // The default is still the legacy address, so nothing moves until the cutover.
  // When DEFAULT_INVENTORY_BASE_URL changes, this assertion flips to the new value
  // and the test below is the one that keeps mattering.
  assert.equal(DEFAULT_INVENTORY_BASE_URL, LEGACY);
  assert.equal(migrateInventoryBaseUrl(LEGACY), LEGACY);
});

test("the legacy list keeps the old address after the default moves", () => {
  // The guard against "fixing" the cutover by editing the list instead of the
  // default: the old address must stay listed, or installs carrying it stop being
  // migrated the moment the default changes — the exact silence this exists to
  // prevent.
  assert.ok(
    LEGACY_INVENTORY_BASE_URLS.includes(LEGACY),
    "the legacy pyexp-inventory address must stay in LEGACY_INVENTORY_BASE_URLS",
  );
});
