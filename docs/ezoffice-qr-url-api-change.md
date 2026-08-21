# EZOffice QR parity — inventory-API change (`qr_url`)

> Status: **DONE end-to-end.** API side shipped & DEPLOYED to production
> (pyexp-inventory `324f502`, auto-deployed to pt-srv-pyexp 2026-08-21 — `/api/v1/assets`
> now returns `qr_url`). admanager consumes it; the login-gated stopgap default was
> **removed** (§5) now that the real coded URL is available.
> Goal: the printed SUPVAN E11 label QR must be byte-for-byte the SAME URL EZOffice
> prints on its own asset labels, so a scan opens the asset's public mobile view.

---

## 1. Ground truth (decoded from real EZOffice labels)

Real EZOffice asset-label QRs encode:

```
https://bmap.ezofficeinventory.com/a/<sequence_num>?c=<check_code>
```

Examples decoded from **six** consecutive QRs on a real exported EZOffice label PDF
(`~/Downloads/17872565816993673.pdf`, decoded 2026-08-21 with a Swift/CoreImage
`CIDetectorTypeQRCode` one-shot — no poppler/zbar needed on macOS):

| sequence | `c` code |
| -------- | -------- |
| 611      | `616e`   |
| 612      | `38ab`   |
| 613      | `713c`   |
| 614      | `1dac`   |
| 615      | `af8f`   |
| 616      | `73c0`   |

These are the ground truth for the live-call check in §3a (seq 611 → `?c=616e` is
exact). Six consecutive sequences show **no derivable pattern** in `c` — do not try
to crack it; the API is the only source.

- `bmap.` = the Bauer Media Audio Portugal EZOffice subdomain.
- `/a/<sequence_num>` = the public label shortlink. `sequence_num` **is** our
  `InventoryAsset.asset_id` (confirmed: fixtures use "1", "2", "10"; live QRs use
  611/612/615 — same field).
- `?c=<check_code>` = a **per-asset server-side check code** (4 hex chars ≈ 16 bits).

### The `c` code is REQUIRED and NOT client-derivable

- **Required:** `https://bmap.ezofficeinventory.com/a/611` (no `c`) → redirects to
  **Sign In**. `…/a/611?c=616e` → renders the public "Asset Mobile View" (asset name,
  owner org, "sign in to take action") with **no login**. So without `c` the label
  is useless to a scanner.
