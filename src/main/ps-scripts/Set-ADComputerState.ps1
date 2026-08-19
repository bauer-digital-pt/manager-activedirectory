# Enables or disables a COMPUTER account in AD -- the one reversible write the
# device detail panel offers.
#
# AD_SERVER / AD_USER / AD_PASSWORD are supplied by the Electron main process as
# environment variables (the logged-in operator's session credentials). The
# kiosk re-auth gate that guards this action is enforced in the renderer/main
# BEFORE this script runs (see the ad:set-device-state handler), so this script
# just performs the change for an identity it can trust.
#
# Failure contract: on any error we print { success:false; error } AND exit 1, so
# the runner surfaces the friendly message instead of a false success (the runner
# keys ok on the exit code).
#
# NOTE: all output strings are ASCII-only on purpose. PowerShell 5.1 reads a
# BOM-less .ps1 as the system ANSI codepage, so accented literals corrupt on the
# wire and can break JSON.parse in the runner.

param(
  [string]$Identity,
  [string]$Action
)

$ErrorActionPreference = "Stop"
$WarningPreference     = "SilentlyContinue"
$ProgressPreference    = "SilentlyContinue"

function Out-Result($obj) { $obj | ConvertTo-Json -Compress }

if ([string]::IsNullOrWhiteSpace($Identity)) {
  Out-Result @{ success = $false; error = "Dispositivo em falta." }
  exit 1
}

$act = ($Action + "").Trim().ToLower()
if ($act -ne "enable" -and $act -ne "disable") {
  Out-Result @{ success = $false; error = "Acao invalida." }
  exit 1
}

try {
  Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue
  . "$PSScriptRoot\_ADConn.ps1"
  $conn = Get-ADConn
} catch {
  Out-Result @{ success = $false; error = "Nao foi possivel carregar o modulo ActiveDirectory: " + $_.Exception.Message }
  exit 1
}

# Resolve the computer first so we fail clearly if it does not exist. Identity may
# be a DistinguishedName (preferred, unambiguous) or a bare Name; Get-ADComputer
# -Identity accepts both.
try {
  $computer = Get-ADComputer @conn -Identity $Identity -Properties Enabled,DistinguishedName -ErrorAction Stop
} catch {
  Out-Result @{ success = $false; error = "Dispositivo '$Identity' nao encontrado no dominio." }
  exit 1
}

$dn = $computer.DistinguishedName

try {
  if ($act -eq "enable") {
    Enable-ADAccount @conn -Identity $dn -ErrorAction Stop
  } else {
    Disable-ADAccount @conn -Identity $dn -ErrorAction Stop
  }
} catch {
  $verb = if ($act -eq "enable") { "ativar" } else { "desativar" }
  Out-Result @{ success = $false; error = "Nao foi possivel $verb o dispositivo: " + $_.Exception.Message }
  exit 1
}

Out-Result @{
  success  = $true
  identity = $dn
  enabled  = ($act -eq "enable")
}
