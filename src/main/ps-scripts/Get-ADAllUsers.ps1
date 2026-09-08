# Returns the WHOLE user directory in ONE PowerShell invocation: the category OUs
# (folders under OU=O365,OU=BMAP USERS) AND every user inside them, each tagged
# with its category (GroupName). This replaces the old fan-out of one
# Get-ADGroupMembers.ps1 spawn per category — every extra spawn re-imported the AD
# module (seconds each), which is what made "carregar utilizadores" slow. Here the
# module is imported ONCE and the connection built ONCE.
#
# Output shape (JSON, exit 0 on success):
#   { "groups": [ { Name, Description, DistinguishedName, GroupCategory, GroupScope } ],
#     "users":  [ { SamAccountName, DisplayName, ..., groupName } ] }
#
# The per-user shape is kept IDENTICAL to Get-ADGroupMembers.ps1 (plus groupName)
# so the renderer maps it to UserWithGroup without translation. On failure we emit
# { "error": "<friendly ASCII message>" } and exit 1 so a down DC surfaces a real
# error instead of a misleading empty directory.
#
# All literal strings are ASCII-only: PowerShell 5.1 reads a BOM-less .ps1 as the
# system ANSI codepage, so accented literals corrupt on the wire and can break
# JSON.parse in the runner.

$WarningPreference  = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

# Parent OU that holds the category folders. Kept in sync with New-ADUser.ps1 and
# Get-ADGroup-All.ps1 / Get-ADGroupMembers.ps1.
$BASE_OU = "OU=O365,OU=BMAP USERS,DC=bmap,DC=lis"

. "$PSScriptRoot\_Common.ps1"

try {
  # One module import + one connection splat for the whole read (Get-ChildOUsAsGroups
  # imports the module; Get-ADConn is cheap and reused below).
  $ous  = @(Get-ChildOUsAsGroups $BASE_OU)
  $conn = Get-ADConn

  $users = New-Object System.Collections.ArrayList
  foreach ($ou in $ous) {
    # Same query as Get-ADGroupMembers.ps1: subtree under the category OU, same
    # properties, same calculated fields. Each user is tagged with its category.
    Get-ADUser @conn -SearchBase $ou.DistinguishedName -SearchScope Subtree -Filter * `
        -Properties DisplayName, EmailAddress, Enabled, LockedOut, PasswordExpired, Title, Department, employeeType, whenCreated, whenChanged -ErrorAction Stop |
      Select-Object SamAccountName, DisplayName, EmailAddress, Enabled, LockedOut,
        @{ Name = "PasswordExpired"; Expression = { [bool]$_.PasswordExpired } },
        Title, Department, employeeType,
        @{ Name = "WhenCreated"; Expression = { if ($_.whenCreated) { $_.whenCreated.ToString('yyyy-MM-dd HH:mm:ss') } else { $null } } },
        @{ Name = "WhenChanged"; Expression = { if ($_.whenChanged) { $_.whenChanged.ToString('yyyy-MM-dd HH:mm:ss') } else { $null } } },
        @{ Name = "groupName";   Expression = { $ou.Name } } |
      ForEach-Object { [void]$users.Add($_) }
  }

  # -Depth 6 so the nested groups/users arrays serialize fully (default is 2);
  # the payload is plain data (no self-references) so a generous depth is safe.
  ConvertTo-Json -InputObject @{ groups = $ous; users = @($users) } -Compress -Depth 6
} catch {
  $msg = Resolve-OUListError $_.Exception.Message $BASE_OU "BMAP USERS -> O365"
  ConvertTo-Json -InputObject @{ error = $msg } -Compress
  exit 1
}
