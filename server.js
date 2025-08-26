// server.js — DeviceHub cloud API + admin UI (token gated)
// PowerShell is now queued as "__PSB64__:<utf8-base64>", which the agent decodes
// and runs from a temp .ps1 file (no quoting limits, no length issues).

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";

const PORT = process.env.PORT || 4000;
const ONLINE_WINDOW_MS = 30_000;
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------------- in-memory ----------------
const queues = new Map();   // deviceId -> [commands...]
const devices = new Map();  // deviceId -> { id, ip, hostname, username, os, lastSeen }

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
    req.socket?.remoteAddress || ""
  );
}
function markSeen(id, req, partial = {}) {
  const now = Date.now();
  const ip = clientIp(req) || devices.get(id)?.ip || "";
  const prev = devices.get(id) || { id, ip: "", hostname: "", username: "", os: "", lastSeen: 0 };
  devices.set(id, {
    id,
    ip: ip || prev.ip,
    hostname: (partial.hostname ?? prev.hostname)?.toString() || "",
    username: (partial.username ?? prev.username)?.toString() || "",
    os: (partial.os ?? prev.os)?.toString() || "",
    lastSeen: now,
  });
}

// ---------------- auth ----------------
function requireAdmin(req, res, next) {
  const h = (req.headers["x-admin-token"] || req.headers["authorization"] || "").toString().trim();
  const token = h.startsWith("Bearer ") ? h.slice(7) : h;
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: "auth_required" });
}

// ---------------- health ----------------
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ---------------- device API ----------------
app.get("/api/pull", (req, res) => {
  const deviceId = (req.query.deviceId || "").toString().trim();
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  markSeen(deviceId, req);
  const cmd = dequeue(deviceId);
  res.json({ command: cmd ?? null });
});

app.post("/api/heartbeat", (req, res) => {
  const { deviceId, hostname, username, os } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  markSeen(deviceId.toString().trim(), req, { hostname, username, os });
  res.json({ ok: true });
});

// ---------------- admin API ----------------
app.post("/api/command", requireAdmin, (req, res) => {
  const { deviceId, command } = req.body || {};
  if (!deviceId || !command) return res.status(400).json({ error: "deviceId and command are required" });
  enqueue(deviceId.toString(), command.toString());
  res.json({ ok: true });
});

// NEW: queue PowerShell as UTF-8 base64 payload with a fixed prefix the agent understands
app.post("/api/ps", requireAdmin, (req, res) => {
  const { deviceId, script } = req.body || {};
  if (!deviceId || !script) return res.status(400).json({ error: "deviceId and script are required" });
  const b64 = Buffer.from(script.toString(), "utf8").toString("base64");
  enqueue(deviceId.toString(), "__PSB64__:" + b64);
  res.json({ ok: true });
});

app.get("/api/devices", requireAdmin, (_req, res) => {
  const now = Date.now();
  const list = Array.from(devices.values()).map(d => ({ ...d, online: now - d.lastSeen <= ONLINE_WINDOW_MS }));
  list.sort((a, b) => b.lastSeen - a.lastSeen);
  res.json({ devices: list });
});

app.delete("/api/devices/:deviceId", requireAdmin, (req, res) => {
  const id = (req.params.deviceId || "").toString().trim();
  if (!id) return res.status(400).json({ error: "deviceId required" });
  devices.delete(id);
  queues.delete(id);
  res.json({ ok: true });
});

app.get("/api/queues", requireAdmin, (_req, res) => {
  const view = {};
  for (const [k, v] of queues.entries()) view[k] = v.length;
  res.json(view);
});

