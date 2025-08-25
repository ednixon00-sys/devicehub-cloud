import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import cors from "cors";
import url from "url";

const PORT = process.env.PORT || 4000;

// --- HTTP app ---
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Health check
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Map of deviceId -> WebSocket
const devices = new Map();

// List online devices
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

// --- HTTP server + WS upgrade ---
const server = http.createServer(app);

// WebSocket server at /ws?deviceId=XYZ
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
  const { pathname, query } = url.parse(request.url, true);
  if (pathname === "/ws") {
    const deviceId = (query.deviceId || "").toString().trim();
    if (!deviceId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, deviceId);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP+WS server on http://localhost:${PORT}  (WS path: /ws?deviceId=YOUR_ID)`);
});
