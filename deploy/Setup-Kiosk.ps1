<#
.SYNOPSIS
  Turns this PC into a locked DialerKiosk terminal for a dedicated kiosk user.

.DESCRIPTION
  Works on Windows 10/11 Pro (does not require Enterprise/Assigned Access).
  For a dedicated local "kiosk" account it:
    * Creates the account (if missing) and enables auto-logon.
    * Replaces that account's shell (explorer.exe) with DialerKiosk.exe, so the
      desktop, taskbar and Start menu never load for kiosk users.
    * Applies hardening: disables Task Manager, Win hotkeys, Ctrl+Alt+Del menu
      options, lock/switch-user, registry editor, and Fast User Switching.

  Your OWN administrator account is left completely normal so you can still
  manage the machine. Log in as the admin (switch user from the sign-in screen)
  to make changes or run Remove-Kiosk.ps1.

  RUN AS ADMINISTRATOR.  Test on a spare PC before rolling out widely.

.PARAMETER KioskUser
  Local Windows account the kiosk runs under. Created if it doesn't exist.

.PARAMETER KioskPassword
  Password for that account (used for auto-logon). Use a strong value.

.PARAMETER AppPath
  Full path to the installed DialerKiosk.exe.

.EXAMPLE
  .\Setup-Kiosk.ps1 -KioskUser kiosk -KioskPassword 'S0me-Strong-Pass!' `
                    -AppPath 'C:\Program Files\DialerKiosk\DialerKiosk.exe'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$KioskUser,
  [Parameter(Mandatory)] [string]$KioskPassword,
  [Parameter(Mandatory)] [string]$AppPath
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Please run this script from an elevated (Administrator) PowerShell window."
  }
}

Assert-Admin

if (-not (Test-Path $AppPath)) {
  throw "AppPath not found: $AppPath  (install the kiosk app first)"
}

Write-Host "== DialerKiosk lockdown ==" -ForegroundColor Cyan

# 1) Create the kiosk local account if it doesn't exist -----------------------
$secure = ConvertTo-SecureString $KioskPassword -AsPlainText -Force
if (-not (Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue)) {
  Write-Host "Creating local user '$KioskUser'..."
  New-LocalUser -Name $KioskUser -Password $secure -FullName "Dialer Kiosk" `
                -Description "DialerKiosk shift account" -PasswordNeverExpires | Out-Null
  Add-LocalGroupMember -Group "Users" -Member $KioskUser
} else {
  Write-Host "User '$KioskUser' already exists — updating password."
  Set-LocalUser -Name $KioskUser -Password $secure
}

# Resolve the account SID (needed to edit its registry hive).
$sid = (New-Object Security.Principal.NTAccount($KioskUser)).Translate([Security.Principal.SecurityIdentifier]).Value
Write-Host "Kiosk user SID: $sid"

# 2) Replace the shell for that user (per-user, not machine-wide) --------------
# We load the user's registry hive so we can set it even before first login.
$profileList = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid"
$hiveLoaded = $false
if (-not (Test-Path $profileList)) {
  # Profile not created yet: create it by loading a fresh NTUSER.DAT is complex,
  # so instead we log the user on once silently is not trivial. Simplest reliable
  # path: ensure the profile exists by starting a throwaway process as that user.
  Write-Host "Priming user profile for '$KioskUser' (first-time)..."
  $cred = New-Object System.Management.Automation.PSCredential($KioskUser, $secure)
  try {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c exit" -Credential $cred -WindowStyle Hidden -Wait
  } catch {
    Write-Warning "Could not prime profile automatically. Log in as '$KioskUser' once, log out, then re-run this script."
  }
}

$userHive = "Registry::HKEY_USERS\$sid"
if (-not (Test-Path $userHive)) {
  $ntuser = "C:\Users\$KioskUser\NTUSER.DAT"
  if (Test-Path $ntuser) {
    reg load "HKU\$sid" "$ntuser" | Out-Null
    $hiveLoaded = $true
  } else {
    throw "Cannot find the kiosk user's registry hive. Log in as '$KioskUser' once, log out, and re-run."
  }
}

function Set-Reg([string]$Path, [string]$Name, $Value, [string]$Type = 'DWord') {
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}

$winlogon = "$userHive\Software\Microsoft\Windows NT\CurrentVersion\Winlogon"
Set-Reg $winlogon "Shell" "`"$AppPath`"" 'String'
Write-Host "Shell for '$KioskUser' set to DialerKiosk." -ForegroundColor Green

# 3) Per-user hardening (Policies) --------------------------------------------
$polSys = "$userHive\Software\Microsoft\Windows\CurrentVersion\Policies\System"
$polExp = "$userHive\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"

Set-Reg $polSys "DisableTaskMgr" 1          # no Task Manager
Set-Reg $polSys "DisableRegistryTools" 1    # no regedit
Set-Reg $polSys "DisableLockWorkstation" 1  # no Win+L lock screen
Set-Reg $polSys "DisableChangePassword" 1
Set-Reg $polExp "NoWinKeys" 1               # disable most Win+<key> hotkeys
Set-Reg $polExp "NoClose" 1                 # no shutdown from the app
Set-Reg $polExp "NoLogoff" 0                # keep logoff possible (logout ends shift)

if ($hiveLoaded) {
  [gc]::Collect()
  reg unload "HKU\$sid" | Out-Null
}

# 4) Machine-wide hardening ----------------------------------------------------
# Disable Fast User Switching so kiosk users can't jump between accounts.
Set-Reg "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" "HideFastUserSwitching" 1

# 5) Auto-logon for the kiosk user --------------------------------------------
$wl = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
Set-Reg $wl "AutoAdminLogon" "1" 'String'
Set-Reg $wl "DefaultUserName" $KioskUser 'String'
Set-Reg $wl "DefaultPassword" $KioskPassword 'String'
Set-Reg $wl "DefaultDomainName" $env:COMPUTERNAME 'String'
Write-Warning "Auto-logon stores the kiosk password in the registry (standard Windows behaviour). Keep this account low-privilege."

Write-Host ""
Write-Host "Done. Reboot to start the kiosk." -ForegroundColor Green
Write-Host "To manage the PC later: at the sign-in screen switch to your admin account." -ForegroundColor Yellow
Write-Host "To undo everything: run Remove-Kiosk.ps1 -KioskUser $KioskUser" -ForegroundColor Yellow
