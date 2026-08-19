# Setting up a new Windows PC as an Elite kiosk

Runbook for turning a normal Windows 10/11 **Pro** machine into a locked Elite Agent
terminal, and for looking after it afterwards.

---

## ⚠ Before you roll out

**Rebuild and republish the app before setting up any new machine.**

The setup scripts download a prebuilt app from the `elite-agent` releases. That asset
predates the code on this branch, so a fresh install would not include these changes —
including the exit-code handling, which must be configured at build time.

**Order: do Part 1 once, then Part 2 per machine.**

---

## Part 1 — Rebuild and publish the app (once)

Do this on a **Windows PC** if you can. Building a Windows app on macOS is possible but
needs Wine, and it is not worth the trouble for a one-off.

You need: Node.js 20 or newer, Git, and write access to the `elite-agent` repository.

### 1. Get the fixed code

```powershell
git clone https://github.com/SameeerKhann/Elite.git
cd Elite
git checkout security/harden-admin-and-exit-code
```

If that branch has not been pushed yet, apply the patch file instead:

```powershell
git am < 0001-Remove-hardcoded-admin-verify-exit-code-in-main-proc.patch
```

### 2. Check the server URL

Open `kiosk/config.json` and confirm `serverUrl` points at your live server:

```json
{
  "serverUrl": "https://elite-l9b8.vercel.app",
  "kioskMode": true,
  "allowDevTools": false,
  "exitCodeSalt": "",
  "exitCodeHash": ""
}
```

`exitCodeSalt` and `exitCodeHash` are intentionally empty in the repository. The next
step fills them in locally. Never commit a real pair.

### 3. Set the exit code — do not skip this

```powershell
cd kiosk
npm install
npm run set-exit-code
```

It asks for the code twice and never prints or stores it in plain text — only a random
salt and a scrypt hash go into `config.json`. **Write the code down somewhere safe now.**
It cannot be recovered from the file.

Rules the script enforces: at least 10 characters, and previously-retired codes are refused.

If you skip this step the installed kiosks have no exit code at all. The "Close kiosk"
option hides itself and the only way back into a machine is the Windows administrator
account. That still works, but it is a pointless hassle.

### 4. Build

```powershell
npm run build
```

This produces `kiosk/dist/`. The deploy scripts expect a **zip whose top level contains
`Elite Agent.exe`** — that is the contents of `dist/win-unpacked/`, not the folder itself.

The cleanest way is to have electron-builder emit the zip directly. In `kiosk/package.json`,
change the Windows target:

```json
"win": { "target": ["nsis", "zip"] }
```

Then rebuild. Confirm before uploading:

```powershell
# Elite Agent.exe must appear at the ROOT of the zip listing, not inside a subfolder
```

### 5. Publish it

Upload the zip as `Elite-Agent.zip` and **replace the existing asset on the `v0.1.0`
release**.

Replacing the asset rather than creating a `v0.2.0` release is deliberate: the version is
hardcoded in `Setup-Elite.ps1`, `Install-Elite.ps1`, `Update-Elite.ps1` *and* in the admin
dashboard's copy-paste block in `server/views/templates.js`. Replacing the asset keeps
every one of those URLs working. If you do publish a new version tag, you must update all
four places.

Also upload the updated `Setup-Elite.ps1` from `deploy/` alongside it.

### 6. Smoke test on ONE machine

The Electron 31 → 43 upgrade changes the browser engine on every PC. Run Part 2 on a
single spare machine and check the dialer, the tabs, the notes panel and Elite Internal
chat all behave before touching the fleet.

---

## Part 2 — Set up a new PC (per machine, ~10 minutes)

### What you need on the machine

- Windows 10 or 11 **Pro** (Home cannot do per-user shell replacement)
- A **local administrator account that you keep** — this is your way back in
- Internet access (it downloads ~100 MB)

> **Never delete the administrator account.** The scripts deliberately leave it as a
> normal Windows desktop. It is the recovery path for everything below.

### Run it

