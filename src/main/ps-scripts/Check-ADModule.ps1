# Reports whether the RSAT ActiveDirectory PowerShell module is installed.
# Does not import it — just checks availability, so it returns instantly.
if (Get-Module -ListAvailable -Name ActiveDirectory) {
  @{ available = $true } | ConvertTo-Json -Compress
} else {
  @{ available = $false } | ConvertTo-Json -Compress
}
