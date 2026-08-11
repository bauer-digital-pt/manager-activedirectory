param(
  [string]$Username,
  [string]$NewPassword
)

# The new password arrives via the environment (RESET_PASSWORD), not on the
# command line, so it never appears in the process command line (Sysmon / EDR).
if ($env:RESET_PASSWORD) { $NewPassword = $env:RESET_PASSWORD }

Import-Module ActiveDirectory -ErrorAction Stop
. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

# -ErrorAction Stop turns non-terminating AD errors into terminating ones so a
# real failure lands in catch. Without it the cmdlet writes an error and the
# script still exited 0 with { success = $true } -> the UI reported a fake win.
try {
  $securePass = ConvertTo-SecureString $NewPassword -AsPlainText -Force
  Set-ADAccountPassword @conn -Identity $Username -NewPassword $securePass -Reset -ErrorAction Stop
  Set-ADUser @conn -Identity $Username -ChangePasswordAtLogon $true -ErrorAction Stop
  @{ success = $true; username = $Username } | ConvertTo-Json -Compress
} catch {
  @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
