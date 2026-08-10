# Validates the login credentials against the domain. AD_USER / AD_PASSWORD /
# AD_SERVER are supplied by the Electron main process as environment variables;
# _ADConn.ps1 turns them into a -Credential (+ -Server) splat. Get-ADDomain then
# performs an authenticated bind — a wrong password or bad account fails here.
#
# On success it also returns the caller's DisplayName (for the sidebar avatar)
# and the domain / PDC emulator (pinned as the session DC). The password is only
# ever read from the environment and is never echoed back.
Import-Module ActiveDirectory -ErrorAction Stop
. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

try {
  $domain = Get-ADDomain @conn -ErrorAction Stop

  $displayName = ""
  try {
    # Strip a DOMAIN\ prefix if present so Get-ADUser gets a bare sAMAccountName.
    $sam = $env:AD_USER
    if ($sam -match '\\') { $sam = $sam.Split('\')[-1] }
    if ($sam -match '@')  { $sam = $sam.Split('@')[0]  }
    $me = Get-ADUser @conn -Identity $sam -Properties DisplayName -ErrorAction Stop
    if ($me.DisplayName) { $displayName = $me.DisplayName }
  } catch { }

  @{
    success     = $true
    domain      = $domain.DNSRoot
    dc          = $domain.PDCEmulator
    displayName = $displayName
  } | ConvertTo-Json -Compress
} catch {
  @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
