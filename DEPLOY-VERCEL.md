# Deploying the Elite server to Vercel + Neon Postgres

This puts the **server + admin panel + database in the cloud**, so every kiosk PC
shares one live database. The Electron kiosk app still runs on each PC — you just
point it at your new Vercel URL.

> The code is already on GitHub at **github.com/SameeerKhann/Elite**. Vercel
> deploys straight from there and re-deploys automatically on every `git push`.

---

## Step 1 — Create a Vercel account
1. Go to **https://vercel.com** → **Sign Up** → **Continue with GitHub**.
2. Authorize Vercel to access your GitHub.

## Step 2 — Import the project
1. In Vercel: **Add New… → Project**.
2. Find **Elite** in your repo list → **Import**.
3. **Leave Root Directory as the default (the repo root — do NOT set it to
   `server`).** The root `vercel.json` already points Vercel at the server code.
   > If you previously set Root Directory to `server`, change it back:
   > **Settings → General → Root Directory →** clear it / set to `./` → Save.
4. Don't deploy yet — add the database and env vars first (next steps). If it
   deploys now it'll just fail once; that's fine, you'll redeploy.

## Step 3 — Add the Neon Postgres database
1. Open your new project → **Storage** tab → **Create Database**.
2. Choose **Postgres (Neon)** → pick the free plan → **Create**, and **Connect**
   it to this project when asked.
3. This automatically adds the database connection (as `DATABASE_URL` /
   `POSTGRES_URL`) to your project's environment variables. You don't copy
   anything by hand.

## Step 4 — Add the other environment variables
Project → **Settings → Environment Variables**. Add these (Production scope):

| Name | Value |
|------|-------|
| `JWT_SECRET` | a long random string (e.g. from a password generator) |
| `SESSION_SECRET` | a *different* long random string |
| `ADMIN_USER` | the admin username you want (e.g. `admin`) |
| `ADMIN_PASS` | a strong admin password |
| `NODE_ENV` | `production` |

The first admin account is created automatically on first boot from
`ADMIN_USER` / `ADMIN_PASS`.

## Step 5 — Deploy
1. Go to the **Deployments** tab → **Redeploy** (or push any change to GitHub).
2. When it finishes you'll get a URL like **`https://elite-xxxx.vercel.app`**.
3. Visit **`https://elite-xxxx.vercel.app/admin`** and log in with your
   `ADMIN_USER` / `ADMIN_PASS`.
4. Set your **Websites (tabs)** and **allowed domains**, and add your employees.
   All of this now lives in the cloud Postgres database, shared by every PC.

---

## Step 6 — Point the kiosk PCs at the cloud server
On each PC, edit **`kiosk/config.json`** (or `config.local.json` while testing):

```json
{ "serverUrl": "https://elite-xxxx.vercel.app", "kioskMode": true }
```

Rebuild/redistribute the kiosk app and every PC now authenticates against the
cloud server and reads/writes the same shared database in real time.

---

## Notes
- **Passwords travel over HTTPS** — Vercel gives you HTTPS automatically. Good.
- **Local development still works unchanged:** with no `DATABASE_URL` set, the
  app uses a local SQLite file (`npm start`). Set `DATABASE_URL` locally only if
  you want to point your dev machine at the cloud database too.
- **Data lives in Neon, not GitHub.** GitHub has the code; Neon has the accounts,
  notes, and shift logs. Back up Neon (it has its own dashboard) if the data
  matters.
- **Updating the deployed app:** `git push` → Vercel redeploys automatically.
