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
  $raw = $_.Exception.Message
  $srv = if ($env:AD_SERVER) { $env:AD_SERVER } else { "o Active Directory" }
  if ($raw -match 'Web Services|ADServerDown|unable to contact|server is not operational|find(ing)? .*server') {
    $msg = "Não foi possível contactar o Active Directory Web Services em '$srv'. Confirma a ligação/VPN e que o serviço ADWS está a correr e acessível (porta 9389)."
  } else {
    $msg = $raw
  }
  ConvertTo-Json -InputObject @{ error = $msg } -Compress
  exit 1
}
