# Returns the "categories" the app browses by. These are NOT domain groups — they
# are the sub-OUs (folders) directly under OU=O365,OU=BMAP USERS. Each folder is
# a team/category; its users are listed by Get-ADGroupMembers.ps1 (SearchBase).
#
# Output shape is kept compatible with the old group list (Name/Description/...)
# so the renderer needs no special-casing; DistinguishedName is added so callers
# can target the exact OU.
#
# On success: a JSON array on stdout, exit 0.
# On failure: { "error": "<friendly ASCII message>" } on stdout, exit 1.
# All output strings are ASCII-only (PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# so accented literals corrupt on the wire and can break JSON.parse in the runner).

$WarningPreference  = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

# Parent OU that holds the category folders. Kept in sync with New-ADUser.ps1.
$BASE_OU = "OU=O365,OU=BMAP USERS,DC=bmap,DC=lis"

try {
  Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue

  . "$PSScriptRoot\_ADConn.ps1"
  $conn = Get-ADConn

  $ous = @(
    Get-ADOrganizationalUnit @conn -SearchBase $BASE_OU -SearchScope OneLevel -Filter * -Properties Description -ErrorAction Stop |
      Sort-Object Name |
      ForEach-Object {
        @{
          Name              = $_.Name
          Description       = $_.Description
          DistinguishedName = $_.DistinguishedName
          GroupCategory     = "OU"
          GroupScope        = ""
        }
      }
  )

  if ($ous.Count -eq 0) {
    "[]"
  } else {
    ConvertTo-Json -InputObject $ous -Compress
  }
} catch {
  $raw = $_.Exception.Message
  $srv = if ($env:AD_SERVER) { $env:AD_SERVER } else { "o servidor AD" }
  if ($raw -match 'Web Services|ADServerDown|unable to contact|server is not operational|find(ing)? .*server') {
    $msg = "Nao foi possivel contactar o Active Directory Web Services em '$srv' (porta 9389). Confirma a ligacao/VPN, que o ADWS esta a correr, e experimenta o nome completo do servidor (ex: $srv.bmap.lis)."
  } elseif ($raw -match 'directory object not found|cannot find an object|referral') {
    $msg = "Nao foi encontrada a OU base '$BASE_OU'. Confirma que a estrutura BMAP USERS -> O365 existe no dominio."
  } else {
    $msg = $raw
  }
  ConvertTo-Json -InputObject @{ error = $msg } -Compress
  exit 1
}
