# Inspects the LOCAL machine (the PC the app is running on) and reports its
# onboarding state as JSON. Read-only: it changes nothing.
#
# "Onboarded" means every dimension already satisfies the standard:
#   - joined to the bmap.lis domain
#   - hostname matches PT-LPT-<DEPT>-<NUMBER>
#   - Cisco AnyConnect (Secure Client) installed
#   - ScreenConnect installed
#   - no pending Windows updates
#   - regional settings: OS display language English, region Portugal, PT keyboard
#
# Each probe is wrapped so one failure (e.g. Windows Update unreachable) degrades
# that single field to "unknown" instead of aborting the whole report.
#
# NOTE: all output strings are ASCII-only (PowerShell 5.1 reads a BOM-less .ps1
# as the system ANSI codepage; accented literals corrupt the JSON on the wire).

$WarningPreference  = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

$DEPARTMENTS = @("ADM","RCM","CDD","MKT","NWS","RTO","COM","DIG","EVT","HR","IT","LEG")
$NAME_PATTERN = "PT-LPT-<DEPT>-<NUMBER>"

function Test-InstalledApp([string]$pattern) {
  $keys = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($k in $keys) {
    try {
      $hit = Get-ItemProperty $k -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -and $_.DisplayName -match $pattern }
      if ($hit) { return $true }
    } catch { }
  }
  return $false
}

# --- Identity / domain ---
$hostname = $env:COMPUTERNAME
$domainJoined = $false
$domainName = ""
try {
  $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  $domainJoined = [bool]$cs.PartOfDomain
  $domainName = "$($cs.Domain)"
} catch { }

$deptAlt = ($DEPARTMENTS -join "|")
$nameCompliant = $hostname -match "^PT-LPT-($deptAlt)-\d+$"
$domainCompliant = $domainJoined -and ($domainName -ieq "bmap.lis")

# --- Software ---
$anyConnect = (Test-InstalledApp "Cisco AnyConnect") -or (Test-InstalledApp "Cisco Secure Client")
$screenConnect = (Test-InstalledApp "ScreenConnect") -or (Test-InstalledApp "ConnectWise Control")

# --- Windows Update ---
$wuChecked = $false
$wuPending = -1
try {
  $session  = New-Object -ComObject Microsoft.Update.Session
  $searcher = $session.CreateUpdateSearcher()
  $result   = $searcher.Search("IsInstalled=0 and Type='Software' and IsHidden=0")
  $wuPending = [int]$result.Updates.Count
  $wuChecked = $true
} catch { }
$wuUpToDate = ($wuChecked -and $wuPending -eq 0)

# --- Regional ---
$osLanguage = ""
$locale = ""
$geoId = -1
$geoName = ""
$keyboard = ""
try { $ov = Get-WinUILanguageOverride -ErrorAction SilentlyContinue; if ($ov) { $osLanguage = "$ov" } } catch { }
if (-not $osLanguage) { try { $osLanguage = (Get-UICulture).Name } catch { } }
try { $locale = (Get-Culture).Name } catch { }
try { $geoId = [int](Get-WinHomeLocation -ErrorAction Stop).GeoId } catch { }
if ($geoId -eq 193) { $geoName = "Portugal" }
try { $keyboard = "$((Get-WinUserLanguageList -ErrorAction Stop)[0].LanguageTag)" } catch { }

$regionalCompliant = ($osLanguage -like "en*") -and ($geoId -eq 193) -and (($keyboard -like "pt*") -or ($locale -like "pt*"))

$onboarded = $domainCompliant -and $nameCompliant -and $anyConnect -and $screenConnect -and $wuUpToDate -and $regionalCompliant

$out = @{
  hostname      = $hostname
  domain        = @{ joined = $domainJoined; name = $domainName; compliant = $domainCompliant }
  name          = @{ value = $hostname; compliant = $nameCompliant; pattern = $NAME_PATTERN }
  software      = @{ anyConnect = $anyConnect; screenConnect = $screenConnect }
  windowsUpdate = @{ checked = $wuChecked; pending = $wuPending; upToDate = $wuUpToDate }
  regional      = @{ osLanguage = $osLanguage; locale = $locale; geoId = $geoId; geo = $geoName; keyboard = $keyboard; compliant = $regionalCompliant }
  departments   = $DEPARTMENTS
  onboarded     = $onboarded
}

$out | ConvertTo-Json -Depth 5 -Compress
