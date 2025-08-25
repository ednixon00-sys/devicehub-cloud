import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import cors from "cors";
import url from "url";
import crypto from "crypto";

const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Health check
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Track connections
const devices = new Map(); // id -> ws

app.get("/api/devices", (_req, res) => {
  res.json({ online: Array.from(devices.keys()) });
});

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

// WS: accept on ANY path; DO may rewrite/strip parts. Do NOT 400; just log and proceed.
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, request, id) => {
  console.log(`[ws] connected: ${id}`);
  devices.set(id, ws);

  ws.on("message", (msg) => {
    console.log(`[ws:${id}] ${msg.toString()}`);
  });

  ws.on("close", () => {
    console.log(`[ws] closed: ${id}`);
    devices.delete(id);
  });
});

server.on("upgrade", (request, socket, head) => {
  // Log exactly what DO sent us
  const parsed = url.parse(request.url || "", true);
  console.log("[upgrade] url:", request.url);
  console.log("[upgrade] path:", parsed.pathname, "query:", parsed.query);

  // Prefer ?deviceId=... if present, else build a stable-ish fallback
  let id = (parsed.query?.deviceId || "").toString().trim();
  if (!id) {
    // fallback: use x-forwarded-for + random suffix so we never reject
    const xff = request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown";
    id = `${xff}-${crypto.randomBytes(3).toString("hex")}`;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request, id);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP+WS server on :${PORT} (any WS path; id from ?deviceId or fallback)`);
});
