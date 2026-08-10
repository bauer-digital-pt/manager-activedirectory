param(
  [string]$FirstName,
  [string]$LastName,
  [string]$Username,
  [string]$Password,
  [string]$GroupName,           # used for both OU path and Add-ADGroupMember (names are identical in this org)
  [string]$Description,
  [string]$Street,
  [string]$City,
  [string]$PostalCode,
  [string]$ChangePasswordAtLogon = "true",
  [string]$PasswordNeverExpires  = "false",
  [string]$JobTitle,
  [string]$Department,
  [string]$Company,
  [string]$Email
)
Import-Module ActiveDirectory -ErrorAction Stop
. "$PSScriptRoot\_ADConn.ps1"
$conn = Get-ADConn

$mustChange  = ($ChangePasswordAtLogon -eq "true")
$neverExpire = ($PasswordNeverExpires  -eq "true")

if ($mustChange -and $neverExpire) {
  @{ success = $false; error = "ChangePasswordAtLogon and PasswordNeverExpires cannot both be true." } | ConvertTo-Json -Compress
  exit 1
}

$securePass = ConvertTo-SecureString $Password -AsPlainText -Force
$ouPath     = "OU=$GroupName,OU=O365,OU=BMAP USERS,DC=bmap,DC=lis"

$newUserParams = @{
  GivenName             = $FirstName
  Surname               = $LastName
  Name                  = "$FirstName $LastName"
  DisplayName           = "$FirstName $LastName"
  SamAccountName        = $Username
  UserPrincipalName     = "$Username@$((Get-ADDomain @conn).DNSRoot)"
  AccountPassword       = $securePass
  Enabled               = $true
  PasswordNeverExpires  = $neverExpire
  ChangePasswordAtLogon = $mustChange
  Path                  = $ouPath
  Country               = "PT"
  OtherAttributes       = @{
    co          = "Portugal"
    countryCode = 620
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

try {
  New-ADUser @newUserParams @conn -ErrorAction Stop

  if ($GroupName) {
    Add-ADGroupMember @conn -Identity $GroupName -Members $Username -ErrorAction Stop
  }

  @{ success = $true; username = $Username } | ConvertTo-Json -Compress
} catch {
  @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
