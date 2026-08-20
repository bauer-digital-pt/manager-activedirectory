/**
 * Web Bluetooth transport tests (no hardware). These pin the property-aware write
 * selection that prevents "GATT operation not permitted": the candidate configs
 * hard-code a write mode, but the real characteristic may support only one — the
 * pipe must issue the mode the characteristic actually advertises.
 *
 *     node --test test/supvan/webbt.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveWriteMethod,
  createWebBtPipe,
  type GattCharProperties,
} from "../../src/renderer/src/lib/supvan-webbt.ts";
import { resolveTransportConfig } from "../../src/main/supvan/transport/config.ts";

test("resolveWriteMethod honors the request when both modes are supported", () => {
  const both: GattCharProperties = { write: true, writeWithoutResponse: true };
  assert.equal(resolveWriteMethod("with-response", both), "with-response");
  assert.equal(resolveWriteMethod("without-response", both), "without-response");
});

test("resolveWriteMethod falls back to the only supported mode", () => {
  const respOnly: GattCharProperties = { write: true };
  const noRespOnly: GattCharProperties = { writeWithoutResponse: true };
  // Requested without-response but char only does with-response → with-response.
  assert.equal(resolveWriteMethod("without-response", respOnly), "with-response");
  // Requested with-response but char only does without-response → without-response.
  assert.equal(resolveWriteMethod("with-response", noRespOnly), "without-response");
});

test("resolveWriteMethod trusts the request when properties are absent or empty", () => {
  assert.equal(resolveWriteMethod("with-response", undefined), "with-response");
  assert.equal(resolveWriteMethod("without-response", undefined), "without-response");
  // Advertises neither write flag: best-effort, keep the configured mode.
  assert.equal(resolveWriteMethod("with-response", { read: true }), "with-response");
});

/** A minimal characteristic mock recording which write method was invoked. */
function mockChar(properties: GattCharProperties | undefined, opts: { uuid?: string; throwOnWrite?: string } = {}) {
  const calls = { withResponse: 0, withoutResponse: 0 };
  const fail = () => {
    if (opts.throwOnWrite) throw new Error(opts.throwOnWrite);
  };
  const char = {
    properties,
    uuid: opts.uuid ?? "mock",
    value: undefined as DataView | undefined,
    async writeValueWithResponse() {
      calls.withResponse++;
      fail();
    },
    async writeValueWithoutResponse() {
      calls.withoutResponse++;
      fail();
    },
    async startNotifications() {
      return char;
    },
    async stopNotifications() {
      return char;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return { char, calls };
}

test("createWebBtPipe issues the write mode the write characteristic supports", async () => {
  // Config asks for with-response command writes, but the characteristic only
  // supports write-without-response — the pipe must adapt instead of throwing
  // "GATT operation not permitted".
  const cfg = resolveTransportConfig({ commandWrite: "with-response", dataWrite: "without-response", chunkBytes: 512 });
  const { char, calls } = mockChar({ writeWithoutResponse: true, notify: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { pipe } = createWebBtPipe(char as any, char as any, cfg);

  // A 16-byte command frame → commandWrite("with-response") → adapted to without-response.
  await pipe.write(new Uint8Array(16));
  assert.equal(calls.withResponse, 0, "must not use unsupported with-response");
  assert.equal(calls.withoutResponse, 1, "adapts command write to without-response");
});

test("createWebBtPipe keeps with-response when the char requires it", async () => {
  const cfg = resolveTransportConfig({ dataWrite: "without-response", chunkBytes: 512 });
  const { char, calls } = mockChar({ write: true, notify: true }); // no writeWithoutResponse
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { pipe } = createWebBtPipe(char as any, char as any, cfg);

  // A 512-byte data frame → dataWrite("without-response") → adapted to with-response.
  await pipe.write(new Uint8Array(512));
  assert.equal(calls.withoutResponse, 0, "must not use unsupported without-response");
  assert.equal(calls.withResponse, 1, "adapts data write to with-response");
});

test("createWebBtPipe annotates a write failure with mode + characteristic", async () => {
  const cfg = resolveTransportConfig({ commandWrite: "with-response" });
  const { char } = mockChar(
    { write: true, notify: true },
    { uuid: "0000ff02-0000-1000-8000-00805f9b34fb", throwOnWrite: "GATT operation not permitted" },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { pipe } = createWebBtPipe(char as any, char as any, cfg);

  await assert.rejects(
    () => pipe.write(new Uint8Array(16)),
    (err: Error) => {
      // Self-diagnosing: carries the effective mode, the char UUID, and the raw text.
      assert.match(err.message, /Escrita GATT falhou/);
      assert.match(err.message, /with-response/);
      assert.match(err.message, /0000ff02-0000-1000-8000-00805f9b34fb/);
      assert.match(err.message, /GATT operation not permitted/);
      return true;
    },
  );
});
