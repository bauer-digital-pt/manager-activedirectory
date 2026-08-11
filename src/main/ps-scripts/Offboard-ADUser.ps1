# Offboards a user: DISABLE the account and MOVE it to the "morgue" OU.
#
# AD_SERVER / AD_USER / AD_PASSWORD are supplied by the Electron main process as
# environment variables (the logged-in operator's session credentials).
#
# The two safety gates that guard this destructive action -- typing the exact
# username to confirm, and re-entering the admin password -- are enforced in the
# main process BEFORE this script runs (see the ad:offboard-user handler). This
# script therefore just performs the AD change for a username it can trust.
#
# Failure contract: on any error we print { success:false; error } AND exit 1, so
# the runner surfaces the friendly message instead of a false success (runner
# keys ok on the exit code).
#
# NOTE: all output strings are ASCII-only on purpose. PowerShell 5.1 reads a
# BOM-less .ps1 as the system ANSI codepage, so accented literals corrupt on the
# wire and can break JSON.parse in the runner.

param(
  [string]$Username
)

$ErrorActionPreference = "Stop"
$WarningPreference     = "SilentlyContinue"
$ProgressPreference    = "SilentlyContinue"

function Out-Result($obj) { $obj | ConvertTo-Json -Compress }

# Target OU for offboarded (disabled) accounts: the "Users" folder INSIDE the
# Morgue (OU=Users,OU=Morgue). Change here if the morgue layout moves.
$MORGUE_OU = "OU=Users,OU=Morgue,DC=bmap,DC=lis"

if ([string]::IsNullOrWhiteSpace($Username)) {
  Out-Result @{ success = $false; error = "Username em falta." }
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

# Resolve the account first so we fail clearly if it does not exist.
try {
  $user = Get-ADUser @conn -Identity $Username -Properties DistinguishedName -ErrorAction Stop
} catch {
  Out-Result @{ success = $false; error = "Utilizador '$Username' nao encontrado no dominio." }
  exit 1
}

$dn = $user.DistinguishedName

# Disable FIRST (the safety action), then move. If the move fails afterwards the
# account is at least already disabled -- we report that so the operator knows.
try {
  Disable-ADAccount @conn -Identity $dn -ErrorAction Stop
} catch {
  Out-Result @{ success = $false; error = "Nao foi possivel desativar a conta: " + $_.Exception.Message }
  exit 1
}

# Idempotency guard: if the account already lives in the morgue, skip the move.
# Move-ADObject into an object's own container is a same-DN move that AD rejects
# ("unwilling to perform"), which would otherwise report a false failure when
# re-offboarding an already-offboarded user (e.g. from a stale cached list).
if ($dn -like "*,$MORGUE_OU") {
  Out-Result @{
    success  = $true
    username = $Username
    disabled = $true
    movedTo  = $MORGUE_OU
    note     = "A conta ja estava na morgue; apenas foi garantida a desativacao."
  }
  exit 0
}

try {
  Move-ADObject @conn -Identity $dn -TargetPath $MORGUE_OU -ErrorAction Stop
} catch {
  Out-Result @{
    success = $false
    error   = "A conta foi DESATIVADA mas NAO foi movida para a morgue ('$MORGUE_OU'): " + $_.Exception.Message
  }
  exit 1
}

Out-Result @{
  success  = $true
  username = $Username
  disabled = $true
  movedTo  = $MORGUE_OU
}
