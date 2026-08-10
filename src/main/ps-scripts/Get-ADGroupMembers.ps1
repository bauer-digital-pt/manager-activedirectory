# Returns the users that live inside a category OU (a folder under
# OU=O365,OU=BMAP USERS) as a JSON array. The category is passed by its OU Name.
#
# We resolve the OU by Name (not by string-building a DN) so names with spaces or
# special characters — e.g. "PT-BURLI USERS" — can't corrupt the SearchBase.
#
# CRITICAL: Import-Module ActiveDirectory can emit a WARNING while auto-mounting
# the AD: drive. If that text leaks to stdout it becomes the whole response and
# the runner's JSON.parse fails -> empty list. So we silence the warning/progress
# streams and ALWAYS emit a clean JSON array (empty on any error).

param([string]$GroupName)

$WarningPreference  = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

# Parent OU that holds the category folders. Kept in sync with New-ADUser.ps1.
$BASE_OU = "OU=O365,OU=BMAP USERS,DC=bmap,DC=lis"

if ([string]::IsNullOrWhiteSpace($GroupName)) {
  "[]"
  return
}

try {
  Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue

  . "$PSScriptRoot\_ADConn.ps1"
  $conn = Get-ADConn

  # Resolve the category OU under the O365 base by its Name.
  $ou = Get-ADOrganizationalUnit @conn -SearchBase $BASE_OU -SearchScope OneLevel `
          -Filter 'Name -eq $GroupName' -ErrorAction Stop | Select-Object -First 1

  if (-not $ou) {
    "[]"
    return
  }

  $members = @(
    Get-ADUser @conn -SearchBase $ou.DistinguishedName -SearchScope Subtree -Filter * `
      -Properties DisplayName, EmailAddress, Enabled, LockedOut -WarningAction SilentlyContinue |
      Select-Object SamAccountName, DisplayName, EmailAddress, Enabled, LockedOut
  )

  if ($members.Count -eq 0) {
    "[]"
  } else {
    ConvertTo-Json -InputObject $members -Compress
  }
} catch {
  # Never leak an error string to stdout — keep the array contract intact.
  "[]"
}
