import express from "express";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import fs from "fs/promises";
import path from "path";
import http from "http";
import os from "os";

/* ================= CONFIG ================= */

const PORT = process.env.PORT || 3001;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

async function determineWorkdir() {
  const cwd = process.cwd();
  if (cwd.endsWith(".codespace-agent")) {
    return path.dirname(cwd);
  }
  return cwd;
}

const WORKDIR = await determineWorkdir();

console.log(`📁 Working directory: ${WORKDIR}`);

/* ================= UTILS ================= */

function safePath(p: string) {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error("Invalid path");
  }
  return resolved;
}

/* ================= APP ================= */

const app = express();

/* ================= ROUTES ================= */

/* ---- HEALTH ---- */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    platform: os.platform(),
    node: process.version,
    workdir: WORKDIR,
  });
});

/* ---- READ FILE ---- */
app.get("/api/files", async (req, res) => {
  try {
    const filePath = safePath(req.query.path as string);
    const content = await fs.readFile(filePath, "utf8");
    res.json({ path: req.query.path, content });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/* ---- WRITE FILE ---- */
app.post("/api/files", async (req, res) => {
  try {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_FILE_SIZE) {
        req.destroy();
      }
    });

    req.on("end", async () => {
      const { path: p, content } = JSON.parse(body);
      const filePath = safePath(p);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
      res.json({ success: true });
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/* ---- DELETE FILE ---- */
app.delete("/api/files", async (req, res) => {
  try {
    const filePath = safePath(req.query.path as string);
    await fs.rm(filePath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/* ---- LIST DIRECTORY CONTENTS ---- */
app.get("/api/dir/files", async (req, res) => {
  try {
    const dirPath = safePath((req.query.path as string) || ".");
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    const result = entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    }));

    res.json({
      path: req.query.path || ".",
      entries: result,
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});


/* ================= SERVER ================= */

const server = http.createServer(app);

/* ================= WEBSOCKET ================= */

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  const shell = pty.spawn(
    process.platform === "win32" ? "powershell.exe" : "bash",
    [],
    {
      cwd: WORKDIR,
      env: process.env,
    }
  );

  shell.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  ws.on("message", (msg) => {
    shell.write(msg.toString());
  });

  ws.on("close", () => {
    shell.kill();
  });
});

/* ---- WS UPGRADE (NO AUTH) ---- */
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws/terminal") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

/* ================= START ================= */

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   ✅ Codespace Agent Running         ║
╠══════════════════════════════════════╣
║   Port: ${PORT}                     ║
║   Security: NONE                    ║
╚══════════════════════════════════════╝
`);
});
