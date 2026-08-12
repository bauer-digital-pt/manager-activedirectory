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

. "$PSScriptRoot\_Common.ps1"

try {
  $ous = @(Get-ChildOUsAsGroups $BASE_OU)
  if ($ous.Count -eq 0) {
    "[]"
  } else {
    ConvertTo-Json -InputObject $ous -Compress
  }
} catch {
  $msg = Resolve-OUListError $_.Exception.Message $BASE_OU "BMAP Devices -> O365"
  ConvertTo-Json -InputObject @{ error = $msg } -Compress
  exit 1
}
