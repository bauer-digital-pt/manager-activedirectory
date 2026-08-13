import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { installRendererLogging, installConsoleBrowserMock } from "./lib/appLog";
import { FLAVOR_UI } from "./lib/flavor";
import "./index.css";

// The detached Console window (Ctrl+Shift+C) loads this same bundle with a
// "#console" hash. In that mode we render ONLY the log viewer — no app, no
// branding — so it reads as a standalone diagnostics utility. Lazy-loaded so the
// console chunk never weighs down the normal app entry.
const isConsoleView =
  typeof location !== "undefined" && location.hash.replace(/^#/, "") === "console";
const ConsoleWindow = lazy(() => import("./ConsoleWindow"));

// Reflect the mode in the tab/window title. The console view stays generic and
// unbranded; the app view uses the resolved flavor's product name (the packaged
// installer's productName already differs; this keeps the browser preview honest).
document.title = isConsoleView ? "Console" : FLAVOR_UI.productName;

// In the browser preview there's no preload bridge — install a mock log bus so
// the Console page works. In Electron this is a no-op (window.consoleAPI exists).
installConsoleBrowserMock();
// Forward uncaught renderer errors/rejections into the activity log.
installRendererLogging();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isConsoleView ? (
        <Suspense fallback={null}>
          <ConsoleWindow />
        </Suspense>
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </React.StrictMode>
);
