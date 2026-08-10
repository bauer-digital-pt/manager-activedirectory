import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { installRendererLogging, installConsoleBrowserMock } from "./lib/appLog";
import "./index.css";

// In the browser preview there's no preload bridge — install a mock log bus so
// the Console page works. In Electron this is a no-op (window.consoleAPI exists).
installConsoleBrowserMock();
// Forward uncaught renderer errors/rejections into the activity log.
installRendererLogging();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
