# Validates the login credentials against the domain. AD_USER / AD_PASSWORD /
# AD_SERVER are supplied by the Electron main process as environment variables;
# _ADConn.ps1 turns them into a -Credential (+ -Server) splat. Get-ADDomain then
# performs an authenticated bind — a wrong password or bad account fails here.
#
# IMPORTANT: this script ALWAYS writes a JSON result to stdout and exits 0, even
# on failure. The runner treats a non-zero exit as a hard "Command failed" error
# and loses the friendly message, so failures are reported via { success:false;
# error } instead of a non-zero exit. On success it also returns the caller's
# DisplayName (sidebar avatar) and the domain / PDC emulator (pinned session DC).
# The password is only ever read from the environment and never echoed back.

function Out-Result($obj) { $obj | ConvertTo-Json -Compress }

# The RSAT ActiveDirectory module is a hard precondition. Import it before doing
# anything else so a missing module returns an actionable message, not a crash.
try {
  Import-Module ActiveDirectory -ErrorAction Stop
} catch {
  Out-Result @{ success = $false; error = "O módulo ActiveDirectory (RSAT) não está instalado nesta máquina. Instala as RSAT: Active Directory (Definições do Windows -> Aplicações -> Funcionalidades opcionais) e reinicia a aplicação." }
  return
}

. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

try {
  $domain = Get-ADDomain @conn -ErrorAction Stop

  $displayName = ""
  try {
    # Strip a DOMAIN\ prefix / @domain suffix so Get-ADUser gets a bare sAMAccountName.
    $sam = $env:AD_USER
    if ($sam -match '\\') { $sam = $sam.Split('\')[-1] }
    if ($sam -match '@')  { $sam = $sam.Split('@')[0]  }
    $me = Get-ADUser @conn -Identity $sam -Properties DisplayName -ErrorAction Stop
    if ($me.DisplayName) { $displayName = $me.DisplayName }
  } catch { }

  Out-Result @{
    success     = $true
    domain      = $domain.DNSRoot
    dc          = $domain.PDCEmulator
    displayName = $displayName
  }
} catch {
  # Map the common bind failures to a friendly Portuguese message; fall back to
  # the raw exception text for anything unexpected.
  $raw = $_.Exception.Message
  $msg = $raw
  if ($raw -match 'user name or password|password is incorrect|logon failure|authentication|credential|unknown user name') {
    $msg = "Utilizador ou palavra-passe incorretos."
  } elseif ($raw -match 'server is not operational|cannot contact|unable to contact|find(ing)? .*server|no .*domain controller|referral was returned|LDAP server') {
    $msg = "Não foi possível contactar o Active Directory. Verifica a ligação à rede / VPN e tenta novamente."
  }
  Out-Result @{ success = $false; error = $msg }
}
