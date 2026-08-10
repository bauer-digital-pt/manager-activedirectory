Import-Module ActiveDirectory -ErrorAction Stop
. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

$groups = Get-ADGroup @conn -Filter * -Properties Description | Select-Object Name, Description, GroupCategory, GroupScope

$groups | ConvertTo-Json -Compress
