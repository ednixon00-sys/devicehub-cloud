// server.js — DeviceHub cloud API with presence + simple admin UI (poll-based)
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";

const PORT = process.env.PORT || 4000;
const ONLINE_WINDOW_MS = 30_000; // consider "online" if seen in last 30s

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------------- In-memory state ----------------
const queues = new Map(); // deviceId -> [commands...]
const devices = new Map(); // deviceId -> { id, ip, hostname, username, os, lastSeen }

// helpers
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
    hostname: partial.hostname?.toString() || existing.hostname,
    username: partial.username?.toString() || existing.username,
    os: partial.os?.toString() || existing.os,
    lastSeen: now,
  });
}

// ---------------- Health ----------------
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ---------------- Device API ----------------

// Agents call this every 2s (GET) to fetch one next command
app.get("/api/pull", (req, res) => {
  const deviceId = (req.query.deviceId || "").toString().trim();
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  // mark as seen (even if agent hasn't added heartbeat yet)
  markSeen(deviceId, req);
  const cmd = dequeue(deviceId);
  return res.json({ command: cmd ?? null });
});

// Agents send metadata here (POST) to enrich table
// body: { deviceId, hostname, username, os }
app.post("/api/heartbeat", (req, res) => {
  const { deviceId, hostname, username, os } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  markSeen(deviceId.toString().trim(), req, { hostname, username, os });
  return res.json({ ok: true });
});

// Admin/API: queue a command for a device
app.post("/api/command", (req, res) => {
  const { deviceId, command } = req.body || {};
  if (!deviceId || !command) {
    return res.status(400).json({ error: "deviceId and command are required" });
  }
  enqueue(deviceId.toString(), command.toString());
  return res.json({ ok: true });
});

// List devices with details (only those seen recently if you prefer)
app.get("/api/devices", (_req, res) => {
  const now = Date.now();
  const list = [];
  for (const info of devices.values()) {
    const online = now - info.lastSeen <= ONLINE_WINDOW_MS;
    list.push({ ...info, online });
  }
  // newest first
  list.sort((a, b) => b.lastSeen - a.lastSeen);
  res.json({ devices: list });
});

// (Optional) view queue sizes
app.get("/api/queues", (_req, res) => {
  const view = {};
  for (const [k, v] of queues.entries()) view[k] = v.length;
  res.json(view);
});

// ---------------- Simple Admin UI ----------------
app.get("/admin", (_req, res) => {
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>DeviceHub Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
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
  </style>
</head>
<body>
  <h1>DeviceHub Admin</h1>
  <div class="card">
    <div class="tip">Click <code>Refresh</code> to update devices. Use the input to send a command to a specific device.</div>
    <div style="margin:10px 0;">
      <button id="refreshBtn">Refresh</button>
    </div>
    <div id="tableWrap"></div>
  </div>
<script>
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
    return \`
      <tr>
        <td><code>\${d.id||''}</code><br/><span class="tip">last seen: \${fmtTime(d.lastSeen)}</span></td>
        <td>\${d.ip||''}</td>
        <td>\${d.username||''}</td>
        <td>\${d.hostname||''}</td>
        <td>\${d.os||''}</td>
        <td class="row-actions">
          <input type="text" placeholder="e.g. start msedge.exe --kiosk https://example.com" id="cmd-\${d.id}">
          <button onclick="execCmd('\${d.id}')">Execute</button>
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
async function execCmd(deviceId){
  const inp = document.getElementById('cmd-'+deviceId);
  const command = inp.value.trim();
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

