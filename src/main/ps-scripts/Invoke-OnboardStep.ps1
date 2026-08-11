# Executes ONE onboarding step on the LOCAL machine and reports the outcome as
# JSON. The renderer drives the steps one at a time (or "run all" in sequence)
# so it can surface per-step progress and honour reboot-required boundaries.
#
# Steps:
#   regional      OS display language English, region Portugal, PT keyboard
#   anyconnect    install Cisco AnyConnect / Secure Client (silent)
#   screenconnect install ScreenConnect (silent)
#   update        install all pending Windows updates
#   domain        join bmap.lis and rename to PT-LPT-<DEPT>-<NUMBER> (reboot)
#
# Contract with the runner (runPS): on success this prints a JSON object and
# exits 0; on any failure it prints {"error": "..."} and exits 1. Every step is
# wrapped in try/catch with -ErrorAction Stop so a silent partial-failure can
# never masquerade as success.
#
# The domain-join credential is supplied by main via the AD_USER / AD_PASSWORD
# env vars (the operator's own AD account). Installer sources arrive as args
# (paths or URLs) so nothing secret is placed on the command line.
#
# ASCII-only output strings (PowerShell 5.1 reads a BOM-less .ps1 as ANSI).

param(
  [string]$Step,
  [string]$NewName = "",
  [string]$AnyConnectSource = "",
  [string]$ScreenConnectSource = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Out-Result([hashtable]$obj) { $obj | ConvertTo-Json -Depth 5 -Compress }
function Fail([string]$msg) { Out-Result @{ error = $msg }; exit 1 }

$Step = ($Step + "").Trim().ToLowerInvariant()
if (-not $Step) { Fail "Passo em falta." }

# Downloads a URL to a temp file (returning the local path) or, for a path that
# already exists, returns it unchanged. Fails loudly if neither.
function Resolve-Installer([string]$src, [string]$label) {
  if (-not $src) { Fail "Fonte do instalador do $label nao esta configurada." }
  if ($src -match "^https?://") {
    $ext = ".exe"
    if ($src -match "\.msi(\?|$)") { $ext = ".msi" }
    $dest = Join-Path $env:TEMP ("onboard_" + $label + $ext)
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri $src -OutFile $dest -UseBasicParsing
    } catch { Fail ("Falha a descarregar o instalador do " + $label + ": " + $_.Exception.Message) }
    return $dest
  }
  # Accept forward slashes in UNC/local paths (operators often type them).
  $src = $src -replace "/", "\"
  if (Test-Path -LiteralPath $src) { return $src }
  Fail ("Instalador do " + $label + " nao encontrado em: " + $src)
}

# Runs an installer silently. MSI via msiexec /qn; EXE with a best-effort silent
# switch. Treats MSI exit code 3010 (reboot required) as success.
function Install-Silent([string]$path, [string]$label) {
  $rebootRequired = $false
  if ($path -match "\.msi$") {
    $p = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", "`"$path`"", "/qn", "/norestart") -Wait -PassThru
    if ($p.ExitCode -eq 3010) { $rebootRequired = $true }
    elseif ($p.ExitCode -ne 0) { Fail ("O instalador do " + $label + " terminou com o codigo " + $p.ExitCode + ".") }
  } else {
    $p = Start-Process -FilePath $path -ArgumentList @("/S") -Wait -PassThru
    if ($p.ExitCode -eq 3010) { $rebootRequired = $true }
    elseif ($p.ExitCode -ne 0 -and $p.ExitCode -ne $null) { Fail ("O instalador do " + $label + " terminou com o codigo " + $p.ExitCode + ".") }
  }
  return $rebootRequired
}

