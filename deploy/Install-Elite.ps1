<#
.SYNOPSIS
  ONE-COMMAND kiosk setup for a single PC (Windows 10/11 Pro).

  Downloads the Elite Agent app, installs it to C:\Elite-Agent, and locks the PC
  so a dedicated auto-login account can ONLY use the Elite app — no desktop, no
  taskbar, no Start menu, no Task Manager. On boot the PC logs itself in and
  opens straight into Elite.

  Your OWN administrator account is left completely normal. To service the PC,
  switch to your admin account from the Windows sign-in screen (Ctrl+Alt+Del →
  Switch user). NEVER delete that admin account or you will lock yourself out.

  RUN AS ADMINISTRATOR. Test on one spare PC before rolling out to all 50.

.PARAMETER KioskPassword
  Password for the auto-login kiosk account (created automatically). Use the
  SAME strong value on every PC so they're easy to manage.

.PARAMETER KioskUser
  Name of the local auto-login account. Default: eliteagent.

.PARAMETER DownloadUrl
  Where to fetch the app zip. Defaults to the public release.

.EXAMPLE
  .\Install-Elite.ps1 -KioskPassword 'Elite-Kiosk-2026!'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$KioskPassword,
  [string]$KioskUser = 'eliteagent',
  [string]$DownloadUrl = 'https://github.com/SameeerKhann/elite-agent/releases/download/v0.1.0/Elite-Agent.zip',
  [string]$InstallDir = 'C:\Elite-Agent'
)
$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Please run this from an elevated (Administrator) PowerShell window."
  }
}
Assert-Admin
Write-Host "== Elite Agent — kiosk install ==" -ForegroundColor Cyan

# --- 1) Download + install the app ------------------------------------------
$zip = Join-Path $env:TEMP 'Elite-Agent.zip'
Write-Host "Downloading app..." -ForegroundColor Cyan
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $DownloadUrl -OutFile $zip -UseBasicParsing

Write-Host "Installing to $InstallDir ..."
if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $InstallDir -Force
Remove-Item $zip -Force -ErrorAction SilentlyContinue

$AppPath = Join-Path $InstallDir 'Elite Agent.exe'
if (-not (Test-Path $AppPath)) { throw "App not found after install: $AppPath" }
Write-Host "Installed: $AppPath" -ForegroundColor Green

# --- 2) Create the auto-login kiosk account ---------------------------------
$secure = ConvertTo-SecureString $KioskPassword -AsPlainText -Force
if (-not (Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue)) {
  New-LocalUser -Name $KioskUser -Password $secure -FullName "Elite Agent" `
                -Description "Elite kiosk account" -PasswordNeverExpires | Out-Null
  Add-LocalGroupMember -Group "Users" -Member $KioskUser
  Write-Host "Created kiosk user '$KioskUser'."
} else {
  Set-LocalUser -Name $KioskUser -Password $secure
  Write-Host "Updated kiosk user '$KioskUser'."
}
$sid = (New-Object Security.Principal.NTAccount($KioskUser)).Translate([Security.Principal.SecurityIdentifier]).Value

# --- 3) Make the app the shell for that account (no desktop/taskbar) ---------
# Prime the profile so its registry hive exists.
if (-not (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid")) {
  Write-Host "Priming kiosk profile..."
  $cred = New-Object System.Management.Automation.PSCredential($KioskUser, $secure)
  try { Start-Process -FilePath "cmd.exe" -ArgumentList "/c exit" -Credential $cred -WindowStyle Hidden -Wait } catch {}
}
$userHive = "Registry::HKEY_USERS\$sid"; $hiveLoaded = $false
if (-not (Test-Path $userHive)) {
  $ntuser = "C:\Users\$KioskUser\NTUSER.DAT"
  if (Test-Path $ntuser) { reg load "HKU\$sid" "$ntuser" | Out-Null; $hiveLoaded = $true }
  else { throw "Kiosk profile not ready. Sign in as '$KioskUser' once, sign out, and re-run." }
}
function Set-Reg($Path, $Name, $Value, $Type = 'DWord') {
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}
Set-Reg "$userHive\Software\Microsoft\Windows NT\CurrentVersion\Winlogon" "Shell" "`"$AppPath`"" 'String'

# --- 4) Hardening for the kiosk account -------------------------------------
$polSys = "$userHive\Software\Microsoft\Windows\CurrentVersion\Policies\System"
$polExp = "$userHive\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"
Set-Reg $polSys "DisableTaskMgr" 1
Set-Reg $polSys "DisableRegistryTools" 1
Set-Reg $polSys "DisableLockWorkstation" 1
Set-Reg $polSys "DisableChangePassword" 1
Set-Reg $polExp "NoWinKeys" 1
Set-Reg $polExp "NoClose" 1
if ($hiveLoaded) { [gc]::Collect(); reg unload "HKU\$sid" | Out-Null }

# --- 5) Machine settings: auto-login + no fast user switching ---------------
Set-Reg "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" "HideFastUserSwitching" 1
$wl = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
Set-Reg $wl "AutoAdminLogon" "1" 'String'
Set-Reg $wl "DefaultUserName" $KioskUser 'String'
Set-Reg $wl "DefaultPassword" $KioskPassword 'String'
Set-Reg $wl "DefaultDomainName" $env:COMPUTERNAME 'String'

Write-Host ""
Write-Host "DONE. Reboot to start the locked kiosk." -ForegroundColor Green
Write-Host "Manage this PC later: at sign-in, Ctrl+Alt+Del -> Switch user -> your admin account." -ForegroundColor Yellow
Write-Host "Undo everything: run Remove-Kiosk.ps1 -KioskUser $KioskUser" -ForegroundColor Yellow
