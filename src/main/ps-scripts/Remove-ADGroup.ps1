param([string]$GroupName)
Import-Module ActiveDirectory -ErrorAction Stop
. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

# -ErrorAction Stop so a failed removal lands in catch instead of exiting 0 with
# a fake { success = $true }.
try {
  Remove-ADGroup @conn -Identity $GroupName -Confirm:$false -ErrorAction Stop
  @{ success = $true; groupName = $GroupName } | ConvertTo-Json -Compress
} catch {
  @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
