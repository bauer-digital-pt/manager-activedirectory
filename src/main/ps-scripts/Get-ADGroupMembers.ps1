# Returns the users that live inside a category OU (a folder under
# OU=O365,OU=BMAP USERS) as a JSON array. The category is passed by its OU Name.
#
# We resolve the OU by Name (not by string-building a DN) so names with spaces or
# special characters — e.g. "PT-BURLI USERS" — can't corrupt the SearchBase.
#
# CRITICAL: Import-Module ActiveDirectory can emit a WARNING while auto-mounting
# the AD: drive. If that text leaks to stdout it becomes the whole response and
# the runner's JSON.parse fails -> empty list. So we silence the warning/progress
# streams and emit a clean JSON array on success (empty when the OU has no members).
#
# A genuine QUERY failure (unreachable DC, bad credentials, module missing) must
# NOT be swallowed into an empty array — that made a down DC look like an empty
# team. On failure we emit { error } and exit 1 so the runner surfaces it and the
# UI can warn instead of silently showing "no users".

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

  # Title / Department / employeeType are pulled so the create-user wizard can
  # base its job-title, department and employee-type suggestions on the people
  # already living in this OU (not just the static per-group config).
  #
  # PasswordExpired is a calculated property (a live comparison of pwdLastSet +
  # maxPwdAge against now), surfaced so the Users page can flag/sort expired
  # accounts. whenCreated/whenChanged power the "Criacao"/"Ultimo update" sorts;
  # both are [datetime] so they're pre-stringified (a bare [datetime] serializes
  # as /Date(ms)/ via ConvertTo-Json) — null when the attribute is unset.
  $members = @(
    Get-ADUser @conn -SearchBase $ou.DistinguishedName -SearchScope Subtree -Filter * `
      -Properties DisplayName, EmailAddress, Enabled, LockedOut, PasswordExpired, Title, Department, employeeType, whenCreated, whenChanged -WarningAction SilentlyContinue |
      Select-Object SamAccountName, DisplayName, EmailAddress, Enabled, LockedOut,
        @{ Name = "PasswordExpired"; Expression = { [bool]$_.PasswordExpired } },
        Title, Department, employeeType,
        @{ Name = "WhenCreated"; Expression = { if ($_.whenCreated) { $_.whenCreated.ToString('yyyy-MM-dd HH:mm:ss') } else { $null } } },
        @{ Name = "WhenChanged"; Expression = { if ($_.whenChanged) { $_.whenChanged.ToString('yyyy-MM-dd HH:mm:ss') } else { $null } } }
  )

  if ($members.Count -eq 0) {
    "[]"
  } else {
    ConvertTo-Json -InputObject $members -Compress
  }
} catch {
  # Surface the failure instead of masking it as an empty team.
  @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
