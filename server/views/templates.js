// Simple server-rendered HTML for the admin panel. No build step required.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const STYLE = `
  /* Elite Techlogix palette: dark base, indigo -> cyan accents. */
  :root { --bg:#0b1120; --card:#131c30; --line:#263349; --text:#e6ebf5; --muted:#93a1b8;
          --input:#0b1322; --accent:#5b68eb; --accent2:#28e1fd; --good:#22c55e; --bad:#ef4444;
          --brand-grad: linear-gradient(135deg, #5b68eb, #28e1fd); }
  :root[data-theme="light"] { --bg:#f4f6fb; --card:#ffffff; --line:#e3e8f0; --text:#141b2b; --muted:#5c6879;
          --input:#ffffff; --accent:#4f5fe0; --accent2:#0bb6dc; --good:#16a34a; --bad:#dc2626; }
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
  input[type=text], input[type=password], textarea { background:var(--input); border:1px solid var(--line); color:var(--text);
        border-radius:8px; padding:9px 11px; width:100%; font:inherit; }
  textarea { resize:vertical; line-height:1.5; }
  .help { margin-top:10px; font-size:13px; color:var(--muted); line-height:1.7;
          background:rgba(59,130,246,.07); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  code { background:var(--input); border:1px solid var(--line); border-radius:5px; padding:1px 5px; font-size:12px; }
  .codeblock { position:relative; margin-top:6px; }
  .codeblock pre { background:var(--input); border:1px solid var(--line); border-radius:8px; padding:14px; margin:0;
                   overflow-x:auto; font-family:ui-monospace,Consolas,monospace; font-size:12.5px; line-height:1.7;
                   color:var(--text); white-space:pre; }
  .copybtn { position:absolute; top:8px; right:8px; background:var(--brand-grad); color:#fff; border:0; border-radius:6px;
             padding:5px 12px; font-size:12px; font-weight:600; cursor:pointer; }
  .steps { margin:0 0 10px 18px; padding:0; line-height:1.9; font-size:13px; color:var(--muted); }
  .steps b { color:var(--text); }
  .btn.small.danger { background:var(--bad); }
  .msgwrap { display:flex; gap:16px; align-items:flex-start; }
  .convlist { width:280px; min-width:280px; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .conv-item { display:flex; justify-content:space-between; padding:11px 14px; border-bottom:1px solid var(--line);
               color:var(--text); text-decoration:none; font-size:14px; }
  .conv-item:hover { background:rgba(91,104,235,.12); }
  .conv-item.active { background:rgba(91,104,235,.15); border-left:3px solid var(--accent); }
  .msgview { flex:1; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; min-height:200px; }
  .amsg { padding:8px 0; border-bottom:1px solid var(--line); }
  .amsg-h { font-size:12px; margin-bottom:3px; }
  label { display:block; font-size:13px; color:var(--muted); margin:10px 0 4px; }
  .btn { background:var(--brand-grad); color:#fff; border:0; border-radius:8px; padding:9px 14px; cursor:pointer; font-weight:600; }
  /* Logo + theme toggle */
  .logo { display:flex; align-items:center; gap:10px; font-weight:700; font-size:17px; color:var(--text); }
  .logo .mark { width:30px; height:30px; border-radius:8px; background:var(--brand-grad); display:flex;
                align-items:center; justify-content:center; color:#fff; font-weight:800; font-size:17px; flex:none; }
  .logo .grad { background:var(--brand-grad); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .themebtn { background:transparent; border:1px solid var(--line); color:var(--text); border-radius:8px;
              padding:6px 10px; cursor:pointer; font-size:13px; margin-right:16px; }
  .logo-light-img { display:none; }
  :root[data-theme="light"] .logo-dark-img { display:none; }
  :root[data-theme="light"] .logo-light-img { display:inline-block; }
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

// Reusable inline wordmark logo + theme bootstrap (shared by all admin pages).
const { dark: LOGO_DARK, light: LOGO_LIGHT } = require('./logo');
const LOGO_IMG_STYLE = 'height:30px;width:auto;border-radius:6px;vertical-align:middle';
const LOGO = `<span class="logo"><img class="logo-dark-img" src="${LOGO_DARK}" alt="Elite" style="${LOGO_IMG_STYLE}"><img class="logo-light-img" src="${LOGO_LIGHT}" alt="Elite" style="${LOGO_IMG_STYLE}"><span>Elite <span class="grad">Techlogix</span></span></span>`;
const THEME_HEAD = `<script>(function(){try{var t=localStorage.getItem('elite-theme')||'dark';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
function toggleTheme(){var c=document.documentElement.getAttribute('data-theme')==='light'?'dark':'light';document.documentElement.setAttribute('data-theme',c);try{localStorage.setItem('elite-theme',c);}catch(e){}var b=document.getElementById('themebtn');if(b)b.textContent=c==='light'?'\\u{1F319} Dark':'\\u2600 Light';}</script>`;
const THEME_INIT = `<script>(function(){var b=document.getElementById('themebtn');if(b)b.textContent=(document.documentElement.getAttribute('data-theme')==='light')?'\\u{1F319} Dark':'\\u2600 Light';})();</script>`;

function layout(title, admin, body) {
  const nav = (href, label, active) =>
    `<a href="${href}" class="${active ? 'active' : ''}">${label}</a>`;
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(title)} · Elite Techlogix</title>${THEME_HEAD}<style>${STYLE}</style></head><body>
    <header class="top">
      ${LOGO}
      <nav>
        ${nav('/admin', 'Dashboard', title === 'Dashboard')}
        ${nav('/admin/employees', 'Employees', title === 'Employees')}
        ${nav('/admin/rooms', 'Rooms', title === 'Rooms')}
        ${nav('/admin/messages', 'Messages', title === 'Messages')}
        <button id="themebtn" class="themebtn" onclick="toggleTheme()">Theme</button>
        <form action="/admin/logout" method="post" style="display:inline">
          <button class="btn ghost small">Log out (${esc(admin.username)})</button>
        </form>
      </nav>
    </header>
    <div class="wrap">${body}</div>${THEME_INIT}</body></html>`;
}

function adminLoginPage(error) {
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Sign in · Elite Techlogix</title>${THEME_HEAD}<style>${STYLE}
    .login { max-width:380px; margin:9vh auto; }
    .login .logo { justify-content:center; font-size:20px; margin-bottom:18px; }</style></head><body>
    <div class="login card">
      ${LOGO}
      ${error ? `<div class="flash" style="border-color:var(--bad);background:rgba(239,68,68,.12)">${esc(error)}</div>` : ''}
      <form method="post" action="/admin/login">
        <label>Username</label><input type="text" name="username" autofocus>
        <label>Password</label><input type="password" name="password">
        <div style="margin-top:16px"><button class="btn" style="width:100%">Sign in</button></div>
      </form>
      <div style="text-align:center;margin-top:16px"><button id="themebtn" class="themebtn" onclick="toggleTheme()" style="margin:0">Theme</button></div>
    </div>${THEME_INIT}</body></html>`;
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
        <h3 style="margin-top:0">📥 Agent app (install on each PC)</h3>
        <p class="muted">Download the Elite kiosk installer and run it on every agent computer. Once installed it auto-starts, locks the screen to your dialer, and can only be closed with the exit code.</p>
        ${data.agentDownloadUrl
          ? `<a class="btn" href="${esc(data.agentDownloadUrl)}" target="_blank" rel="noopener" style="display:inline-block;text-decoration:none">⬇ Download Agent App</a>`
          : `<p class="muted"><i>No installer link set yet — paste the download URL below and Save.</i></p>`}
        <h4 style="margin:20px 0 8px;font-size:14px">Install on a PC (run once per computer)</h4>
        <ol class="steps">
          <li>On the PC, sign in as an <b>Administrator</b>.</li>
          <li>Open <b>PowerShell as Administrator</b> (Start → type "PowerShell" → right-click → <b>Run as administrator</b>).</li>
          <li>Click <b>Copy</b> below, paste into PowerShell, and press <b>Enter</b>.</li>
          <li><b>Reboot.</b> The PC boots straight into the locked Elite app.</li>
        </ol>
        <div class="codeblock">
          <button type="button" class="copybtn" onclick="copyInstall(this)">Copy</button>
<pre id="installCmds">Set-ExecutionPolicy Bypass -Scope Process -Force
Invoke-WebRequest "https://github.com/SameeerKhann/elite-agent/releases/download/v0.1.0/Install-Elite.ps1" -OutFile "$env:TEMP\\Install-Elite.ps1" -UseBasicParsing
&amp; "$env:TEMP\\Install-Elite.ps1"</pre>
        </div>
        <p class="muted" style="font-size:12px;margin-top:8px">
          Each PC automatically gets its own unique kiosk account. <b>Keep a separate Administrator account on every PC</b> — that's your way back in (sign-in screen → Ctrl+Alt+Del → Switch user). Test on one spare PC first.
        </p>

        <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
        <form method="post" action="/admin/agent-download">
          <label>Installer download URL (advanced — the .exe zip location)</label>
          <input type="text" name="agent_download_url" value="${esc(data.agentDownloadUrl || '')}" placeholder="https://…/Elite-Agent.zip">
          <div style="margin-top:10px"><button class="btn ghost">Save download link</button></div>
        </form>
      </div>
      <script>
        function copyInstall(btn){
          var text = document.getElementById('installCmds').innerText;
          function done(){ var o = btn.textContent; btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = o; }, 1500); }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(selectText);
          } else { selectText(); }
          function selectText(){ var r = document.createRange(); r.selectNodeContents(document.getElementById('installCmds')); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); try { document.execCommand('copy'); done(); } catch(e){} }
        }
      </script>

      <div class="card">
        <h3 style="margin-top:0">Kiosk settings</h3>
        <p class="muted">The Dialer URL and the list of allowed websites pushed to every kiosk. Changes apply on each employee's next login.</p>
        <form id="kioskSettings" method="post" action="/admin/settings">
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

  if (page === 'rooms') {
    const empCheckbox = (roomId, e, checked) =>
      `<label style="display:inline-flex;align-items:center;gap:6px;margin:3px 12px 3px 0;font-size:13px;color:var(--text)">
         <input type="checkbox" name="member_ids" value="${e.id}" form="room${roomId}" ${checked ? 'checked' : ''}> ${esc(e.full_name || e.username)}
       </label>`;
    const roomCards = data.rooms.map(r => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">🛡 ${esc(r.name)}</h3>
          <form method="post" action="/admin/rooms/${r.id}/delete" onsubmit="return confirm('Delete this room and its messages access?')">
            <button class="btn small danger">Delete</button>
          </form>
        </div>
        <p class="muted" style="margin:8px 0">Tick who is in this room, then Save.</p>
        <form id="room${r.id}" method="post" action="/admin/rooms/${r.id}/members">
          <div>${data.employees.map(e => empCheckbox(r.id, e, r.memberIds.includes(e.id))).join('')}</div>
          <div style="margin-top:10px"><button class="btn small">Save members</button></div>
        </form>
      </div>`).join('') || `<div class="card muted">No rooms yet. Create one above.</div>`;
    const body = `
      ${data.flash ? `<div class="flash">${esc(data.flash)}</div>` : ''}
      <div class="card">
        <h3 style="margin-top:0">Create a team room</h3>
        <p class="muted">Rooms are group channels for a subset of employees (e.g. a team or department). Everyone in the group "# General" is separate and always includes all staff.</p>
        <form method="post" action="/admin/rooms/create" class="row">
          <div><label>Room name</label><input type="text" name="name" placeholder="Sales Team" required></div>
          <div style="flex:0"><button class="btn">Create room</button></div>
        </form>
      </div>
      ${roomCards}`;
    return layout('Rooms', admin, body);
  }

  if (page === 'messages') {
    const convItems = data.convos.map(c =>
      `<a href="/admin/messages?thread=${encodeURIComponent(c.thread)}"
          class="conv-item ${c.thread === data.selected ? 'active' : ''}">
         <span>${esc(c.label)}</span><span class="muted">${c.count}</span>
       </a>`).join('') || `<div class="muted" style="padding:10px">No conversations yet.</div>`;
    const msgs = data.messages.map(m => `
      <div class="amsg">
        <div class="amsg-h"><b>${esc(m.username)}</b> <span class="muted">${esc(String(m.created_at).replace('T',' ').replace('Z',' UTC'))}</span></div>
        <div>${esc(m.body)}</div>
      </div>`).join('') || `<div class="muted" style="padding:16px">No messages in this conversation.</div>`;
    const body = `
      <p class="muted">Read-only view of all internal conversations (group, team rooms, and direct messages).</p>
      <div class="msgwrap">
        <div class="convlist">${convItems}</div>
        <div class="msgview">
          <h3 style="margin:0 0 12px">${esc(data.selectedLabel || 'Select a conversation')}</h3>
          ${msgs}
        </div>
      </div>`;
    return layout('Messages', admin, body);
  }

  return layout('Elite', admin, '<div class="card">Unknown page.</div>');
}

module.exports = { renderPage, adminLoginPage };