- **Not derivable:** tested 39 non-secret hash schemes (md5 / sha1 / sha256 / crc32,
  with prefixes `""`, `a/`, `/a/`, `asset`, `assets/`, both head/tail 4 hex) against
  the three known (seq → code) pairs. **None** reproduce the code. It is almost
  certainly a truncated HMAC keyed by an EZOffice account secret → only the server
  (or EZOffice's API) can produce it. Do **not** attempt to compute `c` client-side.

Therefore the only correct source of the QR URL is the inventory API, which already
talks to EZOffice.

---

## 2. What admanager already does (this repo — shipped in code, not yet released)

The renderer consumes an **optional** `qr_url` end-to-end and degrades gracefully:

- `src/shared/types.ts` — `InventoryAsset.qr_url?: string` (the exact public label
  URL incl. `?c=`).
- `src/renderer/src/lib/devices.ts` — `ConsolidatedDevice.qrUrl?`, mapped in
  `consolidate()` for both matched ("both") and asset-only ("ezoffice") rows.
- `src/renderer/src/pages/DeviceRow.tsx` — label QR payload is
  `device.qrUrl || ezofficeUrl || ""` (API URL first, then the Settings URL
  template, then empty).
- `src/renderer/src/lib/printing.ts` — `buildLabelModel` QR is `qrPayload ||
  device.qrUrl || ""`. It **no longer falls back to the device name** (the bug the
  user reported) or to a bare asset id; the asset number is already printed as an
  "EZ …" text line, and a hostname-only QR looks scannable but opens nothing.
- `src/shared/fixtures.ts` — `mockAssets()` now emits a realistic `qr_url`
  (`…/a/<id>?c=<deterministic-fake>`), so the browser preview shows a v4 URL QR.

Verified in the dev preview: with `qr_url` present the label QR decodes to
`https://bmap.ezofficeinventory.com/a/<id>?c=<code>`; with it absent the label now
degrades to a **QR-less** logo+text label (never the device name, never a broken
link). So the API can ship `qr_url` whenever ready with **no admanager release
coupling** — old responses (no `qr_url`) keep working.

**Encoder proven correct (2026-08-21):** feeding the real seq-611 URL (47 chars)
through admanager's `encodeQr`→`renderLabel` produces a QR **v4, 33×33 modules,
mask 3**, and `jsQR` round-trips it byte-for-byte — structurally identical to
EZOffice's own v4 label QRs. On the 12 mm E11 head the fit picks `qrScale=2`
(0.25 mm/module); it fits but is borderline for phone cameras — EZOffice's own
labels scan because they print larger. The remaining gap is purely *which URL* we
encode (needs the `?c=` code), not *how* we encode it.

---

## 3. What the inventory API (pyexp-inventory) must add

Expose `qr_url` on every asset returned by `GET /api/v1/assets` (and any
single-asset endpoint), containing the **full** EZOffice public label URL including
the `?c=` check code — verbatim, not reconstructed.

Concretely, in the pyexp-inventory repo:

1. **`models.py` → `EZAsset`**: add `qr_url: str | None` (Optional; snake_case to
   match the existing serialization). Keep it optional so partial/legacy rows don't
   break.
2. **EZOffice client / asset mapping**: populate `qr_url` from EZOffice. See §3a for
   the CONFIRMED source mechanism and the two implementation paths. The `c` code
   must come from EZOffice; **do not** synthesize it.
3. **Auth unchanged**: reads stay credential-passthrough (bind-as-caller, no service
   account) — same as every other `/api/v1/*` read.

## 3a. Source mechanism — CONFIRMED (EZOffice API v2 + maintained client)

The coded public URL is **not** a field on the standard asset payload
(`GET /api/v2/assets/{id}` and legacy `GET /assets/{id}.api` carry `sequence_num`/
`identifier` and attachment URLs only — no `public_url`/`qr_code`/`label_url`). It is
retrievable as a **plain JSON string** from a dedicated per-asset sub-resource:

```
GET https://bmap.ezofficeinventory.com/api/v2/assets/<INTERNAL_ASSET_ID>/get_public_links
  auth: Authorization: Bearer <EZO_TOKEN>        # the EZO API token pyexp already uses
  → { "id": <int>, "link": "https://bmap.ezofficeinventory.com/a/<seq>?c=<4hex>" }
```

The official v2 doc sample response is literally `"link": "http://7vals.lvh.me/a/7?c=77a4"`
— exactly the `/a/<seq>?c=<code>` form we decode off real BMAP labels. The maintained
Python client (`pepsimidamerica/ezoff`) reads it as `response.json()["link"]`.

> ⚠ **`<INTERNAL_ASSET_ID>` is the EZO internal `asset.id`, NOT the `sequence_num`.**
> The sequence is what appears *inside* the returned `/a/<seq>` URL. Passing the
> sequence (e.g. 611) as the path id will 404 or hit the wrong asset. Resolve the
> internal id from the asset listing first.

**Do NOT use `POST /qrcodes.api` (or `/qrcode/*`) for this** — those return a rendered
**label PDF binary**, not the URL string. `qrcodes.api` was a red herring; the coded
URL would only be recoverable from it by decoding the QR image out of the PDF.

Legacy v1 alternative (batch): `GET /assets/get_public_links.api?asset_seq=<comma-list>&page=<n>`
(header `token:<COMPANY_TOKEN>`, 25 links/page). Accepts many `Asset#` at once — a
batch win — but the v1 docs publish no sample body, so **confirm its exact JSON keys
against a live call** before relying on them. The v2 shape (`{"id","link"}`) is documented.

### Implementation for pyexp-inventory (`get_public_links`, single JSON GET)

1. After mirroring each asset, call `GET /api/v2/assets/<asset.id>/get_public_links`
   and store `response.json()["link"]` **verbatim** into `EZAsset.qr_url`. Never
   synthesize `?c=`.
2. **Cache** the value (the `c` is stable per asset) and batch/parallelize the extra
   per-asset call during sync — one call per asset, not per request.
3. **Missing is normal:** the endpoint 404s / returns no `link` when an asset has no
   public link (public pages disabled). Map that to `qr_url = null` — **never** a
   code-less `/a/<seq>`. admanager then falls back to the Settings deep-link template.
   (This is why `qr_url` optionality is load-bearing, not just defensive.)

### Ready-to-apply patch (pyexp-inventory — adapt names to the repo)

pyexp-inventory is a **separate repo** (not vendored here), so this is a drop-in
template, not a literal diff. Wire it into the existing per-asset sync/mirror step.

```python
# models.py — add to the EZAsset schema (snake_case, Optional so legacy rows survive)
class EZAsset(BaseModel):
    ...
    qr_url: str | None = None   # full EZOffice public label URL incl. ?c= (verbatim)

# ezoffice.py — one JSON GET per asset, on the EZO token ezoffice.py already holds.
# The path id is the EZO INTERNAL asset.id, NOT the sequence_num (else 404 / wrong asset).
def fetch_public_link(self, internal_asset_id: int) -> str | None:
    """Return the coded public label URL for an asset, or None when it has no
    public link (public pages disabled). Never synthesize the ?c= code."""
    resp = self._session.get(
        f"{self.base_url}/api/v2/assets/{internal_asset_id}/get_public_links",
        headers={"Authorization": f"Bearer {self._token}"},   # same tenant EZO token
        timeout=self.timeout,
    )
    if resp.status_code == 404:      # public links disabled for this asset
        return None
    resp.raise_for_status()
    link = (resp.json() or {}).get("link")
    return link or None              # map "" / missing to None (→ qr_url omitted)

# asset mapping — populate during the mirror/sync, cached (c is stable per asset):
asset.qr_url = self.fetch_public_link(ezoffice_internal_id)
```

Notes:
- **Cache + batch:** `c` is stable per asset, so cache `qr_url` on the mirrored row
  and populate it during sync (one extra call per asset), not per admanager request.
  If call volume matters, the legacy batch endpoint
  `GET /assets/get_public_links.api?asset_seq=<comma-list>&page=<n>` (header
  `token:<COMPANY_TOKEN>`, 25/page) takes many `Asset#` at once — but confirm its
  JSON keys against a live call first (v1 docs publish no sample body).
- **Serializer:** ensure whatever serializes `/api/v1/assets` includes the new
  `qr_url` field (admanager reads it as `InventoryAsset.qr_url`, verbatim).

### Auth note (reconciles with the "no service account" constraint)

`get_public_links` authenticates to EZOffice with the **EZO API token** (`Bearer` on
v2, `token:` header on v1) — the *same* tenant credential `ezoffice.py` already uses
for every asset read. It is **not** a new service account: the standing
credential-passthrough / bind-as-caller rule governs the admanager↔pyexp and pyexp↔AD
boundaries; the pyexp↔EZOffice boundary has always used the EZO API token. So no new
secret and no constraint change — just one more EZO call per asset on the existing token.

### Before shipping — one live call to close residual uncertainty

No source captured a verbatim BMAP `get_public_links` body, so confirm against a known
label (seq 611 → `?c=616e`):

1. Resolve seq 611's internal id from `GET /api/v2/assets` (do **not** pass 611 as the path id).
2. `curl -H 'Authorization: Bearer <EZO_TOKEN>' '…/api/v2/assets/<internal_id>/get_public_links'`
   → assert `link` is non-null and ends `/a/611?c=616e`.
3. Diff 611→616e, 612→38ab, 615→af8f against the decoded labels; then probe an asset
   with public links disabled and confirm it yields null (→ `qr_url` omitted).

### Acceptance

- `GET /api/v1/assets` returns `qr_url` for assets that have one; scanning that URL
  on a phone (no EZOffice login) opens the asset's public "Asset Mobile View".
- Assets without a resolvable code omit `qr_url` (or send `null`) rather than a
  code-less URL — admanager then falls back to the Settings template, never a
  broken link.

---

## 4. Open question — RESOLVED (high confidence)

> Q: Does EZOffice's asset API return the coded public URL (or `c`) directly, or must
> pyexp-inventory derive it from a label/QR endpoint?

**A: Via a dedicated endpoint that returns the URL as plain JSON** — not a field on
the asset object, and not the PDF endpoint. `GET /api/v2/assets/{internal_id}/get_public_links`
returns `{"id","link"}` where `link` is the exact `…/a/<seq>?c=<code>` string (see §3a).
So `?c=` parity is a single JSON GET per asset — **no PDF, no QR decode**. Store `link`
verbatim, keep `qr_url` optional (endpoint 404s → null), pass the internal `asset.id`
(not the sequence), and confirm one live BMAP call (611 → `?c=616e`) before shipping.

Resolved by adversarially-verified research across the official EZO v2 OpenAPI spec,
the maintained `pepsimidamerica/ezoff` client, and the legacy v1 dev docs.

---

## 5. Stopgap — SHIPPED then REMOVED once the API landed

A login-gated stopgap briefly defaulted the EZOffice URL template to
`https://bmap.ezofficeinventory.com/a/{id}` so inventory-backed devices got *a* QR
before the API returned `qr_url`. It was **removed** on 2026-08-21 once §3 deployed:
a code-less `/a/<seq>` QR scans to a **Sign In** page (the user correctly called it
"invalid"), so a code-less default is worse than no QR. With the API now returning the
real `?c=` URL, the stopgap's only remaining effect would have been code-less QRs for
assets whose public link is disabled — exactly the misleading case to avoid.

Revert (this repo):
- `src/shared/constants.ts` — `DEFAULT_EZOFFICE_URL_TEMPLATE` removed.
- Both device-config normalizers (`src/main/main.ts`, `src/renderer/src/lib/deviceConfig.ts`)
  fall back to `""` again; `getDeviceConfig()`'s no-prefs path returns
  `EMPTY_DEVICE_CONFIG`. So an absent template stays empty and no code-less default is
  injected fleet-wide.
- `src/renderer/src/pages/SettingsPage.tsx` — the `…/a/{id}` string remains only as an
  input **placeholder** (an example for an admin who wants to set a deep link by hand),
  never a default value.

**Precedence now:** `qr_url` (full parity, from the API) → admin's Settings template
(if one is set, for the row's link button) → QR-less. AD-only devices (no `qr_url`,
no `{id}`) stay QR-less — never a broken link.
