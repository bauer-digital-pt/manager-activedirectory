import { useState, useEffect } from "react";
import { Toaster, toast } from "sonner";
import { AlertTriangle, Download, X } from "lucide-react";
import Sidebar from "./components/Sidebar";
import UsersPage from "./pages/Users/UsersPage";
import SettingsPage from "./pages/SettingsPage";
import ConsolePage from "./pages/ConsolePage";
import { adAPI } from "./adAPI";
import { updatesAPI, type UpdateStatus } from "./lib/updates";

export type Page = "users" | "settings" | "console";

export default function App() {
  const [page, setPage] = useState<Page>("users");
  const [moduleMissing, setModuleMissing] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus>({ state: "none" });
  const [updateDismissed, setUpdateDismissed] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "1") { e.preventDefault(); setPage("users"); }
      if (e.key === "2") { e.preventDefault(); setPage("settings"); }
      if (e.key === "3") { e.preventDefault(); setPage("console"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Check the RSAT ActiveDirectory module once on startup.
  useEffect(() => {
    adAPI.checkModule().then((res) => {
      if (res.ok && res.data && res.data.available === false) setModuleMissing(true);
    }).catch(() => { /* ignore */ });
  }, []);

  // Listen for auto-update status from the main process.
  useEffect(() => {
    const off = updatesAPI.onStatus((status) => {
      setUpdate(status);
      if (status.state === "downloaded") setUpdateDismissed(false);
    });
    return off;
  }, []);

  return (
    <div className="flex flex-col h-screen">
      {moduleMissing && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-sm">
          <AlertTriangle size={15} className="flex-shrink-0" />
          <span className="flex-1">
            O módulo <strong>ActiveDirectory (RSAT)</strong> não está instalado — as funções de AD não vão funcionar.
            Instala em Definições do Windows → Aplicações → Funcionalidades opcionais → “RSAT: Active Directory”.
          </span>
          <button onClick={() => setModuleMissing(false)} className="p-1 rounded hover:bg-amber-100 transition-colors">
            <X size={14} />
          </button>
        </div>
      )}

      {update.state === "downloaded" && !updateDismissed && (
        <div className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white text-sm">
          <Download size={15} className="flex-shrink-0" />
          <span className="flex-1">
            Atualização {update.version ? `(${update.version}) ` : ""}pronta a instalar.
          </span>
          <button
            onClick={() => updatesAPI.install()}
            className="px-3 py-1 rounded-md bg-white/15 hover:bg-white/25 font-medium transition-colors"
          >
            Reiniciar e instalar
          </button>
          <button onClick={() => setUpdateDismissed(true)} className="p-1 rounded hover:bg-white/15 transition-colors">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar active={page} onNavigate={setPage} />
        <main className="flex-1 overflow-hidden flex flex-col bg-white">
          {page === "users"    && <UsersPage    toast={toast} />}
          {page === "settings" && <SettingsPage toast={toast} />}
          {page === "console"  && <ConsolePage />}
        </main>
      </div>
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}
