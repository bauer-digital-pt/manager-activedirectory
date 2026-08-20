# SUPVAN E11 — EZOffice label printing (plan + research)

> Status: **Phase 1 (transport-agnostic core) IMPLEMENTED + verified — see §11.**
> Phases 0 (hardware spike) and 2–6 remain. Feature = print an EZOffice asset label
> to a SUPVAN E11 Bluetooth label printer from a device row in the Manager flavor.
> Reference protocol: `github.com/heeen/supvan-cups` (Rust + BlueZ, Linux-only,
> self-declared **unverified against hardware** for its BLE path).
>
> Everything below marked **⚠ UNVERIFIED** must be confirmed on the real E11 before
> the code that depends on it is trusted. The plan is deliberately structured so
> that ~80% of the work (protocol framing + raster pipeline + UI/config/IPC) is
> **transport-independent** and can proceed before the one hardware unknown
> (transport + printhead geometry) is resolved.

---

## 0. TL;DR — the two things that decide everything

1. **Transport is unconfirmed and it is the #1 risk.** The reference repo's own
   `PROTOCOL.md` says the E11/E12 class is **BLE GATT-only** (vendor gates BLE by
   `printingProcess == 4`). But the *only working, tested* reference code
   (`test_print.py`) speaks **Bluetooth Classic RFCOMM/SPP** against a T50, and two
   independent SUPVAN **E10** projects state RFCOMM is "the proven path" and BLE is
   "not production-qualified." The `ble.rs` GATT UUIDs, MTU, and ack timing are all
   reverse-engineered from an Android app and **never validated on hardware**.
   → **A 30-minute hardware spike (§3) must run before we commit to a transport.**
   The user calls the E11 *"Bluetooth de uso duplo"* — that likely means
   keyboard-standalone **plus** a Bluetooth link; it does not tell us Classic vs BLE.

2. **The good news that de-risks the rest:** all three transports (Classic SPP, USB
   HID, BLE GATT) share the **exact same 16-byte command framing, status parsing,
   512-byte data frames, LZMA-compressed 1-bit raster, and print state machine.**
   Only the *byte pipe* differs. So we build one transport-agnostic core and plug a
   thin transport behind an interface. The transport decision blocks a small, late,
   well-isolated slice — not the whole feature.

