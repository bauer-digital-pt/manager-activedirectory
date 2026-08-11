# Given a department code, works out the next available device name following the
# PT-LPT-<DEPT>-<NUMBER> convention. The NUMBER is the LOWEST FREE slot starting
# at 1 (gaps are filled: if 01 and 03 exist, this returns 02), zero-padded to two
# digits. The lookup is domain-wide (not scoped to any OU) so a name is never
# reused regardless of which folder a computer currently lives in.
#
# On success: { "dept": "IT", "number": "02", "name": "PT-LPT-IT-02" } + exit 0.
# On failure: { "error": "<friendly ASCII message>" } + exit 1.
# All output strings are ASCII-only (PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# so accented literals corrupt on the wire and can break JSON.parse in the runner).

param([string]$Dept)

$WarningPreference  = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

function Out-Result($obj) { $obj | ConvertTo-Json -Compress }
function Fail([string]$msg) { Out-Result @{ error = $msg }; exit 1 }

# Allow-list kept in sync with Get-PCStatus.ps1 ($DEPARTMENTS) and the renderer.
$DEPARTMENTS = @("ADM","RCM","CDD","MKT","NWS","RTO","COM","DIG","EVT","HR","IT","LEG")

$Dept = ($Dept + "").Trim().ToUpperInvariant()
if (-not $Dept) { Fail "Departamento em falta." }
if ($DEPARTMENTS -notcontains $Dept) { Fail ("Departamento invalido: " + $Dept + ".") }

try {
  Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue
  . "$PSScriptRoot\_ADConn.ps1"
  $conn = Get-ADConn
} catch {
  Fail ("Nao foi possivel carregar o modulo ActiveDirectory: " + $_.Exception.Message)
}

try {
  # Bind the wildcard through a variable so a (validated) dept code can't corrupt
  # the filter. Computer names in AD are matched case-insensitively.
  $pattern = "PT-LPT-$Dept-*"
  $computers = @(Get-ADComputer @conn -Filter 'Name -like $pattern' -ErrorAction Stop)
} catch {
  $raw = $_.Exception.Message
  $srv = if ($env:AD_SERVER) { $env:AD_SERVER } else { "o servidor AD" }
  if ($raw -match 'Web Services|ADServerDown|unable to contact|server is not operational|find(ing)? .*server') {
    Fail ("Nao foi possivel contactar o Active Directory Web Services em '$srv' (porta 9389). Confirma a ligacao/VPN e que o ADWS esta a correr.")
  }
  Fail $raw
}

# Collect the numeric suffixes already in use.
$used = @{}
foreach ($c in $computers) {
  if ($c.Name -match "^PT-LPT-$Dept-(\d+)$") {
    $used[[int]$matches[1]] = $true
  }
}

# Lowest free slot starting at 1.
$n = 1
while ($used.ContainsKey($n)) { $n++ }

$number = '{0:D2}' -f $n
Out-Result @{ dept = $Dept; number = $number; name = ("PT-LPT-$Dept-$number") }
exit 0
