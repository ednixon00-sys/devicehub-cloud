// server.js — DeviceHub cloud API with presence + admin UI (poll-based)
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";

const PORT = process.env.PORT || 4000;
const ONLINE_WINDOW_MS = 30_000; // show "online" if seen within last 30s

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

// Admin/API queues a command for ONE device
// body: { deviceId, command }
app.post("/api/command", (req, res) => {
  const { deviceId, command } = req.body || {};
  if (!deviceId || !command) {
    return res.status(400).json({ error: "deviceId and command are required" });
  }
  enqueue(deviceId.toString(), command.toString());
  res.json({ ok: true });
});

// List devices with details
app.get("/api/devices", (_req, res) => {
  const now = Date.now();
  const list = [];
  for (const info of devices.values()) {
    const online = now - info.lastSeen <= ONLINE_WINDOW_MS;
    list.push({ ...info, online });
  }
  list.sort((a, b) => b.lastSeen - a.lastSeen); // newest first
  res.json({ devices: list });
});

// (Optional) see queue sizes
app.get("/api/queues", (_req, res) => {
  const view = {};
  for (const [k, v] of queues.entries()) view[k] = v.length;
  res.json(view);
});

// ---------------- Admin UI (with embedded Cheat Sheet) ----------------
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
    table{width:100%;border-collapse:collapse}
    th,td{padding:10px;border-bottom:1px solid #1f2a37;font-size:14px;vertical-align:top}
    th{text-align:left;color:#9fb2c8}
    .online{color:#16a34a;font-weight:600}
    .offline{color:#ef4444;font-weight:600}
    .row-actions{display:flex;gap:8px;align-items:center}
    input[type=text]{width:100%;background:#0b1220;border:1px solid #1f2a37;border-radius:8px;color:#e6edf3;padding:8px}
    button{background:#2563eb;border:0;color:white;padding:8px 12px;border-radius:8px;cursor:pointer}
    button:hover{background:#1d4ed8}
    code{background:#0b1220;padding:2px 6px;border-radius:6px;border:1px solid #1f2a37}
    .tip{color:#9fb2c8;font-size:13px}
    summary{cursor:pointer}
    .cheatgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
    .chip{display:inline-block;background:#0b1220;border:1px solid #1f2a37;border-radius:999px;padding:6px 10px;margin:4px 6px;cursor:pointer}
    .chip:hover{border-color:#2a3a4a}
    pre{background:#0b1220;border:1px solid #1f2a37;border-radius:8px;padding:8px;overflow:auto}
  </style>
</head>
<body>
  <h1>DeviceHub Admin</h1>

  <div class="card">
    <div class="tip">Focus a device's input first, then click a cheat-sheet command to auto-insert it.</div>
    <div style="margin:10px 0;">
      <button id="refreshBtn">Refresh</button>
    </div>

    <!-- Cheat Sheet -->
    <details class="card">
      <summary><strong>📋 Command Cheat Sheet</strong></summary>
      <div style="margin-top:12px;">
        <h3>Basic apps</h3>
        <div class="cheatgrid">
          <span class="chip" data-cmd="notepad.exe">notepad.exe</span>
          <span class="chip" data-cmd="calc.exe">calc.exe</span>
          <span class="chip" data-cmd="mspaint.exe">mspaint.exe</span>
        </div>

        <h3>Browsers / Kiosk</h3>
        <div class="cheatgrid">
          <span class="chip" data-cmd="start msedge.exe --kiosk https://www.bing.com --edge-kiosk-type=fullscreen">Edge kiosk (Bing)</span>
          <span class="chip" data-cmd="start msedge.exe --kiosk https://walrus-app-y58ft.ondigitalocean.app/admin/ --edge-kiosk-type=public-browsing">Edge kiosk (Admin)</span>
          <span class="chip" data-cmd="start chrome.exe --kiosk https://www.example.com">Chrome kiosk</span>
          <span class="chip" data-cmd="taskkill /IM msedge.exe /F">Close Edge kiosk</span>
        </div>

        <h3>File Explorer / Tools</h3>
        <div class="cheatgrid">
          <span class="chip" data-cmd="explorer.exe C:\\">Explorer C:\\</span>
          <span class="chip" data-cmd="devmgmt.msc">Device Manager</span>
          <span class="chip" data-cmd="services.msc">Services</span>
        </div>

        <h3>System actions ⚠️</h3>
        <div class="cheatgrid">
          <span class="chip" data-cmd="rundll32.exe user32.dll,LockWorkStation">Lock workstation</span>
          <span class="chip" data-cmd="shutdown /l">Log off</span>
          <span class="chip" data-cmd="shutdown /r /t 0">Reboot now</span>
        </div>

        <h3>Fun / Demos</h3>
        <div class="cheatgrid">
          <span class="chip" data-cmd="powershell -c (New-Object Media.SoundPlayer 'C:\\Windows\\Media\\tada.wav').PlaySync()">Play sound</span>
          <span class="chip" data-cmd="start msedge.exe --kiosk https://youtube.com --edge-kiosk-type=fullscreen">Edge kiosk (YouTube)</span>
        </div>
      </div>
    </details>

    <div id="tableWrap"></div>
  </div>

<script>
let lastFocusedDeviceId = null;

async function fetchDevices(){
  const r = await fetch('/api/devices');
  const data = await r.json();
  return data.devices || [];
}
function fmtTime(ts){
  if(!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString();
}
async function render(){
  const devices = await fetchDevices();
  const rows = devices.map(d => {
    const status = d.online ? '<span class="online">ONLINE</span>' : '<span class="offline">OFFLINE</span>';
    const inputId = 'cmd-' + (d.id||'');
    return \`
      <tr>
        <td><code>\${d.id||''}</code><br/><span class="tip">last seen: \${fmtTime(d.lastSeen)}</span></td>
        <td>\${d.ip||''}</td>
        <td>\${d.username||''}</td>
        <td>\${d.hostname||''}</td>
        <td>\${d.os||''}</td>
        <td class="row-actions">
          <input type="text" placeholder="e.g. start msedge.exe --kiosk https://example.com" id="\${inputId}" onfocus="lastFocusedDeviceId='\${d.id}'">
          <button onclick="execCmd('\${d.id}', '\${inputId}')">Execute</button>
        </td>
        <td>\${status}</td>
      </tr>\`;
  }).join('');
  document.getElementById('tableWrap').innerHTML = \`
    <table>
      <thead>
        <tr>
          <th>Device ID</th>
          <th>IP</th>
          <th>Username</th>
          <th>Hostname</th>
          <th>OS</th>
          <th>Command</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>\${rows}</tbody>
    </table>\`;
}

async function execCmd(deviceId, inputId){
  const inp = document.getElementById(inputId);
  const command = (inp.value||'').trim();
  if(!command){ alert('Enter a command'); return; }
  const r = await fetch('/api/command',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({deviceId, command})
  });
  const j = await r.json();
  if(j.ok){ inp.value=''; alert('Queued'); } else { alert('Error: '+(j.error||'unknown')); }
}

document.getElementById('refreshBtn').addEventListener('click', render);

// Click-to-insert from cheat sheet into the last focused device input
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

render();
</script>
</body>
</html>`;
  res.status(200).send(html);
});

// ---------------- Start ----------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP polling server running on :${PORT}`);
});

