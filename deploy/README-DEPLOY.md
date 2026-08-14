# Deploying the Windows lockdown

These scripts turn a PC into a locked DialerKiosk terminal. They target
**Windows 10/11 Pro** (no Enterprise/Assigned Access required).

> ⚠ **Test on a spare PC first.** A misconfigured kiosk can lock you out of the
> desktop. The scripts deliberately leave your **administrator account** normal
> so you can always switch to it from the sign-in screen and run the removal
> script — do not delete that admin account.

## What the lockdown does

For a dedicated `kiosk` Windows account only:
- Replaces the shell (`explorer.exe`) with `DialerKiosk.exe` → no desktop,
  taskbar, or Start menu; the kiosk app *is* the whole session.
- Disables Task Manager, Registry Editor, Win+L lock, and password change.
- Disables Windows hotkeys (`NoWinKeys`) and the shutdown option.
- Disables Fast User Switching and enables auto-logon into the kiosk account.

Your admin account keeps a normal Windows desktop.

## Steps per PC

1. Install the kiosk app (from `kiosk/npm run build` → the `.exe` installer).
   Note the installed path, e.g. `C:\Program Files\DialerKiosk\DialerKiosk.exe`.
2. Open **PowerShell as Administrator**.
3. Allow the script to run for this session:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   ```
4. Run setup:
   ```powershell
   .\Setup-Kiosk.ps1 -KioskUser kiosk -KioskPassword 'Strong-Pass!23' `
                     -AppPath 'C:\Program Files\DialerKiosk\DialerKiosk.exe'
   ```
5. **Reboot.** The PC auto-logs into the kiosk account and shows the DialerKiosk
   login screen full-screen.

## Managing a locked PC later

At the Windows sign-in screen, switch to your **admin account** (you may need to
press `Ctrl+Alt+Del`, which still works at the OS sign-in screen, then "Switch
user"). From there you can update the app, change settings, or remove the lock.

## Removing the lockdown

From an elevated PowerShell on the admin account:
```powershell
.\Remove-Kiosk.ps1 -KioskUser kiosk
# add -DeleteUser to also remove the kiosk account
```
Reboot to return to a normal desktop.

## Rolling out to many PCs

- Ship `DialerKiosk` installer + a `config.json` pointing at your server.
- Push `Setup-Kiosk.ps1` with the same parameters via your management tool
  (Intune, PDQ Deploy, a login script, or a USB stick + manual run).
- Because accounts are **central** (on the server), every PC uses the same
  employee logins with no per-PC user setup.

## Stronger option (Enterprise/Education only)

If your PCs run Windows **Enterprise** or **Education**, Windows' built-in
*Shell Launcher / Assigned Access* can host the kiosk app as the shell with
kernel-enforced restrictions. It's the most tamper-resistant option. Ask and
I'll add a `Setup-AssignedAccess.ps1` variant.
