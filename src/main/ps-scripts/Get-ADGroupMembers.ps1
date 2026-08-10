# Returns the user members of an AD group as a JSON array.
#
# CRITICAL: Import-Module ActiveDirectory can emit a WARNING ("Unable to find a
# default server with Active Directory Web Services running") while trying to
# auto-mount the AD: drive. If that text leaks to stdout it becomes the whole
# response, the runner's JSON.parse fails, and the renderer's toArray() sees a
# string → empty user list. So we silence the warning/progress streams and
# ALWAYS emit a clean JSON array (empty on any error) as the only stdout output.

param([string]$GroupName)

$WarningPreference  = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

# Guard an empty/null group name: -Identity $null makes Get-ADGroupMember ignore
# the -Server in @conn and fall back to the local AD: drive, which fails with a
# misleading "server down" error. Return an empty list instead.
if ([string]::IsNullOrWhiteSpace($GroupName)) {
  "[]"
  return
}

try {
  Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue

  . "$PSScriptRoot\_ADConn.ps1"
  $conn = Get-ADConn

  $members = @(
    Get-ADGroupMember @conn -Identity $GroupName -Recursive -WarningAction SilentlyContinue |
      Where-Object { $_.objectClass -eq "user" } |
      Get-ADUser @conn -Properties DisplayName, EmailAddress, Enabled, LockedOut -WarningAction SilentlyContinue |
      Select-Object SamAccountName, DisplayName, EmailAddress, Enabled, LockedOut
  )

  # Emit a literal empty array when there are no members — piping @() to
  # ConvertTo-Json writes nothing, which the runner can't parse as an array.
  if ($members.Count -eq 0) {
    "[]"
  } else {
    ConvertTo-Json -InputObject $members -Compress
  }
} catch {
  # Never leak an error string to stdout — keep the array contract intact.
  "[]"
}
