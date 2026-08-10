# Returns all AD groups as a JSON array.
#
# On success: a JSON array on stdout, exit 0.
# On failure: { "error": "<friendly message>" } on stdout, exit 1 — so the
# runner reports ok:false with a real reason. Previously the Get-AD* error was
# non-terminating: $groups became null, ConvertTo-Json emitted nothing, and the
# Import-Module ADWS WARNING was the only stdout → the runner saw exit 0 and
# treated the warning string as a successful (garbage) result. Silence the
# warning/progress streams so they can never pollute stdout.

$WarningPreference  = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

try {
  Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue

  . "$PSScriptRoot\_ADConn.ps1"
  $conn = Get-ADConn

  $groups = @(
    Get-ADGroup @conn -Filter * -Properties Description -ErrorAction Stop |
      Select-Object Name, Description, GroupCategory, GroupScope
  )

  if ($groups.Count -eq 0) {
    "[]"
  } else {
    ConvertTo-Json -InputObject $groups -Compress
  }
} catch {
  # ASCII-only messages: PowerShell 5.1 reads BOM-less .ps1 files as ANSI, so
  # accented literals get corrupted on the wire and can break JSON.parse in the
  # runner. Keep it plain ASCII to stay readable in every codepage.
  $raw = $_.Exception.Message
  $srv = if ($env:AD_SERVER) { $env:AD_SERVER } else { "o servidor AD" }
  if ($raw -match 'Web Services|ADServerDown|unable to contact|server is not operational|find(ing)? .*server') {
    $msg = "Nao foi possivel contactar o Active Directory Web Services em '$srv' (porta 9389). Confirma a ligacao/VPN, que o ADWS esta a correr, e experimenta o nome completo do servidor (ex: $srv.bmap.lis)."
  } else {
    $msg = $raw
  }
  ConvertTo-Json -InputObject @{ error = $msg } -Compress
  exit 1
}
