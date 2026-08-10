# Shared helper: builds the -Server / -Credential arguments for AD cmdlets
# from environment variables set by the Electron main process.
#
# Usage in a script:
#   . "$PSScriptRoot\_ADConn.ps1"
#   $conn = Get-ADConn
#   Get-ADUser @conn -Identity $Username ...
#
# When no remote connection is configured the returned hashtable is empty,
# so cmdlets fall back to the local domain / current credentials.
function Get-ADConn {
  $conn = @{}
  if ($env:AD_SERVER) {
    $conn.Server = $env:AD_SERVER
  }
  if ($env:AD_USER -and $env:AD_PASSWORD) {
    $securePass   = ConvertTo-SecureString $env:AD_PASSWORD -AsPlainText -Force
    $conn.Credential = New-Object System.Management.Automation.PSCredential($env:AD_USER, $securePass)
  }
  return $conn
}
