# Mega-plano — Integrar `pyexp-inventory` no AD Manager

> Estado: **Fases 1–4 implementadas; Fase 5 (modelo de auth) implementada**. Ver §9.
> Repos envolvidos: `admanager` (esta app) + `pyexp-inventory` (=`InventorySystem`, remote `bauer-digital-pt/pyexp-inventory`).
> Servidor interno: `pt-srv-pyexp` (já corre o sync de 5 em 5 min + a stack finops).

> ⚠️ **Duas decisões deste plano foram invertidas durante a implementação** (ver §9):
> 1. **Dados ao vivo por pedido** (cache TTL curto), **não** um snapshot pré-calculado.
> 2. **Passthrough de credenciais (bind-as-user)** — **sem token partilhado e sem conta de
>    serviço**. Cada pedido leva o login AD do próprio utilizador (HTTP Basic) e a API faz
>    um bind LDAP *como esse utilizador*. As secções abaixo que ainda falam de "snapshot" ou
>    "Bearer token" descrevem o plano original; §9 tem o que foi construído.

---

## 0. TL;DR / Norte

O `pyexp-inventory` **já mantém o inventário autoritativo** de dispositivos e
membros dentro do **EZOffice Inventory** — reconciliado a partir de AD (ldap3) +
ScreenConnect (serial numbers) de 5 em 5 minutos em `pt-srv-pyexp`, com métricas
no Mimir. Hoje já lá estão ~**224 portáteis com serial** e ~**208 membros** (ver
`TODO.md` do projeto).

O AD Manager, hoje, lê **objetos-computador crus do AD via PowerShell** — só
Windows, sem serial, sem responsável, sem estado de reconciliação (orphaned/stale).

**Plano:** expor os dados já reconciliados do `pyexp-inventory` por uma **micro-API
HTTP interna** (FastAPI, containerizada em `pt-srv-pyexp` no mesmo molde do finops)
e ligar o AD Manager a essa API. Resultado:

1. Inventário muito mais rico no Manager (serial, responsável, categoria, orphaned/stale).
2. **Funciona no Mac** — os dados chegam por HTTP interno, sem RSAT/PowerShell.
3. É exatamente a "microapi interna" que discutimos, e deixa o carril montado para,
   mais tarde, encaminhar também as *leituras* de AD pela mesma API (o `ldap3` já lá
   está) e tornar o Manager inteiro cross-platform.

**Fronteira que não muda:** o **Agent** (wizard de onboarding do PC) continua
Windows-local — domain-join / renomear / instalar software atuam na máquina a ser
configurada; nenhuma API central resolve isso.

---

## 1. O que existe (verificado no código)

### `pyexp-inventory`
- **Connectors:** `active_directory.py` (ldap3, simple bind 389, paged search, UAC
  disabled/locked, `lastLogonTimestamp`→datetime, OU→departamento), `ezoffice.py`
  (API v2, rate-limit 60/min, custom fields por id, categorias=grupos),
  `screenconnect.py` (serial/model por hostname), `entra_id.py` + `jamf.py` (**stubs**).
- **Modelos** (`models.py`): `SourceUser`, `SourceDevice`, `EZUser`, `EZAsset`, `Metrics`.
- **Report** (`report.py`): `SyncReport` = `new_devices`, `new_members`,
  `orphaned_assets`, `stale_devices`, `errors`, `missing_in_ezoffice`,
  `missing_in_source`, `users_orphaned`, `updated_assets`.
- **Orquestração** (`sync/orchestrator.py`): users → devices → email → métricas Mimir.
- **CLI** (`cli.py`): `--probe` (só leitura, dá dump JSON via `--out`), `--dry-run`, `--source`.
- **Deploy atual:** cron de 5 min em `pt-srv-pyexp` (`scripts/run-sync.sh`), LIVE, idempotente.
- **Domínio:** `bmap.lis` (o mesmo do AD Manager); UPN/email `@bauermedia.pt`.
- ❗ **Não tem API HTTP** hoje — é CLI/cron.

### `admanager` (pontos de ligação)
- **Renderer→Main:** `adAPI` = `ipcRenderer.invoke("ad:…")` → `ipcMain.handle` → `runPS`.
  Wrapper tipado em `src/renderer/src/adAPI.ts`; bridge em `src/preload/preload.ts`
  (`contextBridge.exposeInMainWorld`).
