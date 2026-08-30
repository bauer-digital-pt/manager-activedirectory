// Maintenance-order document (HTML).
//
// A single pure builder that turns a maintenance order into a self-contained A4
// HTML page (inline CSS, no external assets). The SAME string is used two ways:
//   • previewed live in the modal via <iframe srcDoc={html}>, and
//   • handed to the main process (pdf:save / pdf:print) which renders it to a PDF
//     or the system printer inside a hidden BrowserWindow.
// Keeping the template in the renderer lets the preview and the printed/saved PDF
// stay byte-identical; main stays a generic HTML→PDF renderer that never has to
// know what a maintenance order looks like.
import bauerLogo from "../assets/bauer-media-logo.svg?raw";

export interface MaintenanceOrderInfo {
  deviceName: string;
  serial: string;
  category: string;
  assetId: string;
  ezStatus: string;
  assignedUser: string;
  // The chosen maintenance/work-order type (may be empty — free-form titles allowed).
  workType: string;
  priority: string;
  description: string;
  // Operator who opened the order — from the live login session (getAuthStatus).
  technician: string;
  // Human date string, formatted by the caller (main has no locale context).
  dateLabel: string;
  // Work-order reference once created; empty on the pre-create preview.
  orderRef?: string;
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A dash placeholder so an empty field reads as "not filled" rather than a blank gap.
function val(s: string): string {
  const t = String(s ?? "").trim();
  return t ? esc(t) : "—";
}

// The document title shown in the header and used as the print/PDF subject.
export function maintenanceDocTitle(order: MaintenanceOrderInfo): string {
  return `Ordem de Manutencao ${order.deviceName || order.assetId || ""}`.trim();
}

export function buildMaintenanceHtml(order: MaintenanceOrderInfo): string {
  const rows = (pairs: Array<[string, string]>): string =>
    pairs
      .map(
        ([k, v]) =>
          `<tr><th>${esc(k)}</th><td>${v}</td></tr>`,
      )
      .join("");

  const deviceRows = rows([
    ["Equipamento", val(order.deviceName)],
    ["Número de série", val(order.serial)],
    ["Categoria", val(order.category)],
    ["ID do ativo", val(order.assetId)],
    ["Estado", val(order.ezStatus)],
    ["Utilizador atribuído", val(order.assignedUser)],
  ]);

  const maintRows = rows([
    ["Tipo de manutenção", val(order.workType)],
    ["Prioridade", val(order.priority)],
    ...(order.orderRef ? ([["Referência", val(order.orderRef)]] as Array<[string, string]>) : []),
  ]);

  const description = String(order.description ?? "").trim();

  return `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8" />
<title>${esc(maintenanceDocTitle(order))}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #16161d; font-size: 12px; line-height: 1.45;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .sheet { max-width: 178mm; margin: 0 auto; }
  header {
    display: flex; align-items: center; gap: 16px;
    border-bottom: 3px solid #4700a3; padding-bottom: 14px; margin-bottom: 22px;
  }
  header .logo { width: 54px; height: 54px; flex: 0 0 auto; }
  header .logo svg { width: 100%; height: 100%; display: block; }
  header .titles { flex: 1 1 auto; }
  header h1 { margin: 0; font-size: 20px; letter-spacing: .2px; color: #4700a3; }
  header .sub { margin: 2px 0 0; color: #5b5b6b; font-size: 11px; }
  header .meta { text-align: right; font-size: 11px; color: #5b5b6b; }
  header .meta strong { color: #16161d; display: block; font-size: 13px; }
  h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: .8px;
    color: #4700a3; margin: 0 0 8px; border-bottom: 1px solid #e6e2f0; padding-bottom: 4px;
  }
  section { margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: 6px 8px; font-size: 12px; }
  th {
    width: 38%; color: #5b5b6b; font-weight: 600; background: #f6f4fb;
    border: 1px solid #ece8f5;
  }
  td { border: 1px solid #ece8f5; }
  .desc {
    border: 1px solid #ece8f5; border-radius: 6px; padding: 10px 12px; min-height: 90px;
    white-space: pre-wrap; background: #fdfdff;
  }
  .desc.empty { color: #9a9aa8; font-style: italic; }
  .signatures { display: flex; gap: 32px; margin-top: 40px; }
  .signatures .box { flex: 1; }
  .signatures .line { border-top: 1px solid #16161d; margin-top: 46px; padding-top: 6px; font-size: 11px; color: #5b5b6b; }
  footer { margin-top: 26px; border-top: 1px solid #e6e2f0; padding-top: 8px; font-size: 10px; color: #9a9aa8; }
</style>
</head>
<body>
  <div class="sheet">
    <header>
      <div class="logo">${bauerLogo}</div>
      <div class="titles">
        <h1>Ordem de Manutenção</h1>
        <p class="sub">Bauer Media — Gestão de Equipamentos</p>
      </div>
      <div class="meta">
        <strong>${val(order.dateLabel)}</strong>
        Técnico: ${val(order.technician)}
      </div>
    </header>

    <section>
      <h2>Equipamento</h2>
      <table><tbody>${deviceRows}</tbody></table>
    </section>

    <section>
      <h2>Manutenção</h2>
      <table><tbody>${maintRows}</tbody></table>
      <div style="height:10px"></div>
      <div class="desc${description ? "" : " empty"}">${description ? esc(description) : "Sem descrição."}</div>
    </section>

    <section class="signatures">
      <div class="box"><div class="line">Técnico responsável</div></div>
      <div class="box"><div class="line">Data / Assinatura</div></div>
    </section>

    <footer>
      Documento gerado automaticamente pelo AD Manager — Bauer Media.
    </footer>
  </div>
</body>
</html>`;
}
