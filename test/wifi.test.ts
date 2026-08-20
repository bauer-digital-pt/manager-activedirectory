/**
 * Wrong-Wi-Fi gate policy (lib/wifi.ts). Pins the single source of truth for when
 * the pre-login gate blocks — critically, that an active VPN tunnel is NEVER
 * treated as the wrong network (remote/VPN users reach the domain through the
 * tunnel regardless of the local SSID).
 *
 *     node --test test/wifi.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isWrongWifi, EXPECTED_SSID } from "../src/renderer/src/lib/wifi.ts";

test("not connected → allowed", () => {
  assert.equal(isWrongWifi(null), false);
  assert.equal(isWrongWifi({ connected: false, ssid: null }), false);
  assert.equal(isWrongWifi({ connected: false, ssid: "Whatever" }), false);
});

test("connected to the office SSID → allowed (case-insensitive)", () => {
  assert.equal(isWrongWifi({ connected: true, ssid: EXPECTED_SSID }), false);
  assert.equal(isWrongWifi({ connected: true, ssid: EXPECTED_SSID.toUpperCase() }), false);
});

test("connected to a foreign SSID → blocked", () => {
  assert.equal(isWrongWifi({ connected: true, ssid: "Starbucks_Guest" }), true);
});

test("any interface on the office SSID → allowed (multi-NIC)", () => {
  assert.equal(isWrongWifi({ connected: true, ssid: "Guest", ssids: ["Guest", EXPECTED_SSID] }), false);
});

test("active VPN over a foreign SSID → allowed (the fix)", () => {
  assert.equal(isWrongWifi({ connected: true, ssid: "Home-5G", vpnActive: true }), false);
  assert.equal(
    isWrongWifi({ connected: true, ssid: "Home-5G", ssids: ["Home-5G"], vpnActive: true }),
    false,
  );
});

test("VPN flag absent/false does not weaken the block", () => {
  assert.equal(isWrongWifi({ connected: true, ssid: "Home-5G", vpnActive: false }), true);
});