- **Config/segredos:** `configAPI` (connection.json), password cifrada com `safeStorage`,
  nunca devolvida ao renderer (só `hasPassword`).
- **Lista de dispositivos:** `DeviceListPage.tsx` consome `adAPI.getDevices()` →
  `ADComputer` (`Name`, `DNSHostName`, `OperatingSystem`, `Description`, `OU`,
  `LastLogonDate`…). Tem cache de módulo, filtros por OU, erro inline recuperável.
- **Dispatcher:** `DevicesPage.tsx` = `IS_AGENT ? PcOnboardingWizard : DeviceListPage`.
- **Browser mock:** `adAPI.ts` traz um mock completo (fixtures) para preview fora do Electron.

### `pyexp-finops` (molde de deployment a copiar)
- Exporter HTTP containerizado (`docker-compose.yml`, porta 9120), integrado na stack
  Grafana/Mimir/Loki. Confirma que os serviços "pyexp" são **containers HTTP internos**
  em `pt-srv-pyexp`. A inventory-api encaixa ao lado.

---

## 2. Arquitetura alvo

```
  pt-srv-pyexp (rede interna, atrás de VPN/firewall)
  ┌──────────────────────────────────────────────────────────────┐
  │  ezoffice_sync (pacote Python, partilhado)                     │
  │    ├── inventory-sync   cron 5 min (JÁ EXISTE)  ── escreve ──►  │ EZOffice
  │    │      grava snapshot.json (última reconciliação)           │
  │    └── inventory-api    FastAPI (NOVO)  ── serve JSON ─────────►│ (leitura)
  │           lê snapshot.json + connectors (AD ldap3 / EZOffice)  │
  └───────────────▲────────────────────────────────────────────────┘
                  │ HTTPS interno + Bearer token
  ┌───────────────┴───────────────┐
  │  AD Manager (Electron, Mac/Win)│
  │   main.ts  inventory:* handler │  ← token/baseUrl em config (safeStorage)
  │   fetch() → normaliza p/ PSResult
  │   preload  window.inventoryAPI │
  │   renderer Inventário + DeviceList enriquecida │
  └────────────────────────────────┘
```

**Estratégia de dados (importante):** a API serve a partir de um **snapshot da última
reconciliação** (o cron de 5 min grava `snapshot.json`), não faz LDAP/EZOffice ao vivo
a cada pedido. Ganha-se latência baixa, zero martelar o AD/EZOffice, e o dado já vem
reconciliado. Endpoint opcional de *refresh* ao vivo para o botão "Atualizar".

---

## 3. `pyexp-inventory` — a micro-API (FastAPI)

Novo módulo `ezoffice_sync/api/` (reaproveita `config`, `connectors`, `models`, `report`).

| Método | Rota | Fonte | Devolve |
|---|---|---|---|
| GET | `/healthz` | — | `{status, snapshot_age_s, last_run}` |
| GET | `/api/v1/assets` | EZOffice `fetch_assets` (snapshot) | `EZAsset[]` (serial, categoria, status, responsável, exempt) |
| GET | `/api/v1/members` | EZOffice `fetch_members` | `EZUser[]` |
| GET | `/api/v1/devices/ad` | AD `fetch_devices` | `SourceDevice[]` (dept via OU, last_seen, OS) |
| GET | `/api/v1/reconciliation` | último `SyncReport` | orphaned / stale / missing_* / users_orphaned / updated / errors / dry_run / ran_at |
| GET | `/api/v1/metrics-summary` | `Metrics` | gauges atuais |
| POST | `/api/v1/sync?dry_run=true` | `run_sync` | dispara run e devolve report — **gated, off por defeito** |

Notas:
- **Snapshot writer:** pequena extensão ao fim de `run_sync` (ou no `run-sync.sh`) que
  serializa assets+members+devices+report para `snapshot.json` (asdict + `default=str`).
  Reusa exatamente o que o `--probe --out` já faz.
- **Auth:** `Authorization: Bearer <token>` (dependency FastAPI). Token só para leitura.
  O `POST /sync` (que escreve no EZOffice) exige scope/token separado e está **desligado**
  por defeito — nunca expor um proxy de escrita AD/EZOffice aberto na LAN.