switch ($Step) {

  "regional" {
    try {
      # OS display language English (needs the en-US language pack present).
      Set-WinUILanguageOverride -Language en-US
      # Region / home location = Portugal.
      Set-WinHomeLocation -GeoId 193
      # Formats culture pt-PT (dates, numbers, currency).
      Set-Culture pt-PT
      # Keyboard / input = Portuguese, while the UI override above keeps English.
      $list = New-WinUserLanguageList pt-PT
      Set-WinUserLanguageList $list -Force
    } catch { Fail ("Falha a aplicar as definicoes regionais: " + $_.Exception.Message) }
    Out-Result @{ success = $true; step = "regional"; rebootRequired = $true; message = "Definicoes regionais aplicadas. Reinicio (ou novo inicio de sessao) recomendado." }
    exit 0
  }

  "anyconnect" {
    $path = Resolve-Installer $AnyConnectSource "AnyConnect"
    $rb = Install-Silent $path "AnyConnect"
    Out-Result @{ success = $true; step = "anyconnect"; rebootRequired = $rb; message = "Cisco AnyConnect instalado." }
    exit 0
  }

  "screenconnect" {
    $path = Resolve-Installer $ScreenConnectSource "ScreenConnect"
    $rb = Install-Silent $path "ScreenConnect"
    Out-Result @{ success = $true; step = "screenconnect"; rebootRequired = $rb; message = "ScreenConnect instalado." }
    exit 0
  }

  "update" {
    try {
      $session  = New-Object -ComObject Microsoft.Update.Session
      $searcher = $session.CreateUpdateSearcher()
      $result   = $searcher.Search("IsInstalled=0 and Type='Software' and IsHidden=0")
      if ($result.Updates.Count -eq 0) {
        Out-Result @{ success = $true; step = "update"; installed = 0; rebootRequired = $false; message = "O Windows ja esta atualizado." }
        exit 0
      }
      $toDownload = New-Object -ComObject Microsoft.Update.UpdateColl
      foreach ($u in $result.Updates) {
        if (-not $u.EulaAccepted) { $u.AcceptEula() | Out-Null }
        $toDownload.Add($u) | Out-Null
      }
      $downloader = $session.CreateUpdateDownloader()
      $downloader.Updates = $toDownload
      $downloader.Download() | Out-Null

      $toInstall = New-Object -ComObject Microsoft.Update.UpdateColl
      foreach ($u in $result.Updates) { if ($u.IsDownloaded) { $toInstall.Add($u) | Out-Null } }
      $installer = $session.CreateUpdateInstaller()
      $installer.Updates = $toInstall
      $ir = $installer.Install()

      # IUpdateInstaller.Install() does NOT throw when individual updates fail; it
      # reports the outcome via ResultCode (2=Succeeded, 3=SucceededWithErrors,
      # 4=Failed, 5=Aborted). Count the per-update successes so we report the real
      # number, not just how many we attempted.
      $succeeded = 0
      for ($i = 0; $i -lt $toInstall.Count; $i++) {
        if ($ir.GetUpdateResult($i).ResultCode -eq 2) { $succeeded++ }
      }
    } catch { Fail ("Falha ao instalar as atualizacoes do Windows: " + $_.Exception.Message) }
    # Anything other than a clean success (2) is a partial/failed install: fail
    # loudly so it can never masquerade as a completed step.
    if ($ir.ResultCode -ne 2) {
      Fail ("Falha ao instalar as atualizacoes do Windows (codigo " + [int]$ir.ResultCode + ", HRESULT 0x" + ("{0:X8}" -f $ir.HResult) + "): " + $succeeded + " de " + $toInstall.Count + " instaladas.")
    }
    Out-Result @{ success = $true; step = "update"; installed = [int]$succeeded; rebootRequired = [bool]$ir.RebootRequired; message = ("Atualizacoes instaladas: " + $succeeded + ".") }
    exit 0
  }

  "domain" {
    $deptAlt = "ADM|RCM|CDD|MKT|NWS|RTO|COM|DIG|EVT|HR|IT|LEG"
    if ($NewName -notmatch "^PT-LPT-($deptAlt)-\d+$") {
      Fail "Nome invalido. Deve seguir o padrao PT-LPT-<DEPARTAMENTO>-<NUMERO>."
    }
    $u = $env:AD_USER
    $pw = $env:AD_PASSWORD
    if (-not $u -or -not $pw) { Fail "Credenciais de administrador em falta para juntar ao dominio." }
    $sec = ConvertTo-SecureString $pw -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential($u, $sec)

    $partOfDomain = $false
    try { $partOfDomain = [bool](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).PartOfDomain } catch { }

    try {
      if ($partOfDomain) {
        # Already joined: just rename with domain credentials.
        Rename-Computer -NewName $NewName -DomainCredential $cred -Force -ErrorAction Stop
      } else {
        # Join and rename in one shot.
        Add-Computer -DomainName "bmap.lis" -NewName $NewName -Credential $cred -Options JoinWithNewName,AccountCreate -Force -ErrorAction Stop
      }
    } catch { Fail ("Falha a juntar ao dominio / renomear: " + $_.Exception.Message) }
    Out-Result @{ success = $true; step = "domain"; newName = $NewName; rebootRequired = $true; message = "Juntado ao dominio bmap.lis e renomeado. E necessario reiniciar." }
    exit 0
  }

  default { Fail ("Passo desconhecido: " + $Step) }
}
