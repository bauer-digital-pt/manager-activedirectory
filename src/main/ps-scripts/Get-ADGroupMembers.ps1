param([string]$GroupName)
Import-Module ActiveDirectory -ErrorAction Stop
. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

$members = Get-ADGroupMember @conn -Identity $GroupName -Recursive |
  Where-Object { $_.objectClass -eq "user" } |
  Get-ADUser @conn -Properties DisplayName, EmailAddress, Enabled, LockedOut |
  Select-Object SamAccountName, DisplayName, EmailAddress, Enabled, LockedOut

$members | ConvertTo-Json -Compress
