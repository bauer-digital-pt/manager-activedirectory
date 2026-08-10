param(
  [string]$Username,
  [string]$NewPassword
)
Import-Module ActiveDirectory -ErrorAction Stop
. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

$securePass = ConvertTo-SecureString $NewPassword -AsPlainText -Force
Set-ADAccountPassword @conn -Identity $Username -NewPassword $securePass -Reset
Set-ADUser @conn -Identity $Username -ChangePasswordAtLogon $true

@{ success = $true; username = $Username } | ConvertTo-Json -Compress
