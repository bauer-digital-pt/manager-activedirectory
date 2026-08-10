param([string]$GroupName)
Import-Module ActiveDirectory -ErrorAction Stop
. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

Remove-ADGroup @conn -Identity $GroupName -Confirm:$false

@{ success = $true; groupName = $GroupName } | ConvertTo-Json -Compress
