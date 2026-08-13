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
