import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import fs from "fs/promises";
import path from "path";
import http from "http";
import os from "os";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 3001;
const AGENT_TOKEN = process.env.AGENT_TOKEN || "secrets";
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
console.log(`🔒 Auth token loaded`);

/* ================= UTILS ================= */

function assertAuth(_req: express.Request, _res: express.Response) {
  // ✅ Auth volontairement désactivée (comme demandé)
  return true;
}

function safePath(p: string) {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error("Invalid path");
  }
  return resolved;
}

/* ================= APP ================= */

const app = express();

/* ======================================================
   ✅ CORS — DOIT ÊTRE TOUT EN HAUT
   ====================================================== */

app.use(
  cors({
    origin: (origin, cb) => {
      if (
        !origin ||
        origin.includes(".app.github.dev") ||
        origin.includes("localhost")
      ) {
        cb(null, origin);
      } else {
        cb(new Error("CORS blocked"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);

// ⚠️ OBLIGATOIRE pour GitHub Codespaces
app.options("*", cors());

/* ================= MIDDLEWARES ================= */

app.use(express.json({ limit: "10mb" }));

app.use((req, _res, next) => {
  console.log(`${req.method} ${req.url} - Origin: ${req.headers.origin || "none"}`);
  next();
});

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
  if (!assertAuth(req, res)) return;

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
  if (!assertAuth(req, res)) return;

  try {
    const filePath = safePath(req.body.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, req.body.content, "utf8");
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/* ---- DELETE FILE ---- */
app.delete("/api/files", async (req, res) => {
  if (!assertAuth(req, res)) return;

  try {
    const filePath = safePath(req.query.path as string);
    await fs.rm(filePath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/* ================= SERVER ================= */

const server = http.createServer(app);

/* ================= WEBSOCKET ================= */

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  const shell = pty.spawn(process.platform === "win32" ? "powershell.exe" : "bash", [], {
    cwd: WORKDIR,
    env: process.env,
  });

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

/* ---- WS AUTH ---- */
server.on("upgrade", (req, socket, head) => {
  if (req.headers.authorization !== `Bearer ${AGENT_TOKEN}`) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

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
║   CORS: OK (Codespaces compatible)  ║
╚══════════════════════════════════════╝
`);
});
