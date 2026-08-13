# Executes ONE onboarding step on the LOCAL machine and reports the outcome as
# JSON. The renderer drives the steps one at a time (or "run all" in sequence)
# so it can surface per-step progress and honour reboot-required boundaries.
#
# Steps:
#   regional      OS display language English, region Portugal, PT keyboard
#   anyconnect    install Cisco AnyConnect / Secure Client (silent)
#   screenconnect install ScreenConnect (silent)
#   smlplayer     install SMLPlayer (silent), open+close it, copy Main.ini
#   printers      run the RICOHPCL6 add<NAME>.cmd for each configured printer
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
  [string]$ScreenConnectSource = "",
  # Name of the destination folder (a sub-OU under O365 in the BMAP Devices tree)
  # the computer account should land in after the domain join. Empty = default
  # location. Resolved by Name against $DEVICE_BASE so it can't corrupt the DN.
  [string]$TargetOU = "",
  # Comma-separated printer names to configure (printers step). Each name N runs
  # <PrinterSource>\add<N>.cmd. PrinterSource is the RICOHPCL6 folder.
  [string]$Printers = "",
  [string]$PrinterSource = "",
  # SMLPlayer installer + the Main.ini copied into %APPDATA%\SMLPlayer7 (smlplayer step).
  [string]$SmlPlayerSource = "",
  [string]$SmlPlayerIni = "",
  # Free-text description written onto the computer's AD object (domain step),
  # e.g. "Preparado para Joao Silva (jsilva)". Empty = leave the description
  # untouched. Best-effort: a failure here warns but never fails the join.
  [string]$Description = ""
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

  "smlplayer" {
    $path = Resolve-Installer $SmlPlayerSource "SMLPlayer"
    # SMLPlayer ships an Inno Setup style installer (SMLPlayer-<ver>-Install.exe);
    # /VERYSILENT installs with no UI. Adjust these switches here if the vendor
    # ever changes packagers. 3010 = installed, reboot pending.
    try {
      $ip = Start-Process -FilePath $path -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART") -Wait -PassThru
    } catch { Fail ("Falha a instalar o SMLPlayer: " + $_.Exception.Message) }
    if ($ip.ExitCode -ne 0 -and $ip.ExitCode -ne 3010 -and $ip.ExitCode -ne $null) {
      Fail ("O instalador do SMLPlayer terminou com o codigo " + $ip.ExitCode + ".")
    }

    # A) Open then close the app once so it materialises its default per-user
    # profile (%APPDATA%\SMLPlayer7) BEFORE the managed Main.ini is dropped in.
    # Best-effort: if the executable can't be located we warn but still copy.
    $launched = $false
    $warning  = $null
    try {
      $exe   = $null
      $roots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
      foreach ($root in $roots) {
        $dir = Get-ChildItem -LiteralPath $root -Directory -Filter "SMLPlayer*" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($dir) {
          $exe = Get-ChildItem -LiteralPath $dir.FullName -Recurse -Filter "*.exe" -ErrorAction SilentlyContinue |
                 Where-Object { $_.Name -match "SMLPlayer" } | Select-Object -First 1
          if ($exe) { break }
        }
      }
      if ($exe) {
        $sp = Start-Process -FilePath $exe.FullName -PassThru
        Start-Sleep -Seconds 8
        try { if ($sp -and -not $sp.HasExited) { $sp.CloseMainWindow() | Out-Null } } catch { }
        Start-Sleep -Seconds 2
        Get-Process -Name $exe.BaseName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        $launched = $true
      } else {
        $warning = "Nao foi possivel localizar o executavel do SMLPlayer para o abrir; o Main.ini foi aplicado na mesma."
      }
    } catch {
      $warning = "Falha ao abrir/fechar o SMLPlayer (" + $_.Exception.Message + "); o Main.ini foi aplicado na mesma."
    }

    # B) Copy the managed Main.ini into %APPDATA%\SMLPlayer7 (per-user Roaming).
    if (-not $SmlPlayerIni) { Fail "O caminho do Main.ini do SMLPlayer nao esta configurado." }
    $ini = $SmlPlayerIni -replace "/", "\"
    if (-not (Test-Path -LiteralPath $ini)) { Fail ("Main.ini do SMLPlayer nao encontrado em: " + $ini) }
    $destDir = Join-Path $env:APPDATA "SMLPlayer7"
    try {
      if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
      Copy-Item -LiteralPath $ini -Destination (Join-Path $destDir "Main.ini") -Force -ErrorAction Stop
    } catch { Fail ("Falha a copiar o Main.ini para " + $destDir + ": " + $_.Exception.Message) }

    $res = @{ success = $true; step = "smlplayer"; launched = $launched; message = "SMLPlayer instalado e Main.ini aplicado." }
    if ($warning) { $res.warning = $warning }
    Out-Result $res
    exit 0
  }

  "printers" {
    # Comma-separated names -> <PrinterSource>\add<NAME>.cmd, run one at a time.
    $names = @()
    if ($Printers) { $names = $Printers.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
    if ($names.Count -eq 0) {
      Out-Result @{ success = $true; step = "printers"; installed = 0; message = "Nenhuma impressora configurada para este departamento." }
      exit 0
    }
    if (-not $PrinterSource) { Fail "A pasta das impressoras (RICOHPCL6) nao esta configurada." }
    $base = $PrinterSource -replace "/", "\"
    if (-not (Test-Path -LiteralPath $base)) { Fail ("Pasta das impressoras nao encontrada: " + $base) }

    # Names/paths here contain no spaces (RICOHPCL6 share + add<NAME>.cmd), so the
    # full path can be handed to cmd.exe /c without the batch quote-stripping trap.
    $done = @()
    foreach ($n in $names) {
      $cmd = Join-Path $base ("add" + $n + ".cmd")
      if (-not (Test-Path -LiteralPath $cmd)) { Fail ("Script da impressora nao encontrado: " + $cmd) }
      try {
        $pp = Start-Process -FilePath $env:ComSpec -ArgumentList @("/c", $cmd) -Wait -PassThru -WindowStyle Hidden
      } catch { Fail ("Falha a executar " + $cmd + ": " + $_.Exception.Message) }
      if ($pp.ExitCode -ne 0 -and $pp.ExitCode -ne $null) {
        Fail ("O script da impressora '" + $n + "' terminou com o codigo " + $pp.ExitCode + ".")
      }
      $done += $n
    }
    Out-Result @{ success = $true; step = "printers"; installed = $done.Count; message = ("Impressoras configuradas: " + ($done -join ", ") + ".") }
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

    # The AD module + connection are needed to resolve the destination OU and/or to
    # stamp the computer's description. Load them once when either is requested;
    # failure to load is non-fatal (the join itself uses netdom-style cmdlets that
    # don't need the RSAT module) — it just downgrades OU placement + description to
    # a warning.
    $DEVICE_BASE = "OU=O365,OU=BMAP Devices,DC=bmap,DC=lis"
    $ouDn       = $null
    $ouWarning  = $null
    $adConn     = $null
    if ($TargetOU -or $Description) {
      try {
        Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue
        . "$PSScriptRoot\_ADConn.ps1"
        $adConn = Get-ADConn
      } catch {
        $adConn = $null
        if ($TargetOU) { $ouWarning = "Nao foi possivel carregar o modulo ActiveDirectory (" + $_.Exception.Message + "); o computador fica no local por defeito." }
      }
    }

    # Resolve the destination OU DN from the folder Name (a sub-OU under O365 in the
    # BMAP Devices tree). Matched by -Filter on Name so a folder name with a space /
    # comma / quote can never corrupt the DN. Resolution failure is a WARNING, not a
    # fatal error: the computer still needs to be joined, just in the default spot.
    if ($TargetOU -and $adConn) {
      try {
        $ou = Get-ADOrganizationalUnit @adConn -SearchBase $DEVICE_BASE -SearchScope OneLevel `
                -Filter 'Name -eq $TargetOU' -ErrorAction Stop | Select-Object -First 1
        if ($ou) { $ouDn = $ou.DistinguishedName }
        else { $ouWarning = "A pasta de destino '$TargetOU' nao foi encontrada em BMAP Devices -> O365; o computador fica no local por defeito." }
      } catch {
        $ouWarning = "Nao foi possivel resolver a pasta de destino '$TargetOU' (" + $_.Exception.Message + "); o computador fica no local por defeito."
      }
    }

    $partOfDomain = $false
    try { $partOfDomain = [bool](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).PartOfDomain } catch { }
    $oldName = $env:COMPUTERNAME

    try {
      if ($partOfDomain) {
        # Already joined: rename with domain credentials, then (best-effort) move
        # the computer account into the target OU. Rename-Computer updates the AD
        # object immediately, so we can locate it by the new name (falling back to
        # the pre-reboot name just in case).
        Rename-Computer -NewName $NewName -DomainCredential $cred -Force -ErrorAction Stop
        if ($ouDn) {
          try {
            $comp = $null
            try { $comp = Get-ADComputer @adConn -Identity $NewName -ErrorAction Stop } catch { }
            if (-not $comp -and $oldName) { try { $comp = Get-ADComputer @adConn -Identity $oldName -ErrorAction Stop } catch { } }
            if ($comp) {
              if ($comp.DistinguishedName -notmatch [regex]::Escape("," + $ouDn) + "$") {
                Move-ADObject @adConn -Identity $comp.DistinguishedName -TargetPath $ouDn -ErrorAction Stop
              }
            } else {
              $ouWarning = "Renomeado, mas nao foi possivel localizar a conta de computador para a mover para '$TargetOU'."
            }
          } catch {
            $ouWarning = "Renomeado, mas a movimentacao para '$TargetOU' falhou: " + $_.Exception.Message
          }
        }
      } else {
        # Fresh join + rename in one shot. When the target OU is known we create the
        # account directly there via -OUPath (no follow-up move needed).
        if ($ouDn) {
          Add-Computer -DomainName "bmap.lis" -NewName $NewName -Credential $cred -OUPath $ouDn -Options JoinWithNewName,AccountCreate -Force -ErrorAction Stop
        } else {
          Add-Computer -DomainName "bmap.lis" -NewName $NewName -Credential $cred -Options JoinWithNewName,AccountCreate -Force -ErrorAction Stop
        }
      }
    } catch { Fail ("Falha a juntar ao dominio / renomear: " + $_.Exception.Message) }

    # Stamp the "prepared for" description onto the computer's AD object. Done AFTER
    # the join/rename so the account exists and carries its final name. Best-effort:
    # the join already succeeded, so a description failure only warns.
    $descWarning = $null
    if ($Description) {
      if ($adConn) {
        try {
          $comp = $null
          try { $comp = Get-ADComputer @adConn -Identity $NewName -ErrorAction Stop } catch { }
          if (-not $comp -and $oldName) { try { $comp = Get-ADComputer @adConn -Identity $oldName -ErrorAction Stop } catch { } }
          if ($comp) {
            Set-ADComputer @adConn -Identity $comp.DistinguishedName -Description $Description -ErrorAction Stop
          } else {
            $descWarning = "Juntado/renomeado, mas nao foi possivel localizar a conta de computador para definir a descricao."
          }
        } catch {
          $descWarning = "Juntado/renomeado, mas a definicao da descricao falhou: " + $_.Exception.Message
        }
      } else {
        $descWarning = "Nao foi possivel definir a descricao (modulo ActiveDirectory indisponivel)."
      }
    }

    $res = @{ success = $true; step = "domain"; newName = $NewName; rebootRequired = $true; message = "Juntado ao dominio bmap.lis e renomeado. E necessario reiniciar." }
    if ($ouDn) { $res.targetOU = $TargetOU }
    # Surface any non-fatal OU / description warnings together.
    $warnings = @($ouWarning, $descWarning) | Where-Object { $_ }
    if ($warnings.Count) { $res.warning = ($warnings -join " ") }
    Out-Result $res
    exit 0
  }

  default { Fail ("Passo desconhecido: " + $Step) }
}
