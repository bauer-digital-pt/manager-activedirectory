Import-Module ActiveDirectory -ErrorAction Stop
. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

try {
  $domain = Get-ADDomain @conn -ErrorAction Stop
  @{
    success = $true
    domain  = $domain.DNSRoot
    forest  = $domain.Forest
    dc      = $domain.PDCEmulator
  } | ConvertTo-Json -Compress
} catch {
  @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