- **CORS:** desnecessário — o Electron chama pelo processo *main* (Node), não pelo browser.

---

## 4. `admanager` — wiring

1. **Config nova** `inventory { baseUrl, token }` em Definições → nova aba
   "Inventário/Ligações". Token cifrado com `safeStorage`, nunca devolvido ao renderer
   (espelha o padrão de `connection.json`). Novos canais `config:get/set-inventory`.
2. **`main.ts`:** registar `inventory:*` via `ipcMain.handle` → `fetch()` global (Electron 32
   = Node 20, tem `fetch`) para `baseUrl` com o Bearer, `AbortController` timeout, e
   **normalizar a resposta para `{ ok, data, error }`** (mesma forma que `PSResult`, para
   reutilizar o tratamento de erros do renderer). Token fica no *main*, fora do renderer.
3. **`preload.ts`:** `contextBridge.exposeInMainWorld("inventoryAPI", { getAssets, getMembers,
   getReconciliation, getAdDevices, getHealth, runSync })`.
4. **`src/renderer/src/inventoryAPI.ts`:** wrapper tipado **+ browser mock** (fixtures em
   `src/shared/fixtures.ts`) no mesmo molde do `adAPI.ts`, para o preview funcionar fora do Electron.
5. **Tipos partilhados:** `EZAsset`, `EZUser`, `ReconciliationReport` em `src/shared/types.ts`
   (fonte única main+renderer).
6. **Página "Inventário"** (nav só no Manager, como a lista de dispositivos):
   - Tabela de assets: nome, serial, categoria, estado (Ativo/Orphaned), responsável, dept, visto por último.
   - Painel de reconciliação: contadores orphaned / stale / missing-in-ezoffice / missing-in-source
     / users-orphaned + lista de erros do último run + idade do snapshot.
   - Filtros + pesquisa (reusar o padrão do `DeviceListPage`).
7. **Enriquecer `DeviceListPage`:** juntar o `ADComputer` (por hostname) ao `EZAsset`
   (serial + responsável + estado de sync) → colunas novas. **Fallback gracioso**: se a
   API estiver inacessível, mantém o comportamento AD-only atual (o `DevicesError` já existe).
   No **Mac** (sem PowerShell) a página passa a modo API-only.

---

## 5. Segurança & fleet-safety

- **Interna apenas:** bind da API à LAN/VPN + firewall; **TLS** mesmo interno (CA interna
  ou self-signed com pin no *main*).
- **Read-only por defeito.** `POST /sync` desligado; quando ligado, token/scope à parte.
- **Sem segredos no renderer:** token no *main* via `safeStorage` (igual à password AD).
- **Aditivo:** não mexe nos update feeds nem no flavor split — o Manager continua a ser
  publicado como hoje. Zero risco para a frota já instalada.
- **Auth v2 (futuro):** validar o chamador contra o AD (reusar o bind `ldap3`, como o
  `Test-ADCredential` do Manager) e emitir token de sessão, em vez de shared-secret.

---

## 6. Entrega faseada

| Fase | Onde | Entrega | Verificação |
|---|---|---|---|
| **1** | pyexp-inventory | FastAPI a servir do snapshot: `/healthz`, `/assets`, `/members`, `/reconciliation`, `/metrics-summary`; snapshot writer; Dockerfile + serviço no compose; deploy em `pt-srv-pyexp`; token + TLS | `curl` interno |
| **2** | admanager | config inventory + `inventory:*` no main + preload + `inventoryAPI.ts` + browser mock | smoke via consola/preview |
| **3** | admanager | Página **Inventário** + painel de reconciliação (nav Manager-only) | browser preview (mock) + API viva |
| **4** | admanager | `DeviceListPage` enriquecida (join EZOffice) + fallback + **Mac API-only** | preview + build Win + teste Mac |
| **5** *(opcional)* | ambos | Encaminhar **leituras AD** (users/groups/devices) pela API ldap3 → Manager cross-platform completo | — |
| **6** *(opcional)* | ambos | `POST /sync` + botão "Sincronizar agora" (gated); connectors Entra/Jamf; assignment via `/checkout` | — |

---