Second-biggest unknown: **the E11 printhead width in dots.** The reference registry
maps `e11 → supvan_t50 = 384 dots / 48 mm @ 203 dpi`, which is almost certainly
**wrong** — the E11 takes 12 mm and 15 mm tape (the user's 4 rolls), so its head is
~**96 dots (12 mm)** to ~**120 dots (15 mm)** at 8 dots/mm, not 384. Getting this
wrong mis-centers/mis-scales every label. Resolve via a `RETURN_MAT (0x30)` query or
datasheet before trusting any canvas width (§7).

---

## 1. Goal & scope

**In scope**
- A new device action **"Imprimir etiqueta"** in the Manager device UI
  (`DeviceRow` detail-modal footer + right-click menu) that renders the EZOffice
  asset label (QR of the EZOffice asset URL + human-readable asset id / name /
  serial) and prints it to a paired SUPVAN E11.
- Fleet-shareable label settings (media size, darkness/density) via the existing
  `DeviceConfig` sync; **machine-local** saved-printer id (must NOT be pushed
  fleet-wide — see §9.4).
- Manager flavor only. Agent renders the PC-onboarding wizard instead of the device
  list, so the action naturally never appears there.

**Out of scope (explicitly)**
- USB-HID transport (the E11 is a Bluetooth device; HID is documented only as a
  cross-check on framing).
- RFID/consumable auth (`SET_RFID_DATA 0x5D`) unless the spike shows the E11 refuses
  to print without it (§6, risk R7).
- Firmware update (`UPDATE_FW 0xC6`).
- Barcode (Code128) — QR is sufficient for an EZOffice asset link; keep bwip-js as a
  documented fallback only.

---

## 2. Architecture at a glance

```
Renderer (Manager)                          Main process
──────────────────                          ────────────
DeviceRow "Imprimir etiqueta"
  → build label model (assetId, name,
    serial, ezofficeUrl)
  → render to offscreen <canvas>            [ NO native canvas dep — DOM canvas ]
  → QR (qrcode) + text
  → getImageData → threshold → 1bpp pack
  → { widthPx, heightPx, bytesPerRow,
      bitmap:<base64>, meta:{media,darkness} }
        │  IPC  print:label
        ▼
                                    supvan/ (new, transport-agnostic core)
                                      ├ frame.ts      16-byte cmd + checksum
                                      ├ raster.ts     dither→pack→center→buffers
                                      ├ compress.ts   LZMA1-alone (dict 8192)
                                      ├ data.ts       506/512 transfer frames
                                      ├ status.ts     INQUIRY_STA bit parse
                                      ├ pipeline.ts   print state machine
                                      └ transport/
                                          ├ types.ts   SppPipe interface
                                          ├ ble.ts     Web BT bridge / noble  ⚠
                                          └ rfcomm.ts  serialport (COM)        ⚠
```

**Why render in the renderer, transmit in main:** the renderer has a DOM `<canvas>`
for free (no native `canvas` npm module, which would bloat the unsigned Windows CI
and need `asarUnpack`). Main owns all OS/native ops already (netsh Wi-Fi,
safeStorage, biometric) — the BLE/serial byte pipe belongs there, consistent with
the codebase convention. **Exception:** if the spike says **BLE via Web Bluetooth**
(§4 option A), the connection + writes live in the *renderer* and `main` only wires
`select-bluetooth-device` + `setBluetoothPairingHandler`; then `print:label` IPC
becomes unnecessary and the raster core is imported directly by the renderer. This
is the one place the transport decision reshapes the architecture — hence it must be
made early.

---

## 3. FIRST STEP — the transport hardware spike (blocks the transport slice only)

Do this on a Windows box with the real E11 paired, **before** writing any transport
code. ~30 min. Everything in §5–§9 can be built in parallel without it.

1. **Pair the E11** in Windows Settings › Bluetooth.
2. **Classic/SPP test:** `Get-PnpDevice -Class Ports` — if a `COMx` appears for the
   printer, it exposes an **SPP serial port → RFCOMM path** (use `serialport`).
   Confirm with WinRT `RfcommDeviceService` enumeration if ambiguous.
3. **BLE test:** open `chrome://bluetooth-internals` (or Edge equivalent) → Devices →
   if the E11 lists **GATT services/characteristics**, a BLE path exists.
4. **Capture the real GATT UUIDs** with nRF Connect (mobile) or
   `chrome://bluetooth-internals`: which of the three candidate service patterns the
   E11 actually exposes (`fee7`/`e0ff`/`ff00`), the notify vs write characteristic,
   and whether image writes are with/without response. **No public E11 GATT UUIDs
   exist** — this capture is the only ground truth.
5. **Record:** transport (Classic vs BLE), service/char UUIDs, negotiated MTU, and
   the advertised name (expect `^[TGD]\d{2}…`, OUI `A4:93:40`).

**Decision gate:**
- COM port present, no usable GATT → **RFCOMM** → transport = `serialport` (§4-RFCOMM).
- GATT present, no COM port → **BLE** → transport = Web Bluetooth (§4-A) or noble (§4-B).
- Both present → prefer **BLE via Web Bluetooth** (lightest packaging) but keep
  RFCOMM as the proven fallback.

---

## 4. Transport options (decision matrix)

The E11 firmware framing is transport-independent (§5). These options only concern
the byte pipe + discovery + packaging.

| Option | Works if E11 is… | Cross-platform (Win fleet + mac dev) | Native build / packaging | Maintenance | Verdict |
|---|---|---|---|---|---|
| **A. Web Bluetooth** (Chromium renderer + main picker) | BLE GATT | ✅ identical Chromium on both | **none** — no rebuild, no `asarUnpack`, no re-sign | lowest (platform API) | **Primary if BLE** |
| **B. @abandonware/noble** (native N-API) | BLE GATT | ✅ WinRT + CoreBluetooth | heavy — **no prebuilts**, full MSVC+WinSDK 10.0.18362 & Xcode CLT, `@electron/rebuild`, `asarUnpack **/*.node` | high (abandonware) | Fallback if Web BT throughput too low |
| **C. WinRT helper exe** | BLE **or** Classic | ❌ Windows-only, no mac dev | ship unsigned helper via `extraResources` | you own the helper | Last resort |
| **RFCOMM. `serialport`** over paired COM/tty | Classic SPP | ✅ COMx on Win, `/dev/tty.*` on mac | light — **ships prebuilts** (prebuildify) | low | **Primary if RFCOMM** |

Facts that drove this (from the feasibility research):
- Electron 32 = **Chromium 128 / Node 20.16 / ABI 128**. Web Bluetooth
  write-with/without-response is supported on Windows since Chrome 85, notifications
  since Chrome 70; needs Win10 ≥ 1703. **No `watchAdvertisements()`, no `getDevices()`
  persistent permissions, no `permissions.*`** on Windows.
- Web Bluetooth gotchas to design around: **serialize all GATT ops** (a promise
  queue — never fire N writes in parallel); **re-acquire service/characteristic
  after any disconnect**; `requestDevice()` must run inside a real user-gesture
  click handler; list every service in `optionalServices`.
- Electron picker wiring (main): `webContents.on('select-bluetooth-device', …)` —
  **fires repeatedly as scanning progresses**; build a live list, `callback(id)` to
  pick, `callback('')` to cancel; without a listener all BT requests are cancelled.
  Pairing PIN → `session.setBluetoothPairingHandler` (Windows/Linux; mac auto-pairs).
  There is **no `'bluetooth'` permission string** and no `bluetooth` deviceType — the
  picker event is the sole gate.
- noble's blocker is **not ABI** (N-API is ABI-stable) — it's that **no prebuilt
  binaries ship**, so every dev machine + CI must compile it. Its README's
  dongle/Zadig instructions are stale; modern Windows (build ≥ 15063) uses a WinRT
  backend with the built-in radio.

---

## 5. The wire protocol (byte-exact, transport-independent)

All confirmed against the working `test_print.py` **and** the Rust port
(`cmd.rs`/`status.rs`/`data.rs`) — they agree byte-for-byte.

### 5.1 Command frame — 16 bytes

```
[0]=0x7E [1]=0x5A [2]=0x0C [3]=0x00 [4]=0x10 [5]=0x01 [6]=0xAA [7]=CMD
[8..9]=checksum LE   [10]=0x00 [11]=0x01   [12..13]=block_size LE   [14..15]=block_count LE
```
- **Checksum** = unsigned 16-bit sum of **bytes [10..16]** (i.e. 10,11,12,13,14,15),
  stored little-endian at [8],[9]. Do **not** mask/mod (max 6×255=1530, no overflow).
  Bytes 8/9 are not part of the sum.
- `make_cmd(cmd, param)` = frame with `block_size=param`, `block_count=0`.
- `make_cmd_start_trans(cmd, block_size, block_count)` = the two-param form.

### 5.2 Command constants (T50 family = E11's mapped family)

| Name | Hex | Name | Hex |
|---|---|---|---|
| BUF_FULL | 0x10 | STOP_PRINT | 0x14 |
| INQUIRY_STA | 0x11 | RD_DEV_NAME | 0x16 |
| CHECK_DEVICE | 0x12 | RETURN_MAT | 0x30 |
| START_PRINT | 0x13 | NEXT_ZIPPEDBULK | 0x5C |

(Also `READ_REV 0x17`, `PAPER_SKIP 0x2E`, `READ_FWVER 0xC5`, `SET_RFID_DATA 0x5D`.)

### 5.3 Print state machine (one label)

From `test_print.py::do_test_print` + `job.rs::transfer_page` (identical order):

1. `CHECK_DEVICE (0x12)` → expect echo at resp[7].
2. Poll `INQUIRY_STA (0x11)` until `!device_busy && !printing` (≤60 × 100 ms). Abort
   on any error flag (label_end, cover_open, head_temp_high, label_not_installed, …).
3. `START_PRINT (0x13)`.
4. Poll until `printing` bit set.
5. Poll until `!buf_full` (≤200 × 20 ms).
6. **Per raster block:** `NEXT_ZIPPEDBULK (0x5C)` as `start_trans(block_size=512,
   block_count=num_packets)` → send N × 512-byte data frames → **read a response only
   after the LAST packet** → `sleep(20 ms)` → `BUF_FULL (0x10)` as
   `start_trans(block_size=compressed_len, block_count=speed)`.
7. Poll `INQUIRY_STA.printing` to completion (≤300 × 100 ms = 30 s).
8. `STOP_PRINT (0x14)`.

> **⚠ ack-timing conflict (risk R2):** the working Python reads a response **only
> after the last** data packet; the Rust `spp_pipe.rs` reads an ack after **every
> packet except the last**. These are opposite. `test_print.py` is the known-good
> one → **follow the Python (last-only) timing** and confirm on hardware. Wrong
> timing = 3-beep / RFCOMM-drop failure.

### 5.4 Status parse (`INQUIRY_STA` response, BT frame)

Requires len ≥ 20, magic at [0][1], resp[7]==0x11. Register bytes at **14,15,16,17**,
print_count LE u16 at **18-19**.

| Field | Byte | Mask | Field | Byte | Mask |
|---|---|---|---|---|---|
| buf_full | 14 | 0x01 | device_busy | 15 | 0x04 |
| label_rw_error | 14 | 0x02 | head_temp_high | 15 | 0x08 |
| label_end | 14 | 0x04 | cover_open | 16 | 0x08 |
| label_mode_error | 14 | 0x08 | insert_usb | 16 | 0x10 |
| ribbon_rw_error | 14 | 0x10 | printing | 16 | 0x40 |
| ribbon_end | 14 | 0x20 | label_not_installed | 17 | 0x01 |
| low_battery | 14 | 0x40 | | | |

`has_error()` = any of {label_rw_error, label_end, label_mode_error, ribbon_rw_error,
ribbon_end, cover_open, head_temp_high, label_not_installed}. (buf_full, device_busy,
printing, insert_usb, low_battery are NOT errors.) Response validation is header-only
(len≥8, [0]=0x7E, [1]=0x5A, [7]=expected cmd); checksum is **not** re-checked on
responses.

### 5.5 Material query (for geometry, §7)

`RETURN_MAT (0x30)` → BT frame, payload at [22..]: [18]=width_mm, [19]=height_mm,
[20]=gap_mm, [17]=label_type, [21..25]=remaining LE u32. This is how we read the
E11's real label width to derive the true printhead geometry. Device serial comes
from the BlueZ/BT `Name`, not this payload.

---

## 6. The raster pipeline (byte-exact, transport-independent)

Order (a TS reimpl must reproduce exactly; all device-width-independent except the
canvas width in step 3):

1. **Dither** 8bpp gray → 1bpp **MSB-first**, horizontally mirrored. **Ordered Bayer
   4×4**, NOT Floyd–Steinberg. Per pixel set bit iff `SRGB_TO_LINEAR[gray] <
   BAYER4[y&3][mx&3]` where `mx = width-1-x`. Input 0=black/255=white; set bit = black
   dot. The 256-entry `SRGB_TO_LINEAR` LUT and the Bayer matrix must be **copied
   verbatim** (both are in the raster-compress research report; anchors LUT[0]=0,
   LUT[1]=50, LUT[128]=188, LUT[255]=255).
2. **Repack** row-major MSB-first → column-major **LSB-first**: `out[y][x] = in[y][x]`
   with bit order flipped MSB→LSB. **Despite the reference docstring this is NOT a
   rotation.** Net: printed cross-head width = input image **width**; feed-direction
   length = input image **height**.
3. **Center** the width-dot image inside the fixed **printhead-width-dots** canvas
   (LSB-first). `x_offset = (canvas_dots - input_dots)/2`. ← **canvas width is the E11
   unknown (§7).**
4. **Split** into 4096-byte print buffers, 14-byte header each. `max_cols =
   4074/bytes_per_line`. Header layout: [0..2] checksum LE, [2..4] PAGE_REG_BITS,
   [4..6] cols LE, [6] bytes/line, [8..10] margin_top LE (clamp 1..900), [10..12]
   margin_bottom LE, [12] density (≤15), [14..] image. First buffer `page_st`; last
   buffer `page_end`+`prt_end`. Margins written into **every** header. Per-buffer
   checksum = `sum(buf[2..14]) + Σ buf[i*256-1]`.
5. **Compress** — **concatenate ALL 4096-byte buffers → ONE LZMA1-"alone" stream**
   (legacy `.lzma`, 13-byte header). Params: `dict_size=8192 (8 KiB)`, `lc=3, lp=0,
   pb=2, nice_len=128`, seeded from preset 6. Props byte = 0x5D; dict bytes
   `00 20 00 00`; **patch bytes [5..13] with the real uncompressed size (u64 LE)**.
   The 8 KiB dict is a **firmware RAM constraint — do not "upgrade" to preset 9.**
6. **Frame** the compressed stream: 500-byte payloads → 506-byte data packets
   (`[0]=0xAA [1]=0xBB [2..4]=chk LE of [4..506] [4]=idx [5]=total [6..506]=payload`)
   → 512-byte transfer frames (`[0]=0x7E [1]=0x5A [2..4]=0x01FC [4]=0x10 [5]=0x02` +
   506). block_size=512, block_count=num_packets. **pkt_idx/total are u8 → max 255
   packets ≈ 127 KB compressed** (fine for 1-bit labels; guard anyway).

**Speed** (from avg compressed bytes/buffer, identical in Python and Rust):
`>3000→10, >2800→15, >2500→20, >2000→25, >1500→40, >1000→45, >500→55, else 60`.

**Density** = `round(darkness% × 15 / 100)`, clamped 0..15.

**npm compressor choice:** `lzma-native` (Node binding to the *same* liblzma) with
the alone encoder + LZMA1 filter `{dictSize:8192, lc:3, lp:0, pb:2, niceLen:128}`
from preset 6, then patch the size header → **byte-identical** to the reference.
`lzma` (LZMA-JS) can't set dict=8192/lc,lp,pb so it is only decoder-compatible, not
byte-identical. **Functionally** the printer only needs a valid LZMA1-alone stream
with props 0x5D + dict 8192 + definite size, but use `lzma-native` to match the
proven output. ⚠ `lzma-native` is a native module → same packaging cost as noble
(prebuilts exist for many targets; verify Electron 32 / Win + mac). **Alternative to
evaluate:** a pure-JS LZMA1-alone encoder configured to props 0x5D / dict 8192 (no
native build) — must be validated to produce a printer-decodable stream.

---

## 7. E11 hardware geometry (⚠ the second-biggest unknown)

The reference registry maps `e11 → supvan_t50` = **384 dots / 48 mm / 203 dpi**. This
is inherited, not measured, and is **implausible** for the E11:

- E11 media (the user's rolls) = **12 mm** and **15 mm** tape. At 8 dots/mm that's
  ~**96 dots (12 mm)** / ~**120 dots (15 mm)** — a quarter of 384.
- Centering a 96–120-dot image inside a 384-dot canvas mis-positions/clips output.
- Closest existing family is `supvan_g` (193 dpi / 190 dots / 12–25 mm media) — still
  ~2× too wide for 12/15 mm.

**Resolve before trusting any width:**
1. `RETURN_MAT (0x30)` on the loaded roll → read `width_mm` (§5.5), then
   `printhead_dots = round(width_mm × dots_per_mm)`.
2. Confirm `dots_per_mm`: the T50 family is 8 dots/mm (203 dpi). ⚠ vendor SP/TP/G
   query DPI live and land ~11.6–11.8 dots/mm — **do not assume**; if the E11 is a
   DPI-query variant, 203 is wrong. A `RETURN_MAT` width + a known-width test print is
   the cheapest cross-check.
3. Add a dedicated `supvan_e` geometry entry (`printhead_dots ≈ 96 or 120`) rather
   than reusing `supvan_t50`.

**Design consequence:** make `printheadDots` and `dotsPerMm` **config-driven**, not
hard-coded 384. The two roll types the user has:
- **15 mm × 6 m continuous** → feed length is free; label height = content height.
- **12 mm × 40 mm die-cut** → fixed 40 mm cell; content must fit ~12 mm × 40 mm.
The reference print path does **not** differentiate die-cut vs continuous (constant
feed-axis margins, no gap/label_type branch). We likely need a small gap/height
handling difference for the 12×40 die-cut roll — **⚠ verify on hardware** how the E11
advances die-cut labels (it may auto-sense the gap).

---

## 8. Label content & 1-bit rendering (renderer)

**No pre-rendered label exists in the EZOffice/inventory API** — we render it
client-side. Available fields on `ConsolidatedDevice`: `assetId`, `name`/
`displayName`, `serialNumber`, `category`, `ezStatus`, `assignedUserEmail`,
`department`.

**Label composition (proposal):**
- **QR** = the resolved EZOffice asset URL: reuse the already-computed
  `ezofficeUrl = applyUrlTemplate(urlTemplates.ezoffice, {name, serial, id:assetId})`.
  Fall back to `assetId` if the template can't be filled (`applyUrlTemplate` returns
  null on a missing placeholder).
- **Human-readable block:** asset id (mono), device name, serial. Optional
  category/assignee.
- **Barcode (Code128)** via `bwip-js` kept as a documented fallback only.

**Rendering path (no native deps):** offscreen DOM `<canvas>` in the renderer →
draw QR (from `qrcode`) + text with `CanvasRenderingContext2D` → `getImageData()` →
threshold each pixel to 1-bit → pack to `bytesPerRow = ceil(widthPx/8)`. `qrcode`'s
`QRCode.create(text).modules` gives a 0/1 BitMatrix you can rasterize directly at the
target module scale (inherently monochrome, no thresholding needed for the QR itself).

**IPC payload (structured-clone safe):**
```ts
print:label  →  { widthPx, heightPx, bytesPerRow, bitmap: <base64 packed 1bpp>,
                  meta: { assetId, serial, media, darkness } }
```
Base64 (or a transferable ArrayBuffer) matches how the codebase already ships binary
over IPC (safeStorage blobs). The raster pipeline (§6) + transport (§4) consume this
in **main** — unless Web Bluetooth is chosen, in which case the renderer keeps it and
drives the printer directly.

**Target raster width** must match the resolved printhead dots (§7): render the label
at `printheadDots` wide (or narrower + centered) so step-3 centering is a no-op or a
clean margin.

---

## 9. admanager integration (files, IPC, config, UI)

### 9.1 UI action — `src/renderer/src/pages/DeviceRow.tsx`
- Add `Printer` to the lucide import (line ~2–5; currently only imported in
  `devices.ts`).
- Detail-modal footer icon cluster (**~346–357**): add
  `<IconAction icon={<Printer/>} label="Imprimir etiqueta" onClick={…} />`
  (`IconAction` helper at ~430–442).
- Right-click menu (`DeviceMenuItem` list ~236–255; helper ~417–427): add after the
  copy group.
- Reuse the `copy()` pattern (~135–139): async, local `busy`, call the print API,
  `toast?.success/error`. Data already in scope: `device`, `name`, `ezofficeUrl`
  (~131), `linkVars` (~130), `toast`, `ensureFreshAuth` (~101).

### 9.2 Parent wiring — `src/renderer/src/pages/DeviceListPage.tsx`
- `DeviceRow` rendered ~497–503; `urlTemplates` seeded from `getDeviceConfig()`
  ~116–120. Thread a new `printConfig` prop (media, darkness) the same way, reading
  the new DeviceConfig fields.

### 9.3 IPC — `src/main/main.ts` (+ `preload.ts`)
- **Never call `ipcMain.handle` directly** — use the local `handle(channel, fn)`
  wrapper (~909–940) that logs + inspects `{ok:false}`. Return the `PSResult` shape
  `{ ok, data?, error? }` (`shared/types.ts:14-18`), Portuguese error strings,
  modeled on `app:open-external` (~1400–1409).
- New channels: `print:list-devices` (BLE/serial scan), `print:label`, optional
  `print:test`. Register near biometric (~1311–1350) / open-external (~1400).
- Preload: add a `printAPI` namespace (`contextBridge.exposeInMainWorld`) mirroring
  `configAPI`/`appAPI` (preload.ts ~3–14, 36–44).
- Renderer typing: add `printAPI?: {…}` to the `declare global` block in
  `lib/groupsConfig.ts` (~36) or a new `lib/print.ts`. Degrade gracefully in browser
  preview: `window.printAPI?.printLabel(…) ?? {ok:false,error:"unavailable"}` (the
  `updates.ts:44-46` pattern; `isBrowserMock` at `adAPI.ts:391`).
- **Do NOT reflexively guard with `adWriteUnavailable()` / `AD_VIA_API`** — BLE/serial
  printing is cross-platform, unlike AD writes.

### 9.4 DeviceConfig additions — 5 sites must ALL change
Fleet-shareable fields (media, darkness) go through the existing DeviceConfig sync:
1. `shared/types.ts:202-221` — `interface DeviceConfig`.
2. `lib/deviceConfig.ts:26-36` — `EMPTY_DEVICE_CONFIG`.
3. `lib/deviceConfig.ts:40-68` — renderer `normalize()` coercion.
4. `main.ts:257-270` — `normalizeDeviceConfig()` (main-side).
5. `main.ts:2100-2110` — the `next` merge in `config:set-device-config`.
(+ `demoDeviceConfig()` ~283 for MOCK_PS.)

> **⚠ GOTCHA — the saved printer id must be machine-local.** `config:set-device-config`
> fire-and-forward pushes the whole object to the fleet pyexp `/api/v1/settings`
> (~2114–2116, `remoteDirty.deviceConfig=true`). DeviceConfig is **fleet-wide** — media
> size + darkness are fine to share, but a **saved BLE/COM printer id is per-machine**;
> pushing it would give every operator one machine's printer. Store the printer id in a
> **separate local-only store** (or `localStorage` keyed per machine), NOT in the
> fleet-pushed DeviceConfig. This interacts with the fleet-settings concurrency code
> just fixed — keep the local printer id entirely out of `remoteSettings`.

### 9.5 Settings UI — `src/renderer/src/pages/SettingsPage.tsx`
- Device-config editor state `config`/`setConfig` (~616), hydrate via
  `getDeviceConfig()` (~621), `persist(next)` → `setDeviceConfig` (~644–646).
- Copy a field-row block (~765–815, e.g. ScreenConnect/SMLPlayer) for media size +
  darkness (save on `onBlur`). If a printer picker is needed, reuse the
  `AVAILABLE_PRINTERS` chip-toggle pattern (~726–737).

### 9.6 Flavor / permissions / offline
- **Manager only** — `DevicesPage.tsx:32` returns the PC-onboarding wizard for
  `IS_AGENT`, so `DeviceRow` (and the print action) never render in Agent. No new
  update-feed split needed (shared codebase, only Manager reaches the UI).
- Printing is **read-only w.r.t. AD** → does not need the admin-password reconfirm
  used by offboard. If kiosk-gating is wanted, `ensureFreshAuth` is already passed
  into `DeviceRow` — call it before printing like `doToggle` does; otherwise leave
  ungated (matches copy/open-link).
- **Offline:** DeviceConfig is readable offline (boot cache); BLE/serial is inherently
  local — no network needed to print.

---

## 10. Dependencies to add (none exist today)

| Package | Purpose | Native? | Packaging note |
|---|---|---|---|
| `qrcode` | QR → BitMatrix / canvas | no | trivial |
| `lzma-native` **or** pure-JS LZMA1-alone | compress raster | native (or none) | ⚠ verify Electron-32 prebuilts (Win+mac) if native; prefer pure-JS if it produces a printer-decodable stream |
| `serialport` | RFCOMM transport (if Classic) | native, **prebuilts ship** | `asarUnpack` its `.node`; light |
| `@abandonware/noble` | BLE transport (fallback only) | native, **no prebuilts** | heavy — full toolchain + `@electron/rebuild` + `asarUnpack **/*.node` |
| `bwip-js` | Code128 fallback (optional) | no | only if barcode needed |

**Web Bluetooth (primary BLE path) adds zero dependencies** — it's the Chromium
platform API. That is the single strongest reason to prefer it if the spike confirms
BLE.

Constraints to honor: builds are **UNSIGNED** with the electron-updater
`verifyUpdateCodeSignature` monkeypatch; the portable unpack dir is pinned to
`%TEMP%\ADManager` for the Defender ASR exclusion — any shipped `.node`/native DLL
lands there and is one more thing Defender/ASR may flag. Every added native module
must build in the Windows-only CI **and** on the macOS dev box.

---

## 11. Phased roadmap

**Phase 0 — Hardware spike (§3).** Determine transport + capture GATT UUIDs/MTU +
`RETURN_MAT` width. **Blocks only the transport slice.** ~30 min on real hardware.

**Phase 1 — Transport-agnostic core (`src/main/supvan/`). ✅ DONE (2026-08-19).**
Built + unit-tested against the reference, **no hardware needed**. Modules:
`constants.ts`, `frame.ts`, `data.ts`, `raster.ts` (dither LUT/Bayer verbatim,
column-major pack, center, page/print buffers), `compress.ts` (LZMA1-alone header
+ size patch; entropy coder is an injected seam — see below), `speed.ts`,
`status.ts` (bit + material parse), `job.ts`, `pipeline.ts` (NORMAL-mode state
machine, last-only ack timing), `transport/pipe.ts` (`SppPipe` interface).

Tests (`test/supvan/`, run `npm run test:supvan`, Node ≥24 type-stripping, zero
deps): 33 passing. `golden.test.ts` diffs framing/data/page+print buffers/
calc_speed/parse_status/parse_material/test-patterns/LZMA-patch/end-to-end job
BYTE-FOR-BYTE against `golden-vectors.json` (generated from `test_print.py` via
`gen_golden.py`); dither/raster/center/firmware-frame checks are transcribed Rust
`#[test]` anchors; `pipeline.test.ts` drives the state machine against a mock pipe.

Verified by a 16-agent adversarial workflow (skeptic per module → independent
referee). Fixed 3 confirmed divergences: (1) **HIGH** — wait-printing aborted on a
transient null status; both refs tolerate it (decoupled `bailOnNull` from
`sleepFirst` in `pollStatus`); (2/3) `dataPacketCount`/`buildDataFrames`/
`buildFirmwareFrames` emitted a spurious frame for empty input (`Math.max(1,…)` →
`ceil`, matching Rust `div_ceil`). Two other candidates were refuted (they match
Python). Two known, intentional gaps remain for later phases:
- **LZMA entropy coder is NOT bundled** — `compressAlone`/`buildJobFromColumnMajor`
  require an injected `LzmaAloneEncoder`, so a *real* print needs a Phase-2 backend
  choice (native/WASM/pure-JS). The coder need not be byte-identical to Python's
  `lzma` (LZMA output isn't canonical; firmware decodes, doesn't byte-compare) —
  only a valid alone stream with the vendor params, which `compressAlone` validates.
- **E11 printhead geometry** is still the §7 unknown (config-driven `Geometry`).

**Phase 2 — Label rendering (renderer).** `qrcode` + canvas → 1bpp packer; an
in-app preview of the rendered label (dogfood before printing). Width driven by the
resolved printhead dots.

**Phase 3 — Transport slice** (per Phase-0 result): Web Bluetooth bridge (renderer +
main picker) **or** `serialport` pipe (main). Implement discovery
(name `^[TGD]\d{2}`, OUI `A4:93:40`), connect, the write-with-response (commands) /
write-without-response (bulk) split, and the 4 s offset-7 echo wait.

**Phase 4 — Wire it up:** `print:*` IPC + preload + `printAPI` typing; `DeviceRow`
action; DeviceConfig fields (5 sites) + machine-local printer id; SettingsPage editor.

**Phase 5 — Hardware validation:** first real print. Confirm geometry (§7), ack
timing (R2), no RFID gate (R7), die-cut vs continuous feed (§7). Tune density/speed.

**Phase 6 — Polish:** error surfacing from status bits (label_end, cover_open,
low_battery → Portuguese toasts), retry/timeout UX, kiosk gating decision, copies.

Typecheck after each phase: `npm run typecheck` (both tsconfigs). No eslint config
exists.

---

## 12. Risk register

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | **Transport unknown** (BLE vs RFCOMM) | High | Phase-0 spike before any transport code; core is transport-agnostic so the rest proceeds |
| R2 | **Data-packet ack timing** — Python (last-only) vs Rust (all-but-last) disagree | High | Follow the *working* Python: read only after the last packet; confirm on hardware (wrong = 3-beep/drop) |
| R3 | **Printhead width** — 384 dots almost certainly wrong for 12/15 mm | High | `RETURN_MAT` width read; config-driven `printheadDots`/`dotsPerMm`; add `supvan_e` geometry |
| R4 | **BLE GATT UUIDs/MTU unverified** (reversed from Android, never tested) | High | Capture real UUIDs in Phase-0 (nRF Connect / bluetooth-internals); autodetect the 3 patterns but trust the captured one |
| R5 | **LZMA byte-identity** — non-`lzma-native` encoders differ | Med | Use `lzma-native` w/ exact params; or validate a pure-JS alone encoder round-trips on hardware; keep dict=8192 |
| R6 | **`NEXT_ZIPPEDBULK` param encoding** — SPP `(512,num_packets)` vs vendor-HID `(len)` | Med | If E11 is the HID-style firmware over BLE, the `(512,n)` header may be wrong — verify with a 1-block print |
| R7 | **RFID/consumable auth** — vendor T50 sends `SET_RFID_DATA 0x5D` + 78-byte block first | Med | Try without it first (Python/Rust never send it); if E11 refuses, decode the 78-byte RfidData block |
| R8 | **DPI variant** — if E11 queries DPI live (~11.8 dots/mm) not fixed 203 | Med | Cross-check with a known-width test print; make dots/mm config-driven |
| R9 | **Native module in unsigned CI** (`lzma-native`/`serialport`/noble) | Med | Prefer zero-native paths (Web BT + pure-JS LZMA); else verify prebuilts + `asarUnpack` + `%TEMP%\ADManager` ASR interplay |
| R10 | **Die-cut 12×40 feed** — reference path ignores gap/label_type | Low | Verify E11 auto-senses die-cut gap; add height/gap handling only if needed |
| R11 | **Web BT throughput** — Chromium flow-control on write-without-response | Low | Serialize GATT ops; chunk ≤180–200 B; measure; fall back to noble only if too slow |

---

## 13. Open decisions for you (no action needed yet — planning only)

1. **Label content:** QR of the EZOffice asset URL + `assetId`/name/serial — is that
   the label you want, or do you have an existing EZOffice label layout to match
   (fields, order, logo)?
2. **Two roll types:** should the media (15 mm continuous vs 12 mm×40 mm die-cut) be a
   per-print choice, a per-department default, or a single fleet default?
3. **Kiosk gating:** require `ensureFreshAuth` before printing, or leave ungated like
   the copy/open-link actions?
4. **Transport preference** if the spike shows the E11 supports **both** BLE and
   RFCOMM: I'd default to **Web Bluetooth** (zero native deps, cleanest fit for the
   unsigned two-flavor build) — agree?

