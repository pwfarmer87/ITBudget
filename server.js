/* server.js — zero-dependency shared backend for the IT Budget Tracker.
 *
 * Serves the static app and a tiny JSON API that stores the whole budget
 * document on disk so a team can share one budget. Concurrency is handled
 * with an optimistic revision number: each successful write bumps `rev`, and
 * a client that saves against a stale `rev` gets a 409 with the latest data
 * instead of overwriting someone else's change.
 *
 * Run:  node server.js     (listens on PORT, default 3000)
 * Optional shared secret:  BUDGET_TOKEN=... node server.js
 *   -> clients must send the same value in the `x-budget-token` header.
 *
 * No external dependencies — Node's built-in modules only.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "budget.json");
const TOKEN = process.env.BUDGET_TOKEN || ""; // empty = no auth
const MAX_BODY = 8 * 1024 * 1024; // 8 MB safety cap

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/* ---------- Persistence (atomic) ---------- */

function readStore() {
  try {
    const env = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return { rev: env.rev || 0, data: env.data ?? null };
  } catch {
    return { rev: 0, data: null }; // no file yet
  }
}

function writeStore(env) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Write to a temp file then rename so a crash mid-write can't corrupt data.
  const tmp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(env));
  fs.renameSync(tmp, DATA_FILE);
}

/* ---------- Helpers ---------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function authOk(req) {
  if (!TOKEN) return true;
  return req.headers["x-budget-token"] === TOKEN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ---------- API ---------- */

async function handleApi(req, res) {
  if (!authOk(req)) return sendJson(res, 401, { error: "Unauthorized" });

  if (req.method === "GET") {
    return sendJson(res, 200, readStore());
  }

  if (req.method === "PUT") {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      return sendJson(res, 400, { error: "Invalid JSON: " + err.message });
    }
    if (!payload || typeof payload.rev !== "number" || !payload.data) {
      return sendJson(res, 400, { error: "Expected { rev, data }" });
    }
    const cur = readStore();
    if (payload.rev !== cur.rev) {
      // Stale write — return latest so the client can reconcile.
      return sendJson(res, 409, { rev: cur.rev, data: cur.data });
    }
    const next = { rev: cur.rev + 1, data: payload.data };
    try {
      writeStore(next);
    } catch (err) {
      return sendJson(res, 500, { error: "Failed to save: " + err.message });
    }
    return sendJson(res, 200, { rev: next.rev });
  }

  return sendJson(res, 405, { error: "Method not allowed" });
}

/* ---------- Static files ---------- */

function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }
  let pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname === "/") pathname = "/index.html";

  // Refuse dotfiles/dot-dirs (e.g. .git), the server source, and the data dir.
  const segments = pathname.split("/").filter(Boolean);
  const denied =
    segments.some((s) => s.startsWith(".")) ||
    pathname === "/server.js" ||
    pathname === "/package.json";

  // Resolve within ROOT and refuse anything that escapes it or touches /data.
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (
    denied ||
    !filePath.startsWith(ROOT + path.sep) ||
    filePath.startsWith(DATA_DIR + path.sep)
  ) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  });
}

/* ---------- Server ---------- */

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/api/budget") {
    handleApi(req, res).catch((err) => sendJson(res, 500, { error: err.message }));
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`IT Budget Tracker running at http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  if (TOKEN) console.log("Shared-secret auth is ENABLED (x-budget-token required).");
});
