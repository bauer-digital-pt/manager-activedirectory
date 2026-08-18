param(
  [string]$FirstName,
  [string]$LastName,
  [string]$Username,
  [string]$Password,
  [string]$GroupName,           # category OU Name under O365 (and template lookup)
  [string]$Description,
  [string]$Street,
  [string]$City,
  [string]$PostalCode,
  [string]$ChangePasswordAtLogon = "true",
  [string]$PasswordNeverExpires  = "false",
  [string]$JobTitle,
  [string]$Department,
  [string]$Company,
  [string]$Email,
  [string]$CopyFromUser,       # optional: SamAccountName of a user in the OU to copy group memberships from
  [string]$EmployeeType        # AD 'employeeType' attribute (kept LAST so the positional args in main.ts stay stable)
)

# The account password is passed via the environment (NEW_USER_PASSWORD), not on
# the command line, so it never shows up in the process command line (visible to
# Sysmon / EDR / other users). Fall back to the positional param for safety.
if ($env:NEW_USER_PASSWORD) { $Password = $env:NEW_USER_PASSWORD }

Import-Module ActiveDirectory -ErrorAction Stop
. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

# Parent OU that holds the category folders. Kept in sync with Get-ADGroup-All.ps1.
$BASE_OU = "OU=O365,OU=BMAP USERS,DC=bmap,DC=lis"

# UPN / sign-in suffix. The AD domain DNS root is bmap.lis, but users sign in to
# Microsoft 365 with their routable address, so the UserPrincipalName suffix must
# be bauermedia.pt (a registered alternative UPN suffix in the forest) — NOT the
# AD DNS root. Kept in sync with the email domain in CreateUserWizard (buildEmail).
$UPN_SUFFIX = "bauermedia.pt"

$mustChange  = ($ChangePasswordAtLogon -eq "true")
$neverExpire = ($PasswordNeverExpires  -eq "true")

if ($mustChange -and $neverExpire) {
  @{ success = $false; error = "ChangePasswordAtLogon and PasswordNeverExpires cannot both be true." } | ConvertTo-Json -Compress
  exit 1
}

# AD caps SamAccountName at 20 characters; a longer value fails deep inside
# New-ADUser with a cryptic error, so reject it up front with a clear message.
# (all strings ASCII-only: PowerShell 5.1 reads a BOM-less .ps1 as ANSI.)
if ([string]::IsNullOrWhiteSpace($Username)) {
  @{ success = $false; error = "O nome de utilizador (SamAccountName) e obrigatorio." } | ConvertTo-Json -Compress
  exit 1
}
if ($Username.Length -gt 20) {
  @{ success = $false; error = "O nome de utilizador (SamAccountName) nao pode ter mais de 20 caracteres." } | ConvertTo-Json -Compress
  exit 1
}

# Resolve the target category OU by its Name under the O365 base instead of
# string-building a DN from $GroupName. A name with a comma/quote/backslash would
# otherwise corrupt the DN (and the Path binding); -Filter binds the value safely.
try {
  $ou = Get-ADOrganizationalUnit @conn -SearchBase $BASE_OU -SearchScope OneLevel `
          -Filter 'Name -eq $GroupName' -ErrorAction Stop | Select-Object -First 1
} catch {
  @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
if (-not $ou) {
  @{ success = $false; error = "Nao foi encontrada a pasta (OU) '$GroupName' em O365." } | ConvertTo-Json -Compress
  exit 1
}
$ouPath = $ou.DistinguishedName

$securePass = ConvertTo-SecureString $Password -AsPlainText -Force

$newUserParams = @{
  GivenName             = $FirstName
  Surname               = $LastName
  Name                  = "$FirstName $LastName"
  DisplayName           = "$FirstName $LastName"
  SamAccountName        = $Username
  UserPrincipalName     = "$Username@$UPN_SUFFIX"
  AccountPassword       = $securePass
  Enabled               = $true
  PasswordNeverExpires  = $neverExpire
  ChangePasswordAtLogon = $mustChange
  Path                  = $ouPath
  Country               = "PT"
  OtherAttributes       = @{
    co                  = "Portugal"
    countryCode         = 620
    msExchUsageLocation = "PT"
  }
}

if ($Street)      { $newUserParams.StreetAddress = $Street }
if ($City)        { $newUserParams.City = $City; $newUserParams.Office = $City }
if ($PostalCode)  { $newUserParams.PostalCode    = $PostalCode }
if ($Description) { $newUserParams.Description   = $Description }
if ($JobTitle)    { $newUserParams.Title         = $JobTitle }
if ($Department)  { $newUserParams.Department    = $Department }
if ($Company)     { $newUserParams.Company       = $Company }
if ($Email)       { $newUserParams.EmailAddress  = $Email }
# employeeType has no dedicated New-ADUser parameter; it goes through
# -OtherAttributes (alongside co/countryCode/msExchUsageLocation set above).
if ($EmployeeType) { $newUserParams.OtherAttributes['employeeType'] = $EmployeeType }

# Create the account first. Only a failure HERE is a creation failure.
try {
  New-ADUser @newUserParams @conn -ErrorAction Stop
} catch {
  @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}

# The account now exists. Copying group memberships from a template user is
# best-effort: a failure here must NOT report the whole creation as failed —
# that left an orphaned account behind, and the retry then hit "already exists".
# Any problem is surfaced as a warning on an otherwise-successful result.
$copiedGroups = 0
$copyWarning  = $null
if ($CopyFromUser) {
  try {
    $tmpl = Get-ADUser @conn -Identity $CopyFromUser -Properties MemberOf -ErrorAction Stop
    foreach ($groupDN in @($tmpl.MemberOf)) {
      try {
        Add-ADGroupMember @conn -Identity $groupDN -Members $Username -ErrorAction Stop
        $copiedGroups++
      } catch {
        # Skip groups we can't write to (built-in / primary) rather than failing.
      }
    }
  } catch {
    $copyWarning = "Conta criada, mas nao foi possivel copiar os grupos de '$CopyFromUser': " + $_.Exception.Message
  }
}

$result = @{ success = $true; username = $Username; copiedGroups = $copiedGroups }
if ($copyWarning) { $result.warning = $copyWarning }
$result | ConvertTo-Json -Compress
