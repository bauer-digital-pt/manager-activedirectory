# Lists EVERY computer object under the BMAP Devices tree (O365 subtree) with the
# detail fields the Manager's read-only device list shows. Search is scoped to the
# device base and recurses into every department folder underneath it.
#
#   Base: OU=O365,OU=BMAP Devices,DC=bmap,DC=lis  (SearchScope Subtree)
#
# On success: a JSON array on stdout (or "[]" when empty), exit 0.
# On failure: { "error": "<friendly ASCII message>" } on stdout, exit 1 — a query
# failure is NEVER swallowed into an empty list (that would read as "no devices").
#
# All output strings are ASCII-only (PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# so accented literals corrupt on the wire and can break JSON.parse in the runner).

$WarningPreference  = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

# Root of the device tree. Kept in sync with Get-DeviceOU-All.ps1 ($BASE_OU) and
# Invoke-OnboardStep.ps1 ($DEVICE_BASE).
$BASE_OU = "OU=O365,OU=BMAP Devices,DC=bmap,DC=lis"

# Brings in Get-ADConn (connection splat) + Resolve-OUListError (friendly errors).
. "$PSScriptRoot\_Common.ps1"

try {
  Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue
  $conn = Get-ADConn

  $props = @(
    "DNSHostName","Enabled","OperatingSystem","OperatingSystemVersion",
    "LastLogonDate","whenCreated","Description","ManagedBy"
  )

  $devices = @(
    Get-ADComputer @conn -SearchBase $BASE_OU -SearchScope Subtree -Filter * -Properties $props -ErrorAction Stop |
      Sort-Object Name |
      ForEach-Object {
        # Department = the immediate parent OU folder. Strip the leading
        # "CN=<name>," off the DN, then take the first "OU=" component's value.
        $ou = $null
        if ($_.DistinguishedName -match '^CN=[^,]+,OU=([^,]+),') { $ou = $matches[1] }
        @{
          Name                   = $_.Name
          DNSHostName            = $_.DNSHostName
          Enabled                = [bool]$_.Enabled
          OperatingSystem        = $_.OperatingSystem
          OperatingSystemVersion = $_.OperatingSystemVersion
          Description            = $_.Description
          DistinguishedName      = $_.DistinguishedName
          ManagedBy              = $_.ManagedBy
          OU                     = $ou
          # [datetime] serializes as /Date(ms)/ via ConvertTo-Json; pre-stringify
          # to stable text (null when the attribute has never been set).
          LastLogonDate          = if ($_.LastLogonDate) { $_.LastLogonDate.ToString('yyyy-MM-dd HH:mm:ss') } else { $null }
          WhenCreated            = if ($_.whenCreated)   { $_.whenCreated.ToString('yyyy-MM-dd HH:mm:ss') }   else { $null }
        }
      }
  )

  if ($devices.Count -eq 0) {
    "[]"
  } else {
    # -InputObject @(...) keeps a single result an array (not a bare object).
    ConvertTo-Json -InputObject @($devices) -Compress
  }
} catch {
  $msg = Resolve-OUListError $_.Exception.Message $BASE_OU "BMAP Devices -> O365"
  ConvertTo-Json -InputObject @{ error = $msg } -Compress
  exit 1
}
