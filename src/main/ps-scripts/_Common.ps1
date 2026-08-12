# Shared helpers for the OU-listing scripts (Get-ADGroup-All / Get-DeviceOU-All).
#
# Usage in a script:
#   . "$PSScriptRoot\_Common.ps1"
#   $ous = @(Get-ChildOUsAsGroups $BASE_OU)
#
# Dot-sourcing this file also brings in Get-ADConn (via _ADConn.ps1), so a script
# that needs the connection splat can dot-source _Common.ps1 alone.
#
# This file defines FUNCTIONS only (no top-level work beyond the _ADConn dot-source),
# so dot-sourcing it is side-effect-free and safe on every code path.
#
# All strings are ASCII-only on purpose: PowerShell 5.1 reads a BOM-less .ps1 as
# the system ANSI codepage, so accented literals corrupt on the wire and can break
# JSON.parse in the runner.

# Single source of truth for the -Server / -Credential splat (Get-ADConn).
. "$PSScriptRoot\_ADConn.ps1"

# Lists the sub-OUs (folders) directly under $BaseOU in the app's "category" shape
# (Name/Description/DistinguishedName/GroupCategory/GroupScope). Imports the AD
# module and builds the connection itself; throws on any AD failure so the caller
# can map it to a friendly message. Returns an array (wrap the call in @() to keep
# a single-element result an array).
function Get-ChildOUsAsGroups([string]$BaseOU) {
  Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue
  $conn = Get-ADConn
  return @(
    Get-ADOrganizationalUnit @conn -SearchBase $BaseOU -SearchScope OneLevel -Filter * -Properties Description -ErrorAction Stop |
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
}

# Maps a raw AD exception message from an OU listing to a friendly ASCII message.
# $TreeLabel names the OU path in the "not found" branch (e.g. "BMAP USERS -> O365").
function Resolve-OUListError([string]$Raw, [string]$BaseOU, [string]$TreeLabel) {
  $srv = if ($env:AD_SERVER) { $env:AD_SERVER } else { "o servidor AD" }
  if ($Raw -match 'Web Services|ADServerDown|unable to contact|server is not operational|find(ing)? .*server') {
    return "Nao foi possivel contactar o Active Directory Web Services em '$srv' (porta 9389). Confirma a ligacao/VPN, que o ADWS esta a correr, e experimenta o nome completo do servidor (ex: $srv.bmap.lis)."
  }
  if ($Raw -match 'directory object not found|cannot find an object|referral') {
    return "Nao foi encontrada a OU base '$BaseOU'. Confirma que a estrutura $TreeLabel existe no dominio."
  }
  return $Raw
}
