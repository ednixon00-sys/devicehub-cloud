// server.js — DeviceHub cloud API with presence + admin UI (token-gated)
// Adds: robust PowerShell (-EncodedCommand), per-row checkbox + Delete Selected,
// and cleaner bordered rows ("card" look).

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";

const PORT = process.env.PORT || 4000;
const ONLINE_WINDOW_MS = 30_000; // device "online" if seen within last 30s
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------------- In-memory state ----------------
const queues = new Map();   // deviceId -> [commands...]
const devices = new Map();  // deviceId -> { id, ip, hostname, username, os, lastSeen }

function enqueue(deviceId, command) {
  if (!queues.has(deviceId)) queues.set(deviceId, []);
  queues.get(deviceId).push(command);
}
function dequeue(deviceId) {
  if (!queues.has(deviceId)) return null;
  const q = queues.get(deviceId);
  if (!q.length) return null;
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
  const existing = devices.get(id) || { id, ip: "", hostname: "", username: "", os: "", lastSeen: 0 };
  devices.set(id, {
    id,
    ip: ip || existing.ip,
    hostname: (partial.hostname ?? existing.hostname)?.toString() || "",
    username: (partial.username ?? existing.username)?.toString() || "",
    os: (partial.os ?? existing.os)?.toString() || "",
    lastSeen: now,
  });
}

// ---------------- Admin auth helper ----------------
function requireAdmin(req, res, next) {
  // Accept token via header or bearer
  const h = (req.headers["x-admin-token"] || req.headers["authorization"] || "").toString().trim();
  const token = h.startsWith("Bearer ") ? h.slice(7) : h;
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: "auth_required" });
}

// ---------------- Health ----------------
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ---------------- Device API ----------------

// Agents poll here (every ~2s) to fetch the next command (and we mark presence)
app.get("/api/pull", (req, res) => {
  const deviceId = (req.query.deviceId || "").toString().trim();
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  markSeen(deviceId, req);
  const cmd = dequeue(deviceId);
  res.json({ command: cmd ?? null });
});

// Agents POST metadata here so we can show a rich table
// body: { deviceId, hostname, username, os }
app.post("/api/heartbeat", (req, res) => {
  const { deviceId, hostname, username, os } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  markSeen(deviceId.toString().trim(), req, { hostname, username, os });
  res.json({ ok: true });
});

// ---------------- Admin/API (protected) ----------------

// Queue a generic command for ONE device
// body: { deviceId, command }
app.post("/api/command", requireAdmin, (req, res) => {
  const { deviceId, command } = req.body || {};
  if (!deviceId || !command) {
    return res.status(400).json({ error: "deviceId and command are required" });
  }
  enqueue(deviceId.toString(), command.toString());
  res.json({ ok: true });
});

// Helper: build robust PowerShell -EncodedCommand (UTF16-LE base64)
function psEncodedCommand(script) {
  // normalize newlines, then UTF-16LE base64 encode
  const normalized = script.toString().replace(/\r\n/g, "\n");
  return Buffer.from(normalized, "utf16le").toString("base64");
}

// Queue a *PowerShell* command for ONE device (no agent change needed)
app.post("/api/ps", requireAdmin, (req, res) => {
  const { deviceId, script } = req.body || {};
  if (!deviceId || !script) {
    return res.status(400).json({ error: "deviceId and script are required" });
  }
  // Using EncodedCommand avoids all quoting/escaping problems
  const b64 = psEncodedCommand(script);
  const ps = `powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64}`;
  enqueue(deviceId.toString(), ps);
  res.json({ ok: true });
});

// List devices with details
app.get("/api/devices", requireAdmin, (_req, res) => {
  const now = Date.now();
  const list = [];
  for (const info of devices.values()) {
    const online = now - info.lastSeen <= ONLINE_WINDOW_MS;
    list.push({ ...info, online });
  }
  list.sort((a, b) => b.lastSeen - a.lastSeen); // newest first
  res.json({ devices: list });
});

// Delete a specific device (also clears its pending queue)
app.delete("/api/devices/:deviceId", requireAdmin, (req, res) => {
  const id = (req.params.deviceId || "").toString().trim();
  if (!id) return res.status(400).json({ error: "deviceId required" });
  devices.delete(id);
  queues.delete(id);
  res.json({ ok: true });
});

// (Optional) see queue sizes
app.get("/api/queues", requireAdmin, (_req, res) => {
  const view = {};
  for (const [k, v] of queues.entries()) view[k] = v.length;
  res.json(view);
});

