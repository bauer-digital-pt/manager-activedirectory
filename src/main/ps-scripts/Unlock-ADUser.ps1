param([string]$Username)
Import-Module ActiveDirectory -ErrorAction Stop
. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

Unlock-ADAccount @conn -Identity $Username

@{ success = $true; username = $Username } | ConvertTo-Json -Compress
