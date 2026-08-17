<#
  Setup-Elite.ps1 - interactive installer / updater for the Elite Agent kiosk.

  Run this from your ADMIN account, in an elevated (Administrator) PowerShell.
  It will ask whether to Install or Update, and (for Install) which Windows
  "agent" account to lock down, its password, and whether to auto-login.

  Your admin account stays a normal Windows desktop. Log into the agent account
  to use the locked kiosk; agents then sign in with their own Elite login.
#>
[CmdletBinding()]
param(
  [string]$DownloadZip = 'https://github.com/SameeerKhann/elite-agent/releases/download/v0.1.0/Elite-Agent.zip',
  [string]$InstallDir = 'C:\Elite-Agent'
)
$ErrorActionPreference = 'Stop'
$wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'

function Set-Reg($Path, $Name, $Value, $Type = 'DWord') {
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}
function Get-AppZip {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $zip = Join-Path $env:TEMP 'Elite-Agent.zip'
  Write-Host "Downloading the app (about 100 MB)..." -ForegroundColor Cyan
  Invoke-WebRequest -Uri $DownloadZip -OutFile $zip -UseBasicParsing
  if ((Get-Item $zip).Length -lt 1000000) { throw "Download too small - GitHub may be temporarily unavailable. Try again shortly." }
  return $zip
}

try {
  $isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) { throw "Run this from an elevated (Administrator) PowerShell window." }

  Write-Host ""
  Write-Host "==== Elite Agent setup ====" -ForegroundColor Cyan
  Write-Host "  1) Install  - set up the locked kiosk on an agent account"
  Write-Host "  2) Update   - upgrade the app to the latest version"
  $action = (Read-Host "Enter 1 or 2").Trim()

  if ($action -eq '2') {
    # ---- UPDATE ----
    if (-not (Test-Path $InstallDir)) { throw "Elite is not installed yet. Choose Install (1) first." }
    $prevAuto = (Get-ItemProperty -Path $wl -Name AutoAdminLogon -ErrorAction SilentlyContinue).AutoAdminLogon
    Set-ItemProperty -Path $wl -Name AutoAdminLogon -Value "0"
    Write-Host "Stopping the running app..."
    taskkill /F /IM "Elite Agent.exe" 2>$null | Out-Null
    Start-Sleep -Seconds 3
    $zip = Get-AppZip
    Write-Host "Installing update..."
    Expand-Archive -Path $zip -DestinationPath $InstallDir -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    if ($prevAuto) { Set-ItemProperty -Path $wl -Name AutoAdminLogon -Value $prevAuto }
    Write-Host ""
    Write-Host "UPDATED. Reboot the PC to run the new version." -ForegroundColor Green
    return
  }

  # ---- INSTALL ----
  $KioskUser = (Read-Host "Name for the AGENT Windows account [agent]").Trim()
  if ([string]::IsNullOrWhiteSpace($KioskUser)) { $KioskUser = 'agent' }
  $secure = Read-Host "Set a password for the '$KioskUser' account" -AsSecureString
  $pwPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  if ([string]::IsNullOrWhiteSpace($pwPlain)) { throw "A password is required." }
  $autoLogin = ((Read-Host "Auto-login straight into the kiosk at startup? (y/N)").Trim() -match '^[Yy]')

  $zip = Get-AppZip
  Write-Host "Installing to $InstallDir ..."
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $InstallDir -Force
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  $AppPath = Join-Path $InstallDir 'Elite Agent.exe'
  if (-not (Test-Path $AppPath)) { throw "App not found after install: $AppPath" }
  Write-Host "Installed: $AppPath" -ForegroundColor Green

  # Create / update the agent account with the password you chose.
  if (-not (Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue)) {
    New-LocalUser -Name $KioskUser -Password $secure -FullName "Elite Agent" -Description "Elite kiosk account" -PasswordNeverExpires | Out-Null
    Add-LocalGroupMember -Group "Users" -Member $KioskUser
    Write-Host "Created agent account '$KioskUser'."
  } else {
    Set-LocalUser -Name $KioskUser -Password $secure
    Write-Host "Updated agent account '$KioskUser'."
  }
  $sid = (New-Object Security.Principal.NTAccount($KioskUser)).Translate([Security.Principal.SecurityIdentifier]).Value

  # Make the app the shell for the agent account (no desktop / taskbar).
  if (-not (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid")) {
    Write-Host "Priming the agent profile..."
    $cred = New-Object System.Management.Automation.PSCredential($KioskUser, $secure)
    try { Start-Process -FilePath "cmd.exe" -ArgumentList "/c exit" -Credential $cred -WindowStyle Hidden -Wait } catch {}
  }
  $userHive = "Registry::HKEY_USERS\$sid"; $hiveLoaded = $false
  if (-not (Test-Path $userHive)) {
    $ntuser = "C:\Users\$KioskUser\NTUSER.DAT"
    if (Test-Path $ntuser) { reg load "HKU\$sid" "$ntuser" | Out-Null; $hiveLoaded = $true }
    else { throw "Agent profile not ready. Sign into '$KioskUser' once, sign out, and run Install again." }
  }
  Set-Reg "$userHive\Software\Microsoft\Windows NT\CurrentVersion\Winlogon" "Shell" "`"$AppPath`"" 'String'
  $polSys = "$userHive\Software\Microsoft\Windows\CurrentVersion\Policies\System"
  $polExp = "$userHive\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"
  Set-Reg $polSys "DisableTaskMgr" 1
  Set-Reg $polSys "DisableRegistryTools" 1
  Set-Reg $polSys "DisableLockWorkstation" 1
  Set-Reg $polSys "DisableChangePassword" 1
  Set-Reg $polExp "NoWinKeys" 1
  Set-Reg $polExp "NoClose" 1
  if ($hiveLoaded) { [gc]::Collect(); reg unload "HKU\$sid" | Out-Null }

  # Auto-login only if requested. Otherwise the sign-in screen lets you pick
  # your admin account (normal Windows) or the agent account (kiosk).
  if ($autoLogin) {
    Set-Reg $wl "AutoAdminLogon" "1" 'String'
    Set-Reg $wl "DefaultUserName" $KioskUser 'String'
    Set-Reg $wl "DefaultPassword" $pwPlain 'String'
    Set-Reg $wl "DefaultDomainName" $env:COMPUTERNAME 'String'
  } else {
    Set-ItemProperty -Path $wl -Name "AutoAdminLogon" -Value "0" -ErrorAction SilentlyContinue
  }

  Write-Host ""
  Write-Host "DONE." -ForegroundColor Green
  Write-Host "-------------------------------------------------------------" -ForegroundColor DarkGray
  Write-Host "Agent (kiosk) account : $KioskUser" -ForegroundColor Cyan
  if ($autoLogin) { Write-Host "Startup               : boots straight into the locked kiosk" }
  else            { Write-Host "Startup               : sign-in screen - pick your admin account or '$KioskUser'" }
  Write-Host "-------------------------------------------------------------" -ForegroundColor DarkGray
  Write-Host "Log into '$KioskUser' to use the locked kiosk; agents sign in there with their own Elite login." -ForegroundColor Cyan
  Write-Host "Your admin account stays a normal Windows desktop." -ForegroundColor Cyan
  Write-Host "Sign out (or reboot) to try it." -ForegroundColor Yellow
}
catch {
  Write-Host ""
  Write-Host "SETUP FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