// ---------------- Admin UI ----------------
app.get("/admin", (_req, res) => {
  const html = `<!doctype html>
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
    input[type=text],textarea{width:100%;background:#0b1220;border:1px solid #1f2a37;border-radius:8px;color:#e6edf3;padding:8px}
    .topbar{display:flex;justify-content:space-between;align-items:center}
    /* "Card rows" table styling */
    table.tbl{width:100%;border-collapse:separate;border-spacing:0 10px}
    table.tbl thead th{padding:8px;color:#9fb2c8;text-align:left}
    table.tbl tbody td{background:#0f1720;border-top:1px solid #1f2a37;border-bottom:1px solid #1f2a37;padding:10px;vertical-align:top}
    table.tbl tbody td:first-child{border-left:1px solid #1f2a37;border-top-left-radius:12px;border-bottom-left-radius:12px}
    table.tbl tbody td:last-child{border-right:1px solid #1f2a37;border-top-right-radius:12px;border-bottom-right-radius:12px}
    .status-ok{color:#16a34a;font-weight:600}
    .status-bad{color:#ef4444;font-weight:600}
    .badge{display:inline-block;padding:3px 8px;border-radius:10px;background:#0b1220;border:1px solid #1f2a37}
    .chip{display:inline-block;background:#0b1220;border:1px solid #1f2a37;border-radius:999px;padding:6px 10px;margin:4px 6px;cursor:pointer}
    .chip:hover{border-color:#2a3a4a}
    .login{display:flex;gap:8px;align-items:center;max-width:520px}
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
          <h3>Basic apps</h3>
          <div>
            <span class="chip" data-cmd="notepad.exe">notepad.exe</span>
            <span class="chip" data-cmd="calc.exe">calc.exe</span>
            <span class="chip" data-cmd="mspaint.exe">mspaint.exe</span>
          </div>
          <h3>Browsers / Kiosk</h3>
          <div>
            <span class="chip" data-cmd="start msedge.exe --kiosk https://www.bing.com --edge-kiosk-type=fullscreen">Edge kiosk (Bing)</span>
            <span class="chip" data-cmd="start chrome.exe --kiosk https://www.example.com">Chrome kiosk</span>
            <span class="chip" data-cmd="taskkill /IM msedge.exe /F">Close Edge kiosk</span>
          </div>
          <h3>System actions ⚠️</h3>
          <div>
            <span class="chip" data-cmd="rundll32.exe user32.dll,LockWorkStation">Lock workstation</span>
            <span class="chip" data-cmd="shutdown /r /t 0">Reboot now</span>
          </div>
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
function logout(){
  clearToken();
  location.reload();
}

function fmtTime(ts){
  if(!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString();
}

function selectedIds(){
  return Array.from(document.querySelectorAll('.selbox:checked')).map(cb => cb.value);
}
function toggleAll(checkbox){
  document.querySelectorAll('.selbox').forEach(cb => { cb.checked = checkbox.checked; });
}

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
  const data = await r.json();
  return data.devices || [];
}

async function render(){
  const devices = await fetchDevices();
  const rows = devices.map(d => {
    const status = d.online ? '<span class="status-ok">ONLINE</span>' : '<span class="status-bad">OFFLINE</span>';
    const inputId = 'cmd-' + (d.id||'');
    const psId = 'ps-' + (d.id||'');
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
          <div style="margin-top:8px">
            <textarea rows="2" placeholder="PowerShell script (e.g. Get-Process | Select-Object -First 3)" id="\${psId}"></textarea>
            <div style="margin-top:6px; display:flex; gap:8px;">
              <button onclick="sendPS('\${d.id}', '\${psId}')">PS ▶</button>
              <button class="danger" onclick="delDev('\${d.id}')">Delete</button>
            </div>
          </div>
        </td>
        <td>\${status}</td>
      </tr>\`;
  }).join('');
  document.getElementById('tableWrap').innerHTML = \`
    <table class="tbl">
      <thead>
        <tr>
          <th><input type="checkbox" id="selAll" onclick="toggleAll(this)"></th>
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
      const cmd = chip.getAttribute('data-cmd') || '';
      if(!lastFocusedDeviceId){
        alert('Click into a device Command box first, then choose a cheat command.');
        return;
      }
      const input = document.getElementById('cmd-' + lastFocusedDeviceId);
      if(input){ input.value = cmd; input.focus(); }
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

async function sendPS(deviceId, psId){
  const ta = document.getElementById(psId);
  const script = (ta.value||'').trim();
  if(!script){ alert('Enter a PowerShell script (e.g. Get-Date)'); return; }
  const r = await fetch('/api/ps',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-admin-token': getToken()},
    body: JSON.stringify({deviceId, script})
  });
  const j = await r.json();
  if(j.ok){ ta.value=''; alert('PS queued'); } else { alert('Error: '+(j.error||'unknown')); }
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
</html>`;
  res.status(200).send(html);
});

// ---------------- Start ----------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP polling server running on :${PORT}`);
});
