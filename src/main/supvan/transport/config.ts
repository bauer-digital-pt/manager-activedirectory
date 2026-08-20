/**
 * SUPVAN E11 Bluetooth transport configuration (pure, dependency-free).
 *
 * Everything hardware-specific about the BLE link lives here as data, so the
 * platform transport (renderer lib/supvan-webbt.ts) carries no magic numbers.
 *
 * IMPORTANT — all UUIDs below are CANDIDATES, not confirmed E11 values. They are
 * reverse-engineered from the reference (github.com/heeen/supvan-cups, itself
 * decompiled from the vendor Android app) plus the plan's risk register. NONE has
 * been checked against real E11 silicon. The Phase-0/5 hardware bring-up (13:00)
 * captures the true service/characteristic UUIDs; until then the transport probes
 * these candidates in order and the first service that yields a notify+write pair
 * wins — the same auto-detect the reference's `chars_for_service` performs.
 *
 * TODO(bring-up, 13:00 hardware): replace CANDIDATE_TRANSPORT_CONFIGS with the one
 * real config once captured (nRF Connect / a Chromium chrome://bluetooth-internals
 * dump), and delete the candidates that did not match.
 */

/** How a characteristic write is issued. */
export type WriteMode = "with-response" | "without-response";

export interface TransportConfig {
  /** Human label for logs / TODO tracking (which candidate this is). */
  label: string;
  /** GATT primary service — 16-bit shorthand number or full 128-bit UUID string. */
  serviceUuid: number | string;
  /** Notify characteristic (status/ack frames arrive here). */
  notifyCharUuid: number | string;
  /** Write characteristic. May equal notifyCharUuid on a shared write+notify part. */
  writeCharUuid: number | string;
  /**
   * 16-byte command frames: write-WITH-response so the ATT layer confirms delivery
   * (the semantic ack still arrives separately as a notification).
   */
  commandWrite: WriteMode;
  /** 512-byte bulk data frames: write-WITHOUT-response for throughput. */
  dataWrite: WriteMode;
  /** Per-write sub-chunk size — MTU is neither settable nor readable via Web BT. */
  chunkBytes: number;
  /** Idle window (ms) after the last notification before flushing a trailing frame. */
  settleMs: number;
}

/** ~180 B is safe on Win 10 1703+, where Chromium negotiates an MTU of ~185–244. */
export const DEFAULT_CHUNK_BYTES = 180;
/** 20 B = MTU(23)-3 at the ATT default; universally safe if the MTU stays tiny. */
export const SAFE_CHUNK_BYTES = 20;
/** Default idle window before releasing a single-notification trailing frame. */
export const DEFAULT_SETTLE_MS = 20;

/**
 * Advertised-name shape used for discovery. The reference filters on `^[TGD]\d{2}`;
 * we add the E class for the E11.
 *
 * CONFIRMED against a real unit: our E11 advertises "T0183C260511K112" — a
 * serial-derived name starting `T` + digits, so it matches this regex (auto-pick
 * hits it) and the "T" namePrefix filter below (it shows in the scan). The leading
 * token looks per-unit, not a shared "T0183" model prefix, so the regex stays broad
 * rather than pinned to one serial; anything unexpected still falls to the manual
 * chooser. See test/supvan/transport-config.test.ts for the pinned sample.
 */
export const DEVICE_NAME_RE = /^[TGDE]\d{2}/i;
/** namePrefix filters for requestDevice() — broad on purpose (see DEVICE_NAME_RE). */
export const DEVICE_NAME_PREFIXES: readonly string[] = ["T", "G", "D", "E"];
/** SUPVAN OUI seen in the reference (MAC A4:93:40:*). UNVERIFIED per unit. */
export const SUPVAN_OUI = "A4:93:40";

const E0FF_SERVICE_UUID = "0000e0ff-3c17-d293-8e48-14fe2e4da212";

/**
 * Candidate GATT layouts, tried in order. All UNVERIFIED (see file header).
 *  - ff00: the generic Nordic-style 0xFF00 service with split write/notify chars.
 *  - e0ff: the vendor 128-bit service with the common 0xFFE1/0xFFE9 notify/write pair.
 *  - fee7: a shared write+notify characteristic under 0xFEE7 (single-char pattern).
 */
export const CANDIDATE_TRANSPORT_CONFIGS: readonly TransportConfig[] = [
  {
    label: "ff00",
    serviceUuid: 0xff00,
    notifyCharUuid: 0xff01,
    writeCharUuid: 0xff02,
    commandWrite: "with-response",
    dataWrite: "without-response",
    chunkBytes: DEFAULT_CHUNK_BYTES,
    settleMs: DEFAULT_SETTLE_MS,
  },
  {
    label: "e0ff",
    serviceUuid: E0FF_SERVICE_UUID,
    notifyCharUuid: 0xffe1,
    writeCharUuid: 0xffe9,
    commandWrite: "with-response",
    dataWrite: "without-response",
    chunkBytes: DEFAULT_CHUNK_BYTES,
    settleMs: DEFAULT_SETTLE_MS,
  },
  {
    label: "fee7",
    serviceUuid: 0xfee7,
    notifyCharUuid: 0xfec1,
    writeCharUuid: 0xfec1, // shared write+notify characteristic
    commandWrite: "with-response",
    dataWrite: "without-response",
    chunkBytes: DEFAULT_CHUNK_BYTES,
    settleMs: DEFAULT_SETTLE_MS,
  },
];

/**
 * Build a single concrete config by overriding the first candidate. Used once the
 * real values are known (pass a full override) or for tests. Defaults come from
 * CANDIDATE_TRANSPORT_CONFIGS[0] so an empty override is a valid, complete config.
 */
export function resolveTransportConfig(override: Partial<TransportConfig> = {}): TransportConfig {
  return { ...CANDIDATE_TRANSPORT_CONFIGS[0], ...override };
}

/** Distinct service UUIDs to pass as requestDevice() optionalServices. */
export function candidateServiceUuids(
  candidates: readonly TransportConfig[] = CANDIDATE_TRANSPORT_CONFIGS,
): (number | string)[] {
  const seen = new Set<number | string>();
  const out: (number | string)[] = [];
  for (const c of candidates) {
    if (!seen.has(c.serviceUuid)) {
      seen.add(c.serviceUuid);
      out.push(c.serviceUuid);
    }
  }
  return out;
}

/** True if an advertised device name looks like a SUPVAN printer. */
export function looksLikeSupvan(name: string | null | undefined): boolean {
  return typeof name === "string" && DEVICE_NAME_RE.test(name);
}
