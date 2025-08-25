import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import cors from "cors";
import url from "url";

const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Health check
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Track connected devices
const devices = new Map(); // deviceId -> ws

app.get("/api/devices", (_req, res) => {
  res.json({ online: Array.from(devices.keys()) });
});

// Send a command to one device
app.post("/api/command", (req, res) => {
  const { deviceId, command } = req.body || {};
  if (!deviceId || !command) {
    return res.status(400).json({ error: "deviceId and command are required" });
  }
  const ws = devices.get(deviceId);
  if (!ws || ws.readyState !== ws.OPEN) {
    return res.status(404).json({ error: `device ${deviceId} not connected` });
  }
  try {
    ws.send(command);
    return res.json({ ok: true, sent: { deviceId, command } });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

const server = http.createServer(app);

// WS server (accept upgrades on ANY path; require ?deviceId=...)
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, request, deviceId) => {
  console.log(`[ws] connected: ${deviceId}`);
  devices.set(deviceId, ws);

  ws.on("message", (msg) => {
    console.log(`[ws:${deviceId}] ${msg}`);
  });

  ws.on("close", () => {
    console.log(`[ws] closed: ${deviceId}`);
    devices.delete(deviceId);
  });
});

server.on("upgrade", (request, socket, head) => {
  const { query } = url.parse(request.url, true);
  const deviceId = (query.deviceId || "").toString().trim();

  if (!deviceId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request, deviceId);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP+WS server on :${PORT} (any WS path; require ?deviceId=...)`);
});
