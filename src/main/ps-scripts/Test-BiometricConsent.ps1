# Windows Hello presence check for the soft-lock unlock + kiosk re-auth gate.
# Called by the Electron main process on Windows only (macOS uses Electron's
# built-in Touch ID, no script).
#
#   args[0] = "check"  -> report whether a verifier (Hello PIN / face / finger)
#                         is configured for the current user, WITHOUT prompting.
#   args[0] = "verify" -> show the Hello prompt; args[1] is the reason text.
#
# IMPORTANT: this script ALWAYS writes a JSON result to stdout and exits 0, even
# on failure (see Test-ADCredential.ps1 for why). Failures are reported via
# { success = $false; error } instead of a non-zero exit.
#
# This proves PHYSICAL PRESENCE only, never knowledge of a password -- so the
# caller only accepts it while the session is still alive.
#
# NOTE: all output strings are ASCII-only on purpose. PowerShell 5.1 reads a
# BOM-less .ps1 as the system ANSI codepage, so accented literals corrupt on the
# wire and can break JSON.parse in the runner.
#
# STATUS: shipped but disabled by default (Definicoes -> Conexoes, "biometria").
# Enable and validate on a real domain PC with Hello configured before relying
# on it -- the WinRT UserConsentVerifier dialog may appear behind the app window
# on some Windows builds when launched from a non-foreground process.

$WarningPreference  = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

function Out-Result($obj) { $obj | ConvertTo-Json -Compress }

$mode    = if ($args.Count -ge 1) { "$($args[0])".Trim().ToLower() } else { "check" }
$message = if ($args.Count -ge 2 -and $args[1]) { "$($args[1])" } else { "Confirm your identity" }

# WinRT IAsyncOperation -> .NET Task bridge (PowerShell 5.1 has no native await).
function Await($WinRtTask, $ResultType) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  $asTaskGeneric = $asTask.MakeGenericMethod($ResultType)
  $netTask = $asTaskGeneric.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

try {
  # The AsTask extension methods live in System.Runtime.WindowsRuntime.
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  # Project the WinRT type into this session.
  $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]

  $availType = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability]
  $avail = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) $availType
  $available = ($avail -eq [Windows.Security.Credentials.UI.UserConsentVerifierAvailability]::Available)

  if ($mode -eq "check") {
    Out-Result @{ success = $true; available = $available; state = "$avail" }
    return
  }

  if (-not $available) {
    Out-Result @{ success = $false; available = $false; error = "Windows Hello is not configured on this machine ($avail)." }
    return
  }

  $resType = [Windows.Security.Credentials.UI.UserConsentVerificationResult]
  $res = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($message)) $resType
  if ($res -eq [Windows.Security.Credentials.UI.UserConsentVerificationResult]::Verified) {
    Out-Result @{ success = $true; available = $true }
  } else {
    Out-Result @{ success = $false; available = $true; error = "Biometric verification cancelled or failed ($res)." }
  }
} catch {
  Out-Result @{ success = $false; available = $false; error = $_.Exception.Message }
}
