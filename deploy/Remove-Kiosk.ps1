<#
.SYNOPSIS
  Reverses Setup-Kiosk.ps1: restores the normal Windows shell and removes
  the hardening + auto-logon for the kiosk user.  RUN AS ADMINISTRATOR.

.EXAMPLE
  .\Remove-Kiosk.ps1 -KioskUser kiosk
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$KioskUser,
  [switch]$DeleteUser
)
$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this from an elevated (Administrator) PowerShell window."
}

$sid = (New-Object Security.Principal.NTAccount($KioskUser)).Translate([Security.Principal.SecurityIdentifier]).Value

$userHive = "Registry::HKEY_USERS\$sid"
$hiveLoaded = $false
if (-not (Test-Path $userHive)) {
  $ntuser = "C:\Users\$KioskUser\NTUSER.DAT"
  if (Test-Path $ntuser) { reg load "HKU\$sid" "$ntuser" | Out-Null; $hiveLoaded = $true }
}

if (Test-Path $userHive) {
  $winlogon = "$userHive\Software\Microsoft\Windows NT\CurrentVersion\Winlogon"
  if (Test-Path $winlogon) { Remove-ItemProperty -Path $winlogon -Name "Shell" -ErrorAction SilentlyContinue }

  foreach ($p in @(
    "$userHive\Software\Microsoft\Windows\CurrentVersion\Policies\System",
    "$userHive\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer")) {
    if (Test-Path $p) { Remove-Item -Path $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Write-Host "Restored normal shell + removed hardening for '$KioskUser'." -ForegroundColor Green
}

if ($hiveLoaded) { [gc]::Collect(); reg unload "HKU\$sid" | Out-Null }

# Remove auto-logon.
$wl = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
Set-ItemProperty -Path $wl -Name "AutoAdminLogon" -Value "0" -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $wl -Name "DefaultPassword" -ErrorAction SilentlyContinue

# Restore Fast User Switching.
Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" `
  -Name "HideFastUserSwitching" -Value 0 -ErrorAction SilentlyContinue

if ($DeleteUser) {
  Remove-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue
  Write-Host "Deleted local user '$KioskUser'." -ForegroundColor Yellow
}

Write-Host "Reboot to return to a normal desktop." -ForegroundColor Green
