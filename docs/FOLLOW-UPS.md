# Follow-ups — deferred audit items

These three items came out of the v1.0.28 deep audit but were **deliberately not
implemented** in that release because each needs an external input, a Windows
build environment, or a runtime that can't be verified from the dev/browser mock.
They are documented here so they don't get lost.

## 1. Code signing (audit #2)

**Status:** not done — needs an Authenticode certificate.

The Windows installer and the app executable are currently unsigned.
`package.json` → `build.win` already declares `signingHashAlgorithms: ["sha256"]`
and `signAndEditExecutable: true`, but there is no certificate wired into the
release workflow, so:

- SmartScreen shows the "unknown publisher" warning on first install.
- `electron-updater` delivers unsigned updates (integrity is only as strong as
  the HTTPS + GitHub Release it comes from).

**To do it:**

1. Obtain an EV or OV code-signing certificate for "Bauer Media Audio Portugal".
2. Add the cert + password as GitHub Actions secrets
   (e.g. `WIN_CSC_LINK` = base64 of the `.pfx`, `WIN_CSC_KEY_PASSWORD`).
3. Expose them to the build step in `.github/workflows/release.yml`:
   ```yaml
   env:
     CSC_LINK: ${{ secrets.WIN_CSC_LINK }}
     CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}
   ```
   electron-builder picks these up automatically — no config change needed
   beyond what's already in `build.win`.

## 2. Electron 32 → current LTS upgrade (audit #12)

**Status:** not done — can't validate a Windows build from macOS.

The app is pinned to `electron@^32.0.0`. Electron 32 is past its supported
window, so it no longer receives Chromium/V8 security patches. Upgrading is the
right move, but a blind major bump is risky here:

- The app runs packaged on Windows with `requireAdministrator` + custom NSIS
  config; a major Electron bump can change fuses, sandbox defaults, or the
  preload/context-isolation surface.
- None of that can be exercised from the macOS dev box or the browser mock — it
  needs an actual Windows packaged build + smoke test (login → create user →
  reset password → auto-update).

**To do it:** bump to the current Electron LTS, run `npm run typecheck`, then
produce a Windows build via the release workflow (or a `windows-latest` runner)
and smoke-test the full flow **before** tagging a release. Do it as its own
release, not bundled with feature work, so a regression is easy to bisect.

## 3. Content-Security-Policy meta tag (audit — deliberately skipped)

**Status:** intentionally skipped — regression risk on `file://` outweighs the
benefit given existing mitigations.

A strict CSP `<meta>` in `index.html` was considered but **not** added. In the
packaged app the renderer loads from a `file://` origin, and a strict CSP there
can silently break asset/style/script loading and produce a blank-screen
regression that **cannot be reproduced in the dev server or browser mock** (both
serve over `http://localhost`). We already mitigate the main injection vectors
without it:

- `will-navigate` is blocked for any non-dev, non-`file://` URL (`main.ts`).
- `setWindowOpenHandler` denies all `window.open` / target=_blank popups.
- Context isolation is on and the renderer has no direct Node access.

**If revisited:** add the CSP, then build the Windows installer and confirm the
packaged app still renders (not just the dev server). Start permissive
(`default-src 'self'`) and tighten, testing the packaged build at each step.
