param([string]$Username)
Import-Module ActiveDirectory -ErrorAction Stop
. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

# -ErrorAction Stop so a failed unlock lands in catch instead of exiting 0 with
# a fake { success = $true }.
try {
  Unlock-ADAccount @conn -Identity $Username -ErrorAction Stop
  @{ success = $true; username = $Username } | ConvertTo-Json -Compress
} catch {
  @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