## 7. Riscos & decisões em aberto

1. **Ao vivo vs snapshot** → **recomendo snapshot** (refрescado pelo cron), com refresh opcional.
2. **Modelo de auth** → shared-secret agora; AD-bind depois.
3. **Quem opera a API** → `pt-srv-pyexp` (já existe), mas passa a ser um serviço persistente
   com uptime/monitorização própria.
4. **Join AD-computer ↔ EZOffice-asset:** os computadores AD **não têm serial**; os assets
   EZOffice são chaveados por serial (via ScreenConnect). Juntar por **hostname** onde der;
   pode ser preciso um custom field "hostname" no asset para o join ser fiável.
5. **Entra/Jamf ainda stubs** → a `/devices/ad` cobre AD+EZOffice; iOS/mac-MDM fica para a Fase 6.
6. **Churn/escrita:** o Manager não deve disparar escritas casualmente (daí o `POST /sync` gated).

---

## 8. Lista de ficheiros (concreta)

**pyexp-inventory (novos):**
- `ezoffice_sync/api/__init__.py`, `app.py` (FastAPI), `auth.py` (Bearer dep), `snapshot.py` (read/write)
- extensão no fim de `run_sync`/`run-sync.sh` para gravar `snapshot.json`
- `Dockerfile.api` + serviço `inventory-api` no compose; entrada de config `api: { token, tls… }`

**admanager (novos/alterados):**
- `src/shared/types.ts` (+`EZAsset`,`EZUser`,`ReconciliationReport`)
- `src/shared/fixtures.ts` (+mocks de inventário)
- `src/main/main.ts` (+handlers `inventory:*` + `config:get/set-inventory`)
- `src/preload/preload.ts` (+`inventoryAPI`)
- `src/renderer/src/inventoryAPI.ts` (novo)
- `src/renderer/src/pages/InventoryPage.tsx` (novo) + item de nav (Manager-only)
- `src/renderer/src/pages/DeviceListPage.tsx` (join/enriquecimento + fallback)
- `src/renderer/src/pages/SettingsPage.tsx` (aba Inventário: só baseUrl + switch — sem token)

---

## 9. Estado atual da implementação (as-built)

> Esta secção é a **fonte de verdade** sobre o que existe hoje. Onde diverge das §§0–8
> (plano original), vale esta.

### Modelo de auth — passthrough de credenciais (bind-as-user)

**Não há token partilhado nem conta de serviço em lado nenhum do caminho de pedido da API.**
Cada pedido leva o login AD do próprio utilizador via **HTTP Basic**; a API autentica fazendo
um **bind LDAP real *como esse utilizador*** contra o domínio. Um bind com sucesso prova que o
chamador é um utilizador de domínio válido **e** fornece as credenciais usadas para ler o AD
quando o pedido falha a cache — nada além do login de um utilizador válido inicia uma leitura
ao AD, e o servidor não guarda nenhuma credencial de diretório permanente.

- `InventorySystem/ezoffice_sync/api/auth.py` — `require_ad_login` (dependency FastAPI): parse
  manual do header `Authorization: Basic` **em UTF-8** (não o `HTTPBasic` do FastAPI, que descodifica
  só ASCII e daria 401 a passwords com acentos — o `ldap3` faz bind em UTF-8, ver `_parse_basic_auth`);
  falta/malformação → 401 com `WWW-Authenticate: Basic`. `PermissionError` (bind rejeitado) → **401**;
  `ConnectionError` (AD inacessível) → **502** (não confundir uma indisponibilidade com "password errada").
- `InventorySystem/ezoffice_sync/api/deps.py` — `ApiContainer.authed_ad(username, password)`:
  deriva a identidade de bind (`bind_identity`: `sam` → `sam@<domínio-do-user_base_dn>`;
  UPN/`DOMÍNIO\\user`/DN passam à frente), faz `dataclasses.replace` na `ADConfig` com essas
  credenciais, liga (`_connect`) e **reutiliza a conexão ligada** no `ADDirectoryConnector`
  (`ad_directory._conn = ad._conn`) → um único bind por pedido. Sem singletons de conta de serviço.
  `_is_invalid_credentials` distingue password errada (→401) de indisponibilidade (→502).
