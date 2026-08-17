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

# Download + extract + verify to a STAGING folder. Returns the folder that holds
# the app files. Never touches the live install until we know we have a good
# complete copy, so a bad download can't break an existing kiosk.
function Get-StagedApp {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $stageRoot = Join-Path $env:TEMP ('Elite-stage-' + [guid]::NewGuid().ToString('N'))
  $ok = $false
  for ($try = 1; $try -le 3 -and -not $ok; $try++) {
    $zip = Join-Path $env:TEMP ('Elite-Agent-' + [guid]::NewGuid().ToString('N') + '.zip')
    try {
      Write-Host "Downloading the app (about 100 MB) - attempt $try ..." -ForegroundColor Cyan
      Invoke-WebRequest -Uri $DownloadZip -OutFile $zip -UseBasicParsing
      $sz = (Get-Item $zip).Length
      if ($sz -lt 90000000) { throw ("Download incomplete: {0} MB (expected ~100 MB)." -f [math]::Round($sz / 1MB)) }
      if (Test-Path $stageRoot) { Remove-Item $stageRoot -Recurse -Force }
      Expand-Archive -Path $zip -DestinationPath $stageRoot -Force
      $exe = Get-ChildItem -Path $stageRoot -Recurse -Filter 'Elite Agent.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $exe) { throw "App exe missing after extract." }
      $ok = $true
    } catch {
      Write-Host ("  attempt {0} failed: {1}" -f $try, $_.Exception.Message) -ForegroundColor Yellow
      if (Test-Path $stageRoot) { Remove-Item $stageRoot -Recurse -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 3
    } finally {
      Remove-Item $zip -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not $ok) { throw "Could not download a complete copy of the app after 3 tries. Check this PC's internet and run again." }
  $exe = Get-ChildItem -Path $stageRoot -Recurse -Filter 'Elite Agent.exe' | Select-Object -First 1
  return $exe.Directory.FullName
}

# Atomically replace the install directory with a freshly staged copy.
function Swap-Install($appDir) {
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Move-Item -Path $appDir -Destination $InstallDir
  $exe = Join-Path $InstallDir 'Elite Agent.exe'
  if (-not (Test-Path $exe)) { throw "App not in place after install: $exe" }
  return $exe
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
    # ---- UPDATE (download + verify FIRST, then swap) ----
    if (-not (Test-Path $InstallDir)) { throw "Elite is not installed yet. Choose Install (1) first." }
    $appDir = Get-StagedApp
    $prevAuto = (Get-ItemProperty -Path $wl -Name AutoAdminLogon -ErrorAction SilentlyContinue).AutoAdminLogon
    Set-ItemProperty -Path $wl -Name AutoAdminLogon -Value "0"
    Write-Host "Stopping the running app..."
    taskkill /F /IM "Elite Agent.exe" 2>$null | Out-Null
    Start-Sleep -Seconds 3
    Swap-Install $appDir | Out-Null
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

  $appDir = Get-StagedApp
  $AppPath = Swap-Install $appDir
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
  Write-Host "Your existing install was left untouched. Fix the issue and run again." -ForegroundColor Yellow
  exit 1
}
