/**
 * Transport-config tests. These pin the SHAPE and invariants of the candidate BLE
 * layouts (not the still-unverified UUID values) so an accidental malformed edit —
 * a missing char, a bad chunk size, a broken name regex — fails in CI rather than
 * at the 13:00 hardware bring-up.
 *
 *     node --test test/supvan/transport-config.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CANDIDATE_TRANSPORT_CONFIGS,
  resolveTransportConfig,
  candidateServiceUuids,
  looksLikeSupvan,
  DEVICE_NAME_RE,
  DEFAULT_CHUNK_BYTES,
  SAFE_CHUNK_BYTES,
  type TransportConfig,
} from "../../src/main/supvan/transport/config.ts";

test("every candidate is a complete, well-formed config", () => {
  assert.ok(CANDIDATE_TRANSPORT_CONFIGS.length >= 1);
  for (const c of CANDIDATE_TRANSPORT_CONFIGS) {
    assert.equal(typeof c.label, "string");
    assert.ok(c.label.length > 0);
    for (const uuid of [c.serviceUuid, c.notifyCharUuid, c.writeCharUuid]) {
      assert.ok(typeof uuid === "number" || typeof uuid === "string", "uuid is num|string");
      if (typeof uuid === "number") assert.ok(uuid >= 0 && uuid <= 0xffff, "16-bit range");
    }
    assert.ok(["with-response", "without-response"].includes(c.commandWrite));
    assert.ok(["with-response", "without-response"].includes(c.dataWrite));
    // A sub-chunk must be positive and never exceed the 512 B GATT write ceiling
    // (a larger single write throws InvalidModificationError on real hardware).
    assert.ok(c.chunkBytes > 0 && c.chunkBytes <= 512, "chunkBytes in (0, 512]");
    assert.ok(c.settleMs >= 0);
  }
});

test("candidate labels are unique", () => {
  const labels = CANDIDATE_TRANSPORT_CONFIGS.map((c) => c.label);
  assert.equal(new Set(labels).size, labels.length);
});

test("default/safe chunk sizes stay within the GATT write ceiling", () => {
  assert.ok(DEFAULT_CHUNK_BYTES > 0 && DEFAULT_CHUNK_BYTES <= 512);
  assert.ok(SAFE_CHUNK_BYTES > 0 && SAFE_CHUNK_BYTES <= DEFAULT_CHUNK_BYTES);
});

test("resolveTransportConfig() with no override returns the first candidate", () => {
  assert.deepEqual(resolveTransportConfig(), CANDIDATE_TRANSPORT_CONFIGS[0]);
});

test("resolveTransportConfig() merges a partial override over the defaults", () => {
  const override: Partial<TransportConfig> = {
    serviceUuid: 0x1234,
    chunkBytes: SAFE_CHUNK_BYTES,
  };
  const cfg = resolveTransportConfig(override);
  assert.equal(cfg.serviceUuid, 0x1234);
  assert.equal(cfg.chunkBytes, SAFE_CHUNK_BYTES);
  // Untouched fields fall back to the first candidate.
  assert.equal(cfg.notifyCharUuid, CANDIDATE_TRANSPORT_CONFIGS[0].notifyCharUuid);
  assert.equal(cfg.commandWrite, CANDIDATE_TRANSPORT_CONFIGS[0].commandWrite);
});

test("candidateServiceUuids() is de-duplicated", () => {
  const uuids = candidateServiceUuids();
  assert.equal(new Set(uuids).size, uuids.length);
  // Contains each distinct candidate service.
  for (const c of CANDIDATE_TRANSPORT_CONFIGS) assert.ok(uuids.includes(c.serviceUuid));
});

test("candidateServiceUuids() collapses a repeated service across custom candidates", () => {
  const custom: TransportConfig[] = [
    { ...CANDIDATE_TRANSPORT_CONFIGS[0], label: "a", serviceUuid: 0xaa00 },
    { ...CANDIDATE_TRANSPORT_CONFIGS[0], label: "b", serviceUuid: 0xaa00 },
  ];
  assert.deepEqual(candidateServiceUuids(custom), [0xaa00]);
});

test("DEVICE_NAME_RE / looksLikeSupvan match the expected name shapes", () => {
  for (const name of ["T50", "G10", "D11", "E11", "e11", "T50-Pro"]) {
    assert.ok(looksLikeSupvan(name), `${name} should match`);
    assert.ok(DEVICE_NAME_RE.test(name));
  }
  for (const name of ["", "Printer", "X11", "iPhone", "12E"]) {
    assert.ok(!looksLikeSupvan(name), `${name} should NOT match`);
  }
  assert.ok(!looksLikeSupvan(null));
  assert.ok(!looksLikeSupvan(undefined));
});

test("the real E11 advertised name is recognised (regression: keep auto-pick working)", () => {
  // Captured from our physical E11 — a serial-derived name, not "E11". It begins
  // `T` + two digits, so both the auto-pick regex and the "T" namePrefix filter
  // hit it. Pin it so a future tightening of DEVICE_NAME_RE can't silently drop it.
  const REAL_E11_NAME = "T0183C260511K112";
  assert.ok(looksLikeSupvan(REAL_E11_NAME), "real E11 name must match auto-pick");
  assert.ok(REAL_E11_NAME.startsWith("T"), "must be surfaced by the 'T' namePrefix filter");
});
