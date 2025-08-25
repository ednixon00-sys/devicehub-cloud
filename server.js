// server.js — HTTPS poll-based command server (no WebSockets)
// Works perfectly behind DigitalOcean App Platform

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";

const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(bodyParser.json());

// In-memory command queues: deviceId -> array of commands
const queues = new Map();

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

// Health check for DO
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Device polls here every 2s
app.get("/api/pull", (req, res) => {
  const deviceId = (req.query.deviceId || "").toString().trim();
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });

  const cmd = dequeue(deviceId);
  if (!cmd) return res.json({ command: null });

  return res.json({ command: cmd });
});

// Admin/API pushes a command for a device
app.post("/api/command", (req, res) => {
  const { deviceId, command } = req.body || {};
  if (!deviceId || !command) {
    return res.status(400).json({ error: "deviceId and command are required" });
  }
  enqueue(deviceId, command);
  return res.json({ ok: true });
});

// (Optional) view queue lengths
app.get("/api/queues", (_req, res) => {
  const view = {};
  for (const [k, v] of queues.entries()) view[k] = v.length;
  res.json(view);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP polling server running on :${PORT}`);
});
