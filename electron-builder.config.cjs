// electron-builder config — flavor-aware, selected by the APP_FLAVOR env var
// (manager | agent). ONE codebase produces TWO distinct installers:
//
//   • Manager (pt.bauermedia.admanager) — the full admin app.
//   • Agent   (pt.bauermedia.adagent)   — the per-PC onboarding app.
//
// They intentionally differ in appId, productName, shortcut, output dir, and —
// critically — their GitHub auto-update FEED. Each installer bakes its own feed
// (electron-updater reads it from the packaged app-update.yml), so tagging a
// release in one repo NEVER cross-updates the other's fleet. A cross-update would
// silently replace Managers with Agents (or vice-versa) on real admin machines.
//
// Build one flavor at a time:
//   APP_FLAVOR=manager electron-builder --config electron-builder.config.cjs
//   APP_FLAVOR=agent   electron-builder --config electron-builder.config.cjs
// (the npm `build:manager` / `build:agent` scripts wire this up with cross-env).
const flavor = process.env.APP_FLAVOR === "agent" ? "agent" : "manager";

const brand = {
  manager: {
    appId: "pt.bauermedia.admanager",
    productName: "AD Manager",
    output: "release/manager",
    repo: "manager-activedirectory",
  },
  agent: {
    appId: "pt.bauermedia.adagent",
    productName: "AD Agent",
    // Separate output dir so building one flavor can't clobber the other's
    // artifacts / latest.yml when built back to back.
    output: "release/agent",
    // Separate update repo — the fleet-safety guarantee above lives here.
    repo: "agent-activedirectory",
  },
}[flavor];

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: brand.appId,
  productName: brand.productName,
  copyright: "Copyright © 2025 Bauer Media Audio Portugal",
  asar: true,
  directories: {
    buildResources: "build",
    output: brand.output,
  },
  files: ["dist/**/*", "dist-electron/**/*"],
  extraResources: [
    {
      from: "src/main/ps-scripts",
      to: "ps-scripts",
      filter: ["**/*"],
    },
  ],
  publish: [
    {
      provider: "github",
      owner: "bauer-digital-pt",
      repo: brand.repo,
      releaseType: "release",
    },
  ],
  mac: {
    icon: "build/icon.icns",
    category: "public.app-category.business",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    target: [{ target: "dmg", arch: ["x64", "arm64"] }],
  },
  dmg: {
    title: brand.productName,
    background: null,
    window: { width: 540, height: 380 },
  },
  win: {
    icon: "build/icon.ico",
    target: [{ target: "nsis", arch: ["x64"] }],
    requestedExecutionLevel: "requireAdministrator",
    publisherName: "Bauer Media Audio Portugal",
    legalTrademarks: "Bauer Media Audio Portugal",
    signingHashAlgorithms: ["sha256"],
    signAndEditExecutable: true,
  },
  portable: {
    // Distinct filename so the release step can attach ONLY this file (never the
    // nsis installer or latest.yml). Produced solely by an explicit
    // `--win portable` build (see the build:portable npm script); the default
    // published build stays nsis-only, so the auto-update feed is untouched.
    artifactName: "${productName}-Portable-${version}.${ext}",
    // A portable build ignores win.requestedExecutionLevel and needs its own, so
    // match the installed app (requireAdministrator) and behave identically.
    requestExecutionLevel: "admin",
    // Fixed unpack dir so the app ALWAYS self-extracts to %TEMP%\ADManager
    // instead of a per-build UUID folder (electron-builder's default, which
    // changes on every release). This makes it a stable target that a single
    // Defender ASR path exclusion can cover on managed PCs:
    //   %LOCALAPPDATA%\Temp\ADManager\*  (a.k.a. C:\Users\*\AppData\Local\Temp\ADManager\*)
    // The ASR rule "Block executable files from running unless they meet a
    // prevalence, age, or trusted list criterion" blocks this unsigned, freshly
    // built exe running from temp; a stable path is what makes the exclusion
    // (or a code-signing cert, the real fix) practical instead of per-version.
    unpackDirName: "ADManager",
  },
  nsis: {
    oneClick: false,
    perMachine: true,
    allowToChangeInstallationDirectory: false,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
    menuCategory: false,
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico",
    installerHeaderIcon: "build/icon.ico",
    installerHeader: "build/installerHeader.bmp",
    installerSidebar: "build/installerSidebar.bmp",
    uninstallerSidebar: "build/installerSidebar.bmp",
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: brand.productName,
  },
};