// ---------------- admin UI (unchanged except bulk delete + PS area you saw) ----------------
app.get("/admin", (_req, res) => {
  res.status(200).send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>DeviceHub Admin</title>
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
    <input id="token" type="password" placeholder="Admin token"/>
    <button onclick="login()">Login</button>
    <span class="muted" id="loginMsg"></span>
  </div>
</div>

<div id="app" style="display:none">
  <div class="card topbar">
    <div class="muted">Authenticated</div>
    <div style="display:flex;gap:8px;align-items:center">
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
      </div>
    </details>
    <div id="tableWrap"></div>
  </div>
</div>

<script>
let lastFocusedDeviceId=null, chipBound=false;
function getToken(){return sessionStorage.getItem('admin_token')||''}
function setToken(t){sessionStorage.setItem('admin_token',t)}
function clearToken(){sessionStorage.removeItem('admin_token')}
async function login(){
  const t=document.getElementById('token').value.trim();
  if(!t){document.getElementById('loginMsg').innerText='Enter token';return}
  const ok=await fetch('/api/queues',{headers:{'x-admin-token':t}}).then(r=>r.status!==401).catch(()=>false);
  if(ok){setToken(t);document.getElementById('loginCard').style.display='none';document.getElementById('app').style.display='block';render()}
  else{document.getElementById('loginMsg').innerText='Invalid token'}
}
function logout(){clearToken();location.reload()}
function fmt(ts){if(!ts)return'';return new Date(ts).toLocaleString()}
function selectedIds(){return Array.from(document.querySelectorAll('.selbox:checked')).map(cb=>cb.value)}
function toggleAll(box){document.querySelectorAll('.selbox').forEach(cb=>cb.checked=box.checked)}
async function deleteSelected(){
  const ids=selectedIds(); if(!ids.length){alert('No devices selected');return}
  if(!confirm('Delete '+ids.length+' device(s)?'))return;
  for(const id of ids){await fetch('/api/devices/'+encodeURIComponent(id),{method:'DELETE',headers:{'x-admin-token':getToken()}}).catch(()=>{})}
  render()
}
async function fetchDevices(){
  const r=await fetch('/api/devices',{headers:{'x-admin-token':getToken()}});
  if(r.status===401){logout();return[]}
  return (await r.json()).devices||[]
}
async function render(){
  const devs=await fetchDevices();
  const rows=devs.map(d=>{
    const status=d.online?'<span class="status-ok">ONLINE</span>':'<span class="status-bad">OFFLINE</span>';
    const inputId='cmd-'+(d.id||''), psId='ps-'+(d.id||'');
    return \`
    <tr>
      <td style="width:36px"><input type="checkbox" class="selbox" value="\${d.id}"></td>
      <td><span class="badge">\${d.id||''}</span><br/><span class="muted">last seen: \${fmt(d.lastSeen)}</span></td>
      <td>\${d.ip||''}</td>
      <td>\${d.username||''}</td>
      <td>\${d.hostname||''}</td>
      <td>\${d.os||''}</td>
      <td>
        <input type="text" placeholder="Command (e.g. start msedge.exe ...)" id="\${inputId}" onfocus="lastFocusedDeviceId='\${d.id}'">
        <button style="margin-left:6px" onclick="execCmd('\${d.id}','\${inputId}')">Execute</button>
        <div style="margin-top:8px">
          <textarea rows="2" placeholder="PowerShell script (e.g. Get-Date)" id="\${psId}"></textarea>
          <div style="margin-top:6px;display:flex;gap:8px;">
            <button onclick="sendPS('\${d.id}','\${psId}')">PS ▶</button>
            <button class="danger" onclick="delDev('\${d.id}')">Delete</button>
          </div>
        </div>
      </td>
      <td>\${status}</td>
    </tr>\`
  }).join('');
  document.getElementById('tableWrap').innerHTML=\`
    <table class="tbl"><thead>
      <tr><th><input type="checkbox" onclick="toggleAll(this)"></th>
          <th>Device ID</th><th>IP</th><th>Username</th>
          <th>Hostname</th><th>OS</th><th>Actions</th><th>Status</th></tr>
    </thead><tbody>\${rows}</tbody></table>\`;
  if(!chipBound){
    document.addEventListener('click',e=>{
      const chip=e.target.closest('.chip'); if(!chip)return;
      if(!lastFocusedDeviceId){alert('Click into a device Command box first.');return}
      const input=document.getElementById('cmd-'+lastFocusedDeviceId); if(input){input.value=chip.getAttribute('data-cmd')||'';input.focus()}
    }); chipBound=true;
  }
}
async function execCmd(deviceId,inputId){
  const v=document.getElementById(inputId).value.trim(); if(!v){alert('Enter a command');return}
  const r=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json','x-admin-token':getToken()},body:JSON.stringify({deviceId,command:v})});
  const j=await r.json(); if(j.ok){document.getElementById(inputId).value='';alert('Queued')} else alert('Error: '+(j.error||''))
}
async function sendPS(deviceId,psId){
  const s=document.getElementById(psId).value.trim(); if(!s){alert('Enter a PowerShell script');return}
  const r=await fetch('/api/ps',{method:'POST',headers:{'Content-Type':'application/json','x-admin-token':getToken()},body:JSON.stringify({deviceId,script:s})});
  const j=await r.json(); if(j.ok){document.getElementById(psId).value='';alert('PS queued')} else alert('Error: '+(j.error||''))
}
async function delDev(id){
  if(!confirm('Delete device '+id+' ?'))return;
  const r=await fetch('/api/devices/'+encodeURIComponent(id),{method:'DELETE',headers:{'x-admin-token':getToken()}});
  const j=await r.json(); if(j.ok)render(); else alert('Delete failed: '+(j.error||''));
}
</script></body></html>`);
});

// ---------------- start ----------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP polling server running on :${PORT}`);
});
