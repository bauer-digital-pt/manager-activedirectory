param(
  [string]$GroupName,
  [string]$Description
)
Import-Module ActiveDirectory -ErrorAction Stop
. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

New-ADGroup @conn `
  -Name $GroupName `
  -GroupScope Global `
  -GroupCategory Security `
  -Description $Description

@{ success = $true; groupName = $GroupName } | ConvertTo-Json -Compress
