# DialerKiosk

Lock company PCs so employees can **only use one web app (the Dialer)** after
logging in for their shift — no other websites, no desktop, no other software.
Accounts are managed centrally, and every login/logout is recorded.

## How it fits together

```
                 ┌────────────────────────────┐
                 │        Central Server        │   (one machine / VPS)
                 │  • Admin panel (web)         │
                 │  • Employee accounts         │
                 │  • Auth API + shift log      │
                 │  • SQLite database           │
                 └──────────────┬───────────────┘
                                │  HTTPS
        ┌───────────────────────┼───────────────────────┐
        │                       │                        │
   ┌────▼────┐             ┌────▼────┐              ┌────▼────┐
   │  PC #1  │             │  PC #2  │      ...     │  PC #N  │
   │ Kiosk   │             │ Kiosk   │              │ Kiosk   │
   │ client  │             │ client  │              │ client  │
   └─────────┘             └─────────┘              └─────────┘
   Fullscreen login → opens ONLY the Dialer. Desktop & other sites blocked.
```

Three pieces, in three folders:

| Folder | What it is |
|--------|-----------|
| [`server/`](server) | Node.js server: admin panel, account management, login API, shift logging. Runs on one machine everyone can reach. |
| [`kiosk/`](kiosk) | Electron desktop app installed on every employee PC. Shows the login screen, then locks the screen to the Dialer. |
| [`deploy/`](deploy) | PowerShell scripts that harden Windows so employees genuinely can't escape the kiosk. |

**Two layers of lockdown.** The kiosk app blocks in-app escapes (other sites,
reload, devtools, popups). The Windows scripts block OS escapes (Alt+Tab,
Windows key, Task Manager, Ctrl+Alt+Del menu, desktop). You need **both** for a
true "can't get out" kiosk.

---

## Quick start (test it on your own PC in ~10 min)

### 1. Run the server

```bash
cd server
npm install
copy .env.example .env        # then edit .env (set DIALER_URL and secrets)
npm run init-admin            # create your admin login (prompts for user/pass)
npm start
```

Open **http://localhost:4000/admin**, sign in, and:
- On the **Dashboard**, set the **Dialer URL** and **Allowed domains**.
- On **Employees**, add a test employee (username + temporary password).

### 2. Run the kiosk client

```bash
cd kiosk
npm install
# edit config.json -> "serverUrl" should point at your server
#   (use "http://localhost:4000" while testing on the same PC)
npm start
```

A fullscreen login appears. Log in with the test employee → the Dialer opens
locked. Click **End shift & log out** to return to the login screen. Back in the
admin panel, **Shift Log** now shows that session.

> While testing, set `"kioskMode": false` in `kiosk/config.json` so the window
> isn't fullscreen/locked and you can close it normally with the title bar.

---

## Cloud deployment (shared database for all PCs)

To host the server + database in the cloud so every PC shares one live database,
see **[DEPLOY-VERCEL.md](DEPLOY-VERCEL.md)** (Vercel + Neon Postgres). The data
layer is dual-mode: **Postgres in the cloud**, **SQLite locally** — the same code
runs both places.

## Going live

1. **Host the server** somewhere every PC can reach (a small VPS or an office
   server). Put it behind **HTTPS** — the kiosk sends passwords to it.
2. **Build the installer:** `cd kiosk && npm run build` produces a Windows
   installer in `kiosk/dist/`. Set `config.json` `serverUrl` to your real
   server URL **before** building (or ship a `config.json` beside the .exe).
3. **Install on each PC**, then run the lockdown — see [`deploy/README-DEPLOY.md`](deploy/README-DEPLOY.md).

---

## Security notes / honest limitations

- **Windows edition:** these scripts use per-user shell replacement, which works
  on **Windows 10/11 Pro**. If you have **Enterprise/Education**, the built-in
  *Assigned Access / Shell Launcher* is even stronger — ask and I'll add that path.
- **Always keep a separate admin account** on each PC (the scripts never touch
  it) so you can get back in. Losing this locks you out of your own machine.
- **Use HTTPS in production.** Over plain HTTP, passwords travel in the clear.
- Change `JWT_SECRET` and `SESSION_SECRET` in `.env` to long random strings.
- Auto-logon stores the kiosk account password in the registry (a Windows
  requirement for auto-logon). Keep that account low-privilege.

## What's built vs. what's next

**Built and runnable now:** server + admin panel + accounts + auth API + shift
logging + Electron kiosk client (login → locked Dialer → logout) + Windows
lockdown/removal scripts + docs.

**Typical follow-ups:** code-signing the installer, an "Assigned Access" path for
Enterprise, idle auto-logout, per-PC assignment/reporting, and central push of
config changes without re-login. Say the word and I'll add them.