---

## 14. Source map (reference repo `github.com/heeen/supvan-cups`)

- `crates/supvan-proto/src/cmd.rs` — 16-byte frame + checksum + opcodes.
- `.../status.rs` — status bit parse + material/name/version parsers.
- `.../bitmap.rs`, `.../buffer.rs` — dither-output packing, column-major, 4096-buffer.
- `crates/supvan-app/src/dither.rs` — Bayer 4×4 + SRGB_TO_LINEAR LUT (copy verbatim).
- `.../compress.rs` — LZMA1-alone params (dict 8192, props 0x5D).
- `.../data.rs` — 506/512 transfer framing.
- `.../ble.rs` — BLE GATT pipe (⚠ unverified against hardware).
- `.../spp_pipe.rs`, `.../rfcomm.rs` — SPP codec + Classic BT pipe.
- `crates/supvan-app/src/job.rs::transfer_page` — the real print ordering.
- `crates/supvan-app/src/ble_discover.rs` — LE scan filter (name `^[TGD]\d{2}`, OUI
  `A4:93:40`, GATT-service discriminator).
- `data/models.toml` — family/geometry registry (E11 → supvan_t50, ⚠ likely wrong).
- `test_print.py` — the **known-good** RFCOMM Python client (ground truth for timing).
- `key-functions.js` — decompiled vendor Electron editor (USB-HID; ground truth for
  the command vocabulary + RFID flow).
- `docs/PROTOCOL.md` — transports overview + BLE GATT appendix.
```
