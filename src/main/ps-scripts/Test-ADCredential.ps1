# Validates the login credentials against the domain. AD_USER / AD_PASSWORD /
# AD_SERVER are supplied by the Electron main process as environment variables.
#
# IMPORTANT: this script ALWAYS writes a JSON result to stdout and exits 0, even
# on failure. The runner treats a non-zero exit as a hard "Command failed" error
# and loses the friendly message, so failures are reported via { success:false;
# error } instead of a non-zero exit. On success it also returns the caller's
# DisplayName (sidebar avatar) and the domain / PDC emulator.
#
# The password is only ever read from the environment and never echoed back.
#
# NOTE: all output strings are ASCII-only on purpose. PowerShell 5.1 reads a
# BOM-less .ps1 as the system ANSI codepage, so accented literals corrupt on the
# wire and can break JSON.parse in the runner.

$WarningPreference  = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

function Out-Result($obj) { $obj | ConvertTo-Json -Compress }

$server = $env:AD_SERVER
$user   = $env:AD_USER
$pass   = $env:AD_PASSWORD

if ([string]::IsNullOrWhiteSpace($user) -or [string]::IsNullOrWhiteSpace($pass)) {
  Out-Result @{ success = $false; error = "Utilizador ou palavra-passe em falta." }
  return
}

# Bare sAMAccountName (strip DOMAIN\ prefix / @domain suffix) for validation + lookup.
$sam = $user
if ($sam -match '\\') { $sam = $sam.Split('\')[-1] }
if ($sam -match '@')  { $sam = $sam.Split('@')[0]  }

# --- Step 1: REALLY verify the password. ---
# Get-AD* over ADWS with -Credential does NOT reliably reject a wrong password on
# a domain-joined machine: the bind can fall through to the running process's
# identity, so every password appeared to authenticate. Do an explicit,
# authenticated credential check with System.DirectoryServices.AccountManagement
# (a real LDAP bind, port 389) which returns $false on a wrong password. This
# also does not need the RSAT ActiveDirectory module.
try {
  Add-Type -AssemblyName System.DirectoryServices.AccountManagement
  $ctxType = [System.DirectoryServices.AccountManagement.ContextType]::Domain
  if ([string]::IsNullOrWhiteSpace($server)) {
    $ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext($ctxType)
  } else {
    $ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext($ctxType, $server)
  }
  $valid = $ctx.ValidateCredentials($sam, $pass)
  if (-not $valid) {
    Out-Result @{ success = $false; error = "Utilizador ou palavra-passe incorretos." }
    return
  }
} catch {
  $raw = $_.Exception.Message
  $srv = if ($server) { $server } else { "o servidor AD" }
  if ($raw -match 'user name or password|password is incorrect|logon failure|credential|unknown user') {
    $msg = "Utilizador ou palavra-passe incorretos."
  } else {
    $msg = "Nao foi possivel contactar o Active Directory em '$srv'. Verifica a ligacao a rede / VPN e tenta novamente."
  }
  Out-Result @{ success = $false; error = $msg }
  return
}

# --- Step 1b: restrict access to Domain Admins. ---
# Only members of the "Domain Admins" group may log in. We match by the group's
# well-known RID (512) rather than its name so it works regardless of the
# domain's display language. GetAuthorizationGroups() returns the user's full
# (recursive) token-group set. Fail CLOSED: if membership can't be determined,
# access is denied.
try {
  $up = [System.DirectoryServices.AccountManagement.UserPrincipal]::FindByIdentity($ctx, $sam)
  if ($null -eq $up) {
    Out-Result @{ success = $false; error = "Utilizador nao encontrado no dominio." }
    return
  }
  $isDomainAdmin = $false
  foreach ($g in $up.GetAuthorizationGroups()) {
    try {
      if ($g.Sid -and $g.Sid.Value -like '*-512') { $isDomainAdmin = $true; break }
    } catch { }
  }
  if (-not $isDomainAdmin) {
    Out-Result @{ success = $false; error = "Acesso restrito a administradores de dominio." }
    return
  }
} catch {
  Out-Result @{ success = $false; error = "Nao foi possivel validar as permissoes de administrador de dominio. Tenta novamente." }
  return
}

# --- Step 2: credentials are valid -> fetch domain info + display name. ---
# A failure here does not undo the validated password: let the user in with
# whatever info we could gather rather than blocking on a secondary lookup.
try {
  Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue
  . "$PSScriptRoot\_ADConn.ps1"
  $conn = Get-ADConn

  $domain = Get-ADDomain @conn -ErrorAction Stop

  $displayName = ""
  try {
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
  Out-Result @{ success = $true; domain = ""; dc = ""; displayName = "" }
}
