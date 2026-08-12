# Searches AD users by a free-text query (name / username) and returns a small
# JSON array of matches. Used by the "Computador preparado para" picker in the PC
# onboarding page. Read-only.
#
# The query is operator-typed. It is embedded in the AD -Filter ONLY through a
# PowerShell variable ($q), never string-concatenated into the filter text, so a
# stray quote / parenthesis can't corrupt the filter (same safe pattern as
# Get-ADGroupMembers.ps1). We also strip control / filter metacharacters and cap
# the length, and require at least 2 characters so a broad wildcard scan is cheap.
#
# Contract with the runner (runPS): prints a JSON array on success; on failure
# prints { error } and exits 1 (matches Get-ADGroupMembers.ps1). A too-short or
# empty query is not an error — it just yields an empty list.
#
# ASCII-only string literals (PowerShell 5.1 reads a BOM-less .ps1 as ANSI). The
# incoming $Query is a real .NET string, so accents in names are preserved.

param([string]$Query)

$WarningPreference  = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

# Keep only letters/digits/space and the punctuation that legitimately appears in
# names (dot, hyphen, apostrophe, underscore). This both de-fangs the input and
# drops the '*' / '(' / ')' wildcard-and-filter metacharacters an operator might
# type by accident.
$Query = ($Query + "").Trim()
$Query = ($Query -replace "[^\p{L}\p{Nd} ._'-]", "").Trim()
if ($Query.Length -lt 2) { "[]"; return }
if ($Query.Length -gt 64) { $Query = $Query.Substring(0, 64) }

try {
  Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue

  . "$PSScriptRoot\_ADConn.ps1"
  $conn = Get-ADConn

  # Substring match on the human-facing fields. $q is a variable, so the AD
  # provider substitutes it as a value (no filter injection); the leading/trailing
  # '*' make it a "contains" search.
  $q = "*" + $Query + "*"
  $found = @(
    Get-ADUser @conn `
      -Filter 'DisplayName -like $q -or SamAccountName -like $q -or Name -like $q -or GivenName -like $q -or Surname -like $q' `
      -ResultSetSize 25 -Properties DisplayName, Enabled -WarningAction SilentlyContinue |
      Select-Object SamAccountName, DisplayName, Enabled |
      Sort-Object DisplayName
  )

  if ($found.Count -eq 0) {
    "[]"
  } else {
    # Force array shape: ConvertTo-Json unwraps a single object, which would make
    # the runner hand the renderer an object instead of a one-item array.
    ConvertTo-Json -InputObject @($found) -Compress
  }
} catch {
  @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
