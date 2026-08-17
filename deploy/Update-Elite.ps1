<#
  Update-Elite.ps1 - update an already-installed Elite Agent kiosk PC to the
  latest app version. It ONLY swaps in the new app files; it does NOT change the
  kiosk account, the lockdown, or auto-login.

  RUN AS ADMINISTRATOR. Best run from your admin account (Ctrl+Alt+Del, Switch
  user) so the kiosk session's app can be replaced cleanly. After it finishes,
  reboot the PC to start the new version.
#>
[CmdletBinding()]
param(
  [string]$DownloadUrl = 'https://github.com/SameeerKhann/elite-agent/releases/download/v0.1.0/Elite-Agent.zip',
  [string]$InstallDir = 'C:\Elite-Agent'
)
$ErrorActionPreference = 'Stop'
$wl = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"

try {
  $isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) { throw "Run this from an elevated (Administrator) PowerShell window." }
  if (-not (Test-Path $InstallDir)) { throw "Elite is not installed at $InstallDir. Run Install-Elite.ps1 first." }

  Write-Host "== Elite Agent update ==" -ForegroundColor Cyan

  # Pause auto-login so the kiosk app can't relaunch and lock files mid-update.
  $prevAuto = (Get-ItemProperty -Path $wl -Name AutoAdminLogon -ErrorAction SilentlyContinue).AutoAdminLogon
  Set-ItemProperty -Path $wl -Name AutoAdminLogon -Value "0"

  Write-Host "Stopping the running app..."
  taskkill /F /IM "Elite Agent.exe" 2>$null | Out-Null
  Start-Sleep -Seconds 3

  Write-Host "Downloading latest app..." -ForegroundColor Cyan
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $zip = Join-Path $env:TEMP 'Elite-Agent-update.zip'
  Invoke-WebRequest -Uri $DownloadUrl -OutFile $zip -UseBasicParsing
  if ((Get-Item $zip).Length -lt 1000000) { throw "Download too small - GitHub may be temporarily unavailable. Try again shortly." }

  Write-Host "Installing update to $InstallDir ..."
  Expand-Archive -Path $zip -DestinationPath $InstallDir -Force
  Remove-Item $zip -Force -ErrorAction SilentlyContinue

  Set-ItemProperty -Path $wl -Name AutoAdminLogon -Value $(if ($prevAuto) { $prevAuto } else { "1" })

  Write-Host ""
  Write-Host "UPDATED. Reboot this PC to run the new version." -ForegroundColor Green
}
catch {
  Write-Host ""
  Write-Host "UPDATE FAILED: $($_.Exception.Message)" -ForegroundColor Red
  try { Set-ItemProperty -Path $wl -Name AutoAdminLogon -Value "1" } catch {}
  exit 1
}