- **Cache TTL** (`cache.py`) mantém-se **partilhado entre chamadores autenticados** — os dados AD/EZOffice
  são independentes do utilizador; a auth faz o *gate* de acesso + fornece as credenciais do bind *frio*.
  ⚠️ Consequência assumida: num *cache hit* os dados podem ter sido lidos sob o bind de **outro** chamador,
  por isso o bind por-utilizador protege o *acesso* e delimita a leitura *fria*, mas **não** é reavaliado a
  cada hit. Um deployment que dependa de ACLs de leitura AD por-utilizador (ou de auditoria estrita por
  chamador de cada leitura) deve pôr chave-por-chamador na cache ou desligá-la.
- **Sync recorrente** (orchestrator, processo à parte) **mantém a sua própria conta de serviço** em
  `config.yaml` (`ad.bind_password`) — correto e fora do âmbito. `api.token` no schema é mantido só
  porque o mesmo `config.yaml` alimenta o cron; **a API ignora-o**.
- **admanager** (`src/main/main.ts`, `inventoryGet`): assina cada leitura com a sessão de login em
  memória (`session.username`/`session.password` que o utilizador digitou) — `Authorization: Basic …`.
  A password é **só de sessão**, nunca persistida, nunca devolvida ao renderer. `/healthz` é aberto
  (sem auth) — o botão "Testar" só confirma o endereço. `inventory.json` guarda **apenas** `baseUrl` +
  `enabled` (sem token). `friendlyInventoryError` mapeia 401/403 → "termina sessão e volta a entrar".

**Transporte:** a password cruza a rede em cada chamada (Basic só *codifica*; o simple bind LDAP na 389
é *cleartext*). Tratado de forma **não-bloqueante**: aviso (log + texto em Definições) quando o endereço
é `http://`; recomenda-se `https://` na API e LDAPS/StartTLS ao DC. Ver a nota SECURITY em
`deploy/inventory-api.compose.yml` e o docstring de `auth.py`.

### Dados ao vivo (não snapshot)

A API lê **ao vivo por pedido** (connectors AD ldap3 / EZOffice), com **cache TTL curto** para não
martelar as fontes. Não há `snapshot.json`. O `/healthz` reporta `mode: "live"`.

### O que está ligado vs. o que falta (carril cross-platform)

| Área | Estado |
|---|---|
| API bind-as-user (todas as rotas) + testes (`tests/test_api.py`, 9/9) | ✅ feito |
| admanager: `inventory:*` (assets, members, devices/ad, reconciliation, metrics-summary) assinados com o login | ✅ feito |
| Página **Inventário** + painel de reconciliação (Manager-only) | ✅ feito |
| `DeviceListPage` enriquecida (join EZOffice por hostname) + fallback AD-only + **Mac API-only** | ✅ feito |
| Router de diretório `/api/v1/ad/*` (`user-categories`, `device-categories`, `categories/{c}/members`, `search-users`, `devices`, `next-device-name`) — **existe, *gated* por `api.directory.enabled` (off por defeito)** | ✅ construído, ⬜ **ainda não consumido** |
| admanager encaminhar as **leituras AD core** (`ad:get-devices`, users, grupos/categorias, próximo nome de PC) pelo `/api/v1/ad/*` em vez de PowerShell | ⬜ **pendente** — hoje ainda usam PowerShell/Windows |

**Fronteira fixa (não muda):** as **escritas** AD (criar/reset/offboard/onboard) ficam **sempre** em
PowerShell/Windows. Só as *leituras* podem ir pela API. O **Agent** (wizard PC) continua Windows-local.

### Ficheiros da API (as-built, em `InventorySystem/`)
- `ezoffice_sync/api/`: `app.py`, `auth.py` (bind-as-user), `deps.py` (`ApiContainer`), `cache.py`,
  `routers/inventory.py`, `routers/directory.py` (gated).
- `ezoffice_sync/connectors/ad_directory.py` (leituras de diretório via ldap3, para o carril cross-platform).
- `Dockerfile.api`, `deploy/inventory-api.compose.yml`, `tests/test_api.py`.
- **Config partilhada** (`config.py`, `config.example.yaml`): `ApiConfig` + secção `api:` — alterações
  do próprio InventorySystem, fora deste repo.