Sign in as the administrator, open **PowerShell as Administrator** (right-click →
Run as administrator), and run:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
Invoke-WebRequest "https://github.com/SameeerKhann/elite-agent/releases/download/v0.1.0/Setup-Elite.ps1" -OutFile "$env:TEMP\Setup-Elite.ps1" -UseBasicParsing
& "$env:TEMP\Setup-Elite.ps1"
```

It will ask you four things:

| Prompt | What to answer |
|---|---|
| `Install (1)` or `Update (2)` | **1** |
| Name for the agent Windows account | press Enter for `agent`, or pick your own |
| Password for that account | a strong one — see the auto-login note below |
| Auto-login into the kiosk at startup? | **y** for a dedicated kiosk, **N** for a shared machine |

Then **reboot**.

- With auto-login **on**: the PC boots straight into the fullscreen Elite login.
- With auto-login **off**: you get the normal Windows sign-in screen and choose either
  the agent account (locked kiosk) or your admin account (normal desktop).

### What the script actually does

It downloads to a staging folder first, retries up to 3 times, and refuses anything under
90 MB — so a half-finished download cannot break a working kiosk. Only once it has a
verified complete copy does it swap `C:\Elite-Agent` into place.

Then, **for the agent account only**:

- Replaces the Windows shell with `Elite Agent.exe` — no desktop, no taskbar, no Start menu
- Disables Task Manager, Registry Editor, Win+L lock, and password change
- Disables the Windows hotkeys (`NoWinKeys`) and the shutdown option (`NoClose`)

And machine-wide, if you chose auto-login: sets `AutoAdminLogon` with the account name and
password.

Your administrator account is untouched.

---

## After setup — check these

1. Reboot. You should land on the fullscreen Elite login.
2. Sign in with a real agent login (created in the admin panel under **Employees** — this
   is a different account from the Windows `agent` account).
3. Confirm the dialer tab loads and that typing another web address goes nowhere.
4. Confirm Alt+Tab, the Windows key, and Ctrl+Shift+Esc do nothing.
5. Click **End shift & log out** — you should return to the login screen.
6. On the login screen click **Close kiosk**, enter your exit code, and confirm the
   normal Windows desktop comes back. Reboot returns it to the locked kiosk.
7. In the admin panel Dashboard, confirm the session appeared under who's on shift.

---

## Managing the PC later

### Getting back to a normal desktop

At the Windows sign-in screen press **Ctrl+Alt+Del → Switch user** and pick your
administrator account. `Ctrl+Alt+Del` still works at the OS sign-in screen — the lockdown
is per-user and does not apply to your admin account.

### Updating the app

From the admin account, elevated PowerShell — same three lines as Part 2, but answer **2**
at the first prompt.

Use `Setup-Elite.ps1` for updates, not `Update-Elite.ps1`. Both exist, but
`Setup-Elite.ps1` downloads and verifies to a staging folder before swapping;
`Update-Elite.ps1` extracts straight over the live install, so a failed download can leave
a broken app on the machine.

Reboot afterwards.

### Removing the lockdown completely

From the admin account, elevated PowerShell, in the `deploy/` folder:

```powershell
.\Remove-Kiosk.ps1 -KioskUser agent
# add -DeleteUser to also delete the agent Windows account
```

This restores the shell, removes the hardening, turns off auto-login, clears the stored
password and re-enables fast user switching. Reboot to get a normal desktop.

---

## Rolling out to many PCs

- Accounts are **central**, so every PC uses the same Elite employee logins. There is no
  per-PC user setup beyond the one Windows agent account.
- Push `Setup-Elite.ps1` through Intune, PDQ Deploy, a login script, or a USB stick.
- `Install-Elite.ps1` is the non-interactive variant — it generates a unique Windows
  account and a 20-character password per machine and always enables auto-login. Useful
  for scripted rollout, but see the warning below about the password file.

---

## Notes

**Auto-login stores the password in plain text.** Windows requires the auto-logon password
in the registry — that part is unavoidable. `Install-Elite.ps1` also writes it to
`C:\Elite-Agent\kiosk-account.txt`. Keep the agent account low-privilege (the scripts add
it to `Users` only), and consider deleting that file once the credentials are recorded
elsewhere.

**Admins can read all chat.** Every message, including one-to-one DMs, is visible at
`/admin/messages`. That is intended, but there is no notice in the agent UI and disclosure
is required in some jurisdictions — worth adding a line to the chat screen.

**Windows Enterprise / Education have a stronger option.** These scripts use per-user shell
replacement because it works on Pro. On Enterprise or Education, the built-in *Assigned
Access / Shell Launcher* is enforced by the OS and is considerably harder to escape.

---

## Troubleshooting

**"Agent profile not ready. Sign into 'agent' once, sign out, and run Install again."**
Windows has not created the user profile yet. Do exactly what it says, then re-run setup.

**Download fails or the app will not start after install.**
The script refuses downloads under 90 MB and retries 3 times. If it still fails, the PC's
connection to GitHub is the problem. Nothing is changed on a failed install — the existing
setup is left alone.

**Stuck in the kiosk with no working exit code.**
Reboot, and at the sign-in screen use Ctrl+Alt+Del → Switch user → your administrator
account. If auto-login sends you straight back into the kiosk, hold **Shift** while
Windows starts to reach the sign-in screen.

**The kiosk shows "Cannot reach server".**
Check `serverUrl` in the installed `config.json` and that the machine can reach the server
over HTTPS. The app writes a log to `C:\Elite-Agent\kiosk.log`.

---

## Quick reference

| Thing | Value |
|---|---|
| Install location | `C:\Elite-Agent` |
| App executable | `C:\Elite-Agent\Elite Agent.exe` |
| App log | `C:\Elite-Agent\kiosk.log` |
| Windows agent account | `agent` (default, chosen at install) |
| Admin panel | `https://elite-l9b8.vercel.app/admin` |
| Set a new exit code | `cd kiosk && npm run set-exit-code` |
| Manage admin accounts | `cd server && node scripts/admins.js list` |
