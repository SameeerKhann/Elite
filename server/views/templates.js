// Simple server-rendered HTML for the admin panel. No build step required.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const STYLE = `
  :root { --bg:#0f172a; --card:#1e293b; --line:#334155; --text:#e2e8f0; --muted:#94a3b8;
          --accent:#3b82f6; --good:#22c55e; --bad:#ef4444; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         background:var(--bg); color:var(--text); }
  a { color:var(--accent); text-decoration:none; }
  .wrap { max-width:1000px; margin:0 auto; padding:24px; }
  header.top { display:flex; align-items:center; justify-content:space-between;
               border-bottom:1px solid var(--line); padding:16px 24px; background:var(--card); }
  header.top .brand { font-weight:700; font-size:18px; }
  nav a { margin-right:18px; color:var(--muted); font-weight:600; }
  nav a.active { color:var(--text); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:20px; }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
  .stat { text-align:center; }
  .stat .n { font-size:34px; font-weight:800; }
  .stat .l { color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:.5px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); font-size:14px; }
  th { color:var(--muted); font-weight:600; }
  input, button, select { font:inherit; }
  input[type=text], input[type=password], textarea { background:#0b1220; border:1px solid var(--line); color:var(--text);
        border-radius:8px; padding:9px 11px; width:100%; font:inherit; }
  textarea { resize:vertical; line-height:1.5; }
  .help { margin-top:10px; font-size:13px; color:var(--muted); line-height:1.7;
          background:rgba(59,130,246,.07); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  code { background:#0b1220; border:1px solid var(--line); border-radius:5px; padding:1px 5px; font-size:12px; }
  label { display:block; font-size:13px; color:var(--muted); margin:10px 0 4px; }
  .btn { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:9px 14px; cursor:pointer; font-weight:600; }
  .btn.small { padding:5px 10px; font-size:13px; }
  .btn.ghost { background:transparent; border:1px solid var(--line); color:var(--text); }
  .btn.danger { background:var(--bad); }
  .row { display:flex; gap:10px; align-items:end; flex-wrap:wrap; }
  .row > div { flex:1; min-width:160px; }
  .pill { padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; }
  .pill.on { background:rgba(34,197,94,.15); color:var(--good); }
  .pill.off { background:rgba(239,68,68,.15); color:var(--bad); }
  .flash { background:rgba(59,130,246,.12); border:1px solid var(--accent); padding:10px 14px; border-radius:8px; margin-bottom:16px; }
  .muted { color:var(--muted); }
  form.inline { display:flex; gap:6px; align-items:center; }
  form.inline input { width:140px; }
`;

function layout(title, admin, body) {
  const nav = (href, label, active) =>
    `<a href="${href}" class="${active ? 'active' : ''}">${label}</a>`;
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(title)} · DialerKiosk</title><style>${STYLE}</style></head><body>
    <header class="top">
      <div class="brand">🔒 DialerKiosk Admin</div>
      <nav>
        ${nav('/admin', 'Dashboard', title === 'Dashboard')}
        ${nav('/admin/employees', 'Employees', title === 'Employees')}
        ${nav('/admin/shifts', 'Shift Log', title === 'Shift Log')}
        <form action="/admin/logout" method="post" style="display:inline">
          <button class="btn ghost small">Log out (${esc(admin.username)})</button>
        </form>
      </nav>
    </header>
    <div class="wrap">${body}</div></body></html>`;
}

function adminLoginPage(error) {
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Sign in · DialerKiosk</title><style>${STYLE}
    .login { max-width:360px; margin:10vh auto; }</style></head><body>
    <div class="login card">
      <h2 style="margin-top:0">🔒 DialerKiosk Admin</h2>
      ${error ? `<div class="flash" style="border-color:var(--bad);background:rgba(239,68,68,.12)">${esc(error)}</div>` : ''}
      <form method="post" action="/admin/login">
        <label>Username</label><input type="text" name="username" autofocus>
        <label>Password</label><input type="password" name="password">
        <div style="margin-top:16px"><button class="btn" style="width:100%">Sign in</button></div>
      </form>
    </div></body></html>`;
}

function renderPage(page, admin, data) {
  if (page === 'dashboard') {
    const online = data.onlineNow.map(s =>
      `<tr><td>${esc(s.username)}</td><td class="muted">${esc(s.machine_id || '—')}</td><td class="muted">${esc(s.login_at)} UTC</td></tr>`
    ).join('') || `<tr><td colspan="3" class="muted">No one is logged in right now.</td></tr>`;
    const body = `
      <div class="grid">
        <div class="card stat"><div class="n">${data.totalEmployees}</div><div class="l">Employees</div></div>
        <div class="card stat"><div class="n">${data.activeShifts}</div><div class="l">Logged in now</div></div>
        <div class="card stat"><div class="n">✓</div><div class="l">Server online</div></div>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Currently on shift</h3>
        <table><thead><tr><th>Employee</th><th>Machine</th><th>Logged in</th></tr></thead><tbody>${online}</tbody></table>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Kiosk settings</h3>
        <p class="muted">The Dialer URL and the list of allowed websites pushed to every kiosk. Changes apply on each employee's next login.</p>
        <form method="post" action="/admin/settings">
          <label>Websites (tabs) — one per line. Each opens as a tab; the first is the Dialer.</label>
          <textarea name="tabs" rows="4" placeholder="Dialer | https://elitetrackers.i5.tel/agc/vicidial.php&#10;CRM | https://crm.company.com&#10;https://wiki.company.com">${esc(data.tabsText)}</textarea>
          <div class="help">
            ✓ Each line is one tab. Format: <code>Label | https://url</code> (or just the URL — the domain becomes the label).<br>
            ✓ Agents can switch between these <b>2–3 tabs live at once</b> without logging in again.<br>
            ✓ The first line opens automatically at login.
          </div>

          <label style="margin-top:18px">Extra allowed websites — one per line. Everything else is blocked.</label>
          <textarea name="allowed_domains" rows="5" placeholder="elitetrackers.i5.tel&#10;crm.company.com&#10;https://help.company.com/any/long/path">${esc(data.allowedDomains)}</textarea>

          <div class="help">
            ✓ You can add <b>multiple sites</b> — one per line.<br>
            ✓ Paste a <b>full URL or just the domain</b> — we keep only the domain.<br>
            ✓ The <b>whole domain is allowed</b>: once you add <code>elitetrackers.i5.tel</code>, every page on it works
              (<code>/agc/vicidial.php</code>, any long address after the domain, and all its subdomains).<br>
            ✓ Every <b>tab's own domain is added automatically</b> — this box is only for extra domains a site pulls from.
          </div>

          <div style="margin-top:14px"><button class="btn">Save settings</button></div>
        </form>
      </div>`;
    return layout('Dashboard', admin, body);
  }

  if (page === 'employees') {
    const rows = data.employees.map(e => `
      <tr>
        <td>${esc(e.username)}</td>
        <td>${esc(e.full_name || '—')}</td>
        <td>${e.active ? '<span class="pill on">Active</span>' : '<span class="pill off">Disabled</span>'}</td>
        <td>
          <form class="inline" method="post" action="/admin/employees/${e.id}/reset">
            <input type="password" name="password" placeholder="new password" required>
            <button class="btn small ghost">Reset</button>
          </form>
        </td>
        <td>
          <form method="post" action="/admin/employees/${e.id}/toggle">
            <button class="btn small ${e.active ? 'danger' : ''}">${e.active ? 'Disable' : 'Enable'}</button>
          </form>
        </td>
      </tr>`).join('') || `<tr><td colspan="5" class="muted">No employees yet.</td></tr>`;
    const body = `
      ${data.flash ? `<div class="flash">${esc(data.flash)}</div>` : ''}
      <div class="card">
        <h3 style="margin-top:0">Add employee</h3>
        <form method="post" action="/admin/employees/create">
          <div class="row">
            <div><label>Username (used to log in)</label><input type="text" name="username" required></div>
            <div><label>Full name</label><input type="text" name="full_name"></div>
            <div><label>Temporary password</label><input type="password" name="password" required></div>
            <div style="flex:0"><button class="btn">Add</button></div>
          </div>
        </form>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Employees</h3>
        <table><thead><tr><th>Username</th><th>Name</th><th>Status</th><th>Reset password</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>
      </div>`;
    return layout('Employees', admin, body);
  }

  if (page === 'shifts') {
    const rows = data.shifts.map(s => `
      <tr>
        <td>${esc(s.username)}</td>
        <td class="muted">${esc(s.machine_id || '—')}</td>
        <td>${esc(s.login_at)} UTC</td>
        <td>${s.logout_at ? esc(s.logout_at) + ' UTC' : '<span class="pill on">On shift</span>'}</td>
        <td>${s.minutes == null ? '—' : (s.minutes + ' min')}</td>
      </tr>`).join('') || `<tr><td colspan="5" class="muted">No shifts recorded yet.</td></tr>`;
    const body = `
      <div class="card">
        <h3 style="margin-top:0">Shift log <span class="muted">(latest 500)</span></h3>
        <table><thead><tr><th>Employee</th><th>Machine</th><th>Login</th><th>Logout</th><th>Duration</th></tr></thead>
        <tbody>${rows}</tbody></table>
      </div>`;
    return layout('Shift Log', admin, body);
  }

  return layout('DialerKiosk', admin, '<div class="card">Unknown page.</div>');
}

module.exports = { renderPage, adminLoginPage };
