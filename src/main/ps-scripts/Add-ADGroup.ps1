param(
  [string]$GroupName,
  [string]$Description
)
Import-Module ActiveDirectory -ErrorAction Stop
. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

# -ErrorAction Stop so a failed create lands in catch instead of exiting 0 with
# a fake { success = $true }.
try {
  New-ADGroup @conn `
    -Name $GroupName `
    -GroupScope Global `
    -GroupCategory Security `
    -Description $Description `
    -ErrorAction Stop
  @{ success = $true; groupName = $GroupName } | ConvertTo-Json -Compress
} catch {
  @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
