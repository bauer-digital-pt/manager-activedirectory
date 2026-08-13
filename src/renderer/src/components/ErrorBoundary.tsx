import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import logo from "../assets/bauer-media-logo.svg";
import { FLAVOR_UI } from "../lib/flavor";

interface Props {
  children: ReactNode;
  /**
   * Compact mode is used for page-level boundaries that live *inside* the
   * layout (sidebar stays mounted). It fills the content area rather than the
   * whole screen, so a single crashing page never hides navigation/Settings.
   */
  compact?: boolean;
}

interface State {
  error: Error | null;
}

/**
 * Safety net. If any part of the tree throws during render, React unmounts
 * everything — without a boundary that leaves a dead/blank window with no way
 * back to Settings. This catches the crash and always shows a recovery screen
 * with a reload button.
 *
 * Wrapped at two levels: once around the whole <App/> (ultimate guarantee the
 * window never goes blank), and once per page (compact) so a page crash keeps
 * the sidebar — and Settings — reachable, and navigating away remounts fresh.
 *
 * The fallback is intentionally dependency-light (only the logo asset + lucide
 * icons): it must never itself throw, or React would fall through to a blank
 * screen again.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to the dev/console log so it's visible in the Console tab / devtools.
    // eslint-disable-next-line no-console
    console.error("Render crash caught by ErrorBoundary:", error, info.componentStack);
  }

  private handleReload = () => {
    // Full reload — recovers from transient/render-only failures. Deterministic
    // crashes (e.g. bad data) are prevented upstream by input guards.
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // Page-level fallback: fills the content area, sidebar stays mounted so the
    // user can navigate to another page (Settings) — which remounts a fresh
    // boundary (parent keys it by page).
    if (this.props.compact) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-white px-6 py-16 text-center">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-2xl"
            style={{
              backgroundColor: "rgba(245, 158, 11, 0.13)",
              color: "#d97706",
              boxShadow: "inset 0 0 0 1px rgba(217, 119, 6, 0.18)",
            }}
          >
            <AlertTriangle size={24} strokeWidth={2} />
          </div>
          <h2 className="mt-5 text-base font-semibold text-zinc-900">
            Esta secção encontrou um erro
          </h2>
          <p className="mx-auto mt-2 max-w-[44ch] text-sm leading-relaxed text-zinc-500">
            Podes mudar de secção na barra lateral (as Definições continuam
            acessíveis) ou recarregar a aplicação.
          </p>
          {error.message && (
            <pre className="mt-4 max-h-32 w-full max-w-[440px] overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-left font-mono text-xs leading-relaxed text-zinc-500">
              {error.message}
            </pre>
          )}
          <button
            type="button"
            onClick={this.handleReload}
            className="mt-6 inline-flex items-center justify-center gap-2 rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-800"
          >
            <RotateCcw size={15} />
            Recarregar aplicação
          </button>
        </div>
      );
    }

    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-white px-6 text-center">
        <div className="w-full max-w-[440px]">
          <div className="mb-6 flex items-center justify-center gap-2.5">
            <img src={logo} alt="Bauer Media" className="h-8 w-8" />
            <span className="text-sm font-medium tracking-wide text-zinc-400">
              {FLAVOR_UI.eyebrow}
            </span>
          </div>

          <div
            className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl"
            style={{
              backgroundColor: "rgba(245, 158, 11, 0.13)",
              color: "#d97706",
              boxShadow: "inset 0 0 0 1px rgba(217, 119, 6, 0.18)",
            }}
          >
            <AlertTriangle size={28} strokeWidth={2} />
          </div>

          <h1 className="text-2xl font-semibold leading-tight text-zinc-900">
            Ocorreu um erro inesperado
          </h1>
          <p className="mx-auto mt-3 max-w-[42ch] text-base leading-relaxed text-zinc-500">
            A aplicação encontrou um problema e não conseguiu continuar. Recarrega
            para voltar ao início — as tuas definições ficam guardadas.
          </p>

          {error.message && (
            <pre className="mt-5 max-h-40 overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-left font-mono text-xs leading-relaxed text-zinc-500">
              {error.message}
            </pre>
          )}

          <div className="mt-7 flex items-center justify-center">
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-violet-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-violet-700"
            >
              <RotateCcw size={16} />
              Recarregar aplicação
            </button>
          </div>
        </div>
      </div>
    );
  }
}
