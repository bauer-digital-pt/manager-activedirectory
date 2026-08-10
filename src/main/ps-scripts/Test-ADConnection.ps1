# Lightweight AD liveness probe for the sidebar status dot, run on the session
# credentials. Like Test-ADCredential.ps1 it ALWAYS writes a JSON result to
# stdout and exits 0 — a non-zero exit makes the runner report a useless
# "Command failed" and lose the real reason, so failures come back as
# { success:false; error } instead.

function Out-Result($obj) { $obj | ConvertTo-Json -Compress }

try {
  Import-Module ActiveDirectory -ErrorAction Stop
} catch {
  Out-Result @{ success = $false; error = "Módulo ActiveDirectory (RSAT) indisponível." }
  return
}

. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

try {
  $domain = Get-ADDomain @conn -ErrorAction Stop
  Out-Result @{
    success = $true
    domain  = $domain.DNSRoot
    forest  = $domain.Forest
    dc      = $domain.PDCEmulator
  }
} catch {
  Out-Result @{ success = $false; error = $_.Exception.Message }
}
