# Returns the device "folders" (sub-OUs) directly under the O365 container in the
# BMAP Devices tree: OU=O365,OU=BMAP Devices,DC=bmap,DC=lis. These are the target
# locations a newly-joined computer must land in (the Settings > Dispositivos tab
# maps each department code to one of these folders).
#
# Output mirrors Get-ADGroup-All.ps1 (Name/Description/DistinguishedName/...), so
# the renderer can reuse the ADGroup shape and its combobox without special-casing.
#
# On success: a JSON array on stdout, exit 0.
# On failure: { "error": "<friendly ASCII message>" } on stdout, exit 1.
# All output strings are ASCII-only (PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# so accented literals corrupt on the wire and can break JSON.parse in the runner).

$WarningPreference  = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

# Parent OU that holds the device folders. AD matches DN components case-
# insensitively, so "BMAP Devices" vs "BMAP DEVICES" resolves the same. Kept in
# sync with Invoke-OnboardStep.ps1 ($DEVICE_BASE).
$BASE_OU = "OU=O365,OU=BMAP Devices,DC=bmap,DC=lis"

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
    $msg = "Nao foi encontrada a OU base '$BASE_OU'. Confirma que a estrutura BMAP Devices -> O365 existe no dominio."
  } else {
    $msg = $raw
  }
  ConvertTo-Json -InputObject @{ error = $msg } -Compress
  exit 1
}
