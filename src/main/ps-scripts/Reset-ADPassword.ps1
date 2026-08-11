# Resets a user's password and (best-effort) forces a change at next logon.
#
# Failure contract: EVERY failure path prints { success:false; error } to stdout
# and exits 1, so the runner surfaces the real AD reason instead of a generic
# "Command failed" (which also leaked the full command line). All output strings
# are ASCII-only: PowerShell 5.1 reads a BOM-less .ps1 as the system ANSI codepage,
# so accented literals corrupt on the wire and can break JSON.parse in the runner.

param(
  [string]$Username,
  [string]$NewPassword
)

$WarningPreference  = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

function Out-Result($obj) { $obj | ConvertTo-Json -Compress }
function Fail([string]$msg) { Out-Result @{ success = $false; error = $msg }; exit 1 }

# The new password arrives via the environment (RESET_PASSWORD), not on the
# command line, so it never appears in the process command line (Sysmon / EDR).
if ($env:RESET_PASSWORD) { $NewPassword = $env:RESET_PASSWORD }

if ([string]::IsNullOrWhiteSpace($Username))  { Fail "Utilizador em falta." }
if ([string]::IsNullOrEmpty($NewPassword))    { Fail "Palavra-passe nova em falta." }

# Module load + AD connection wrapped so a missing RSAT / dot-source / connection
# failure reports a friendly message instead of terminating with no JSON output.
try {
  Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue
  . "$PSScriptRoot\_ADConn.ps1"
  $conn = Get-ADConn
} catch {
  Fail ("Nao foi possivel carregar o modulo ActiveDirectory: " + $_.Exception.Message)
}

# Resolve the account first so we fail clearly (and detect a down DC / ADWS)
# instead of a cryptic error deep inside Set-ADAccountPassword.
try {
  $user = Get-ADUser @conn -Identity $Username -ErrorAction Stop
} catch {
  $raw = $_.Exception.Message
  $srv = if ($env:AD_SERVER) { $env:AD_SERVER } else { "o servidor AD" }
  if ($raw -match 'Web Services|ADServerDown|unable to contact|server is not operational|find(ing)? .*server') {
    Fail ("Nao foi possivel contactar o Active Directory Web Services em '$srv' (porta 9389). Confirma a ligacao/VPN e que o ADWS esta a correr.")
  }
  Fail ("Utilizador '$Username' nao encontrado no dominio: " + $raw)
}

# The password reset is the PRIMARY action. -ErrorAction Stop turns non-terminating
# AD errors into terminating ones so a real failure lands in catch (without it the
# cmdlet writes an error yet the script still exited 0 -> the UI reported a fake win).
try {
  $securePass = ConvertTo-SecureString $NewPassword -AsPlainText -Force
  Set-ADAccountPassword @conn -Identity $user.DistinguishedName -NewPassword $securePass -Reset -ErrorAction Stop
} catch {
  Fail $_.Exception.Message
}

# Forcing a change at next logon is SECONDARY: it fails for an account with
# PasswordNeverExpires set. The password was already reset, so report success with
# a warning rather than a misleading failure (mirrors New-ADUser's copy-groups).
$warning = $null
try {
  Set-ADUser @conn -Identity $user.DistinguishedName -ChangePasswordAtLogon $true -ErrorAction Stop
} catch {
  $warning = "A palavra-passe foi alterada, mas nao foi possivel forcar a mudanca no proximo inicio de sessao: " + $_.Exception.Message
}

$res = @{ success = $true; username = $Username }
if ($warning) { $res.warning = $warning }
Out-Result $res
