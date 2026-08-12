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

. "$PSScriptRoot\_Common.ps1"

try {
  $ous = @(Get-ChildOUsAsGroups $BASE_OU)
  if ($ous.Count -eq 0) {
    "[]"
  } else {
    ConvertTo-Json -InputObject $ous -Compress
  }
} catch {
  $msg = Resolve-OUListError $_.Exception.Message $BASE_OU "BMAP USERS -> O365"
  ConvertTo-Json -InputObject @{ error = $msg } -Compress
  exit 1
}
