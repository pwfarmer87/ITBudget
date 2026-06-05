/* server.js — zero-dependency shared backend for the IT Budget Tracker.
 *
 * Serves the static app and a JSON API with real per-user login:
 *   - Accounts with roles: admin / editor / viewer
 *   - Passwords hashed with scrypt (Node's built-in crypto)
 *   - httpOnly session cookies; sessions kept in memory
 *   - Admin-managed users; first admin created via a one-time setup screen
 *     (or ADMIN_USER / ADMIN_PASSWORD env vars on first run)
 *   - Budget read = any logged-in user; budget write = editor or admin
 *   - Optimistic concurrency on the budget (revision number)
 *
 * Run:  node server.js            (PORT, default 3000)
 * First admin via env (optional):  ADMIN_USER=alice ADMIN_PASSWORD=secret node server.js
 * Behind HTTPS, set COOKIE_SECURE=1 so the session cookie is marked Secure.
 *
 * No external dependencies — Node's built-in modules only.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const BUDGET_FILE = path.join(DATA_DIR, "budget.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const MAX_BODY = 8 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const ROLES = ["viewer", "editor", "admin"];

/* ---------- Persistence (atomic) ---------- */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function readBudget() {
  const env = readJson(BUDGET_FILE, null);
  return env ? { rev: env.rev || 0, data: env.data ?? null } : { rev: 0, data: null };
}
function writeBudget(env) {
  writeJson(BUDGET_FILE, env);
}

function readUsers() {
  const u = readJson(USERS_FILE, null);
  return u && Array.isArray(u.users) ? u : { users: [] };
}
function writeUsers(store) {
  writeJson(USERS_FILE, store);
}

/* ---------- Passwords & users ---------- */

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, createdAt: u.createdAt };
}

function createUser({ username, password, displayName, role }) {
  const store = readUsers();
  username = String(username || "").trim().toLowerCase();
  if (!username) throw httpError(400, "Username is required");
  if (!/^[a-z0-9._-]{2,32}$/.test(username))
    throw httpError(400, "Username must be 2–32 chars: letters, numbers, . _ -");
  if (store.users.some((u) => u.username === username))
    throw httpError(409, "That username already exists");
  if (!password || String(password).length < 8)
    throw httpError(400, "Password must be at least 8 characters");
  if (!ROLES.includes(role)) role = "viewer";
  const { salt, hash } = hashPassword(String(password));
  const user = {
    id: "u-" + crypto.randomBytes(8).toString("hex"),
    username,
    displayName: String(displayName || username).trim(),
    role,
    salt,
    hash,
    createdAt: new Date().toISOString(),
  };
  store.users.push(user);
  writeUsers(store);
  return user;
}

// Bootstrap an admin from env vars on first run if no users exist yet.
function maybeBootstrapAdmin() {
  const store = readUsers();
  if (store.users.length) return;
  const u = process.env.ADMIN_USER;
  const p = process.env.ADMIN_PASSWORD;
  if (u && p) {
    try {
      createUser({ username: u, password: p, displayName: u, role: "admin" });
      console.log(`Bootstrapped admin "${u}" from environment variables.`);
    } catch (err) {
      console.error("Failed to bootstrap admin from env:", err.message);
    }
  }
}

/* ---------- Sessions (in-memory) ---------- */

const sessions = new Map(); // token -> { userId, expires }

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId, expires: Date.now() + SESSION_TTL_MS });
  return token;
}
function getSession(token) {
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}
function destroyUserSessions(userId) {
  for (const [token, s] of sessions) if (s.userId === userId) sessions.delete(token);
}

function currentUser(req) {
  const token = parseCookies(req).sid;
  const s = getSession(token);
  if (!s) return null;
  return readUsers().users.find((u) => u.id === s.userId) || null;
}

/* ---------- HTTP helpers ---------- */

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(obj));
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function sessionCookie(token, maxAgeSec) {
  const attrs = [
    `sid=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (COOKIE_SECURE) attrs.push("Secure");
  return attrs.join("; ");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError(413, "Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    throw httpError(400, "Invalid JSON");
  }
}

/* ---------- Auth routes ---------- */

async function handleAuth(req, res, sub) {
  // GET /api/auth/status — what should the UI show?
  if (sub === "status" && req.method === "GET") {
    const store = readUsers();
    const user = currentUser(req);
    return sendJson(res, 200, {
      setupRequired: store.users.length === 0,
      user: user ? publicUser(user) : null,
    });
  }

  // POST /api/auth/setup — create the first admin (only when no users exist)
  if (sub === "setup" && req.method === "POST") {
    if (readUsers().users.length) throw httpError(409, "Setup has already been completed");
    const body = await readJsonBody(req);
    const user = createUser({
      username: body.username,
      password: body.password,
      displayName: body.displayName,
      role: "admin",
    });
    const token = createSession(user.id);
    return sendJson(res, 200, { user: publicUser(user) }, {
      "Set-Cookie": sessionCookie(token, SESSION_TTL_MS / 1000),
    });
  }

  // POST /api/auth/login
  if (sub === "login" && req.method === "POST") {
    const body = await readJsonBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const store = readUsers();
    const user = store.users.find((u) => u.username === username);
    // Always run a hash to reduce username-enumeration timing differences.
    const ok = user
      ? verifyPassword(String(body.password || ""), user.salt, user.hash)
      : (hashPassword(String(body.password || "")), false);
    if (!ok) throw httpError(401, "Incorrect username or password");
    const token = createSession(user.id);
    return sendJson(res, 200, { user: publicUser(user) }, {
      "Set-Cookie": sessionCookie(token, SESSION_TTL_MS / 1000),
    });
  }

  // POST /api/auth/logout
  if (sub === "logout" && req.method === "POST") {
    const token = parseCookies(req).sid;
    if (token) sessions.delete(token);
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
  }

  // POST /api/auth/password — change own password
  if (sub === "password" && req.method === "POST") {
    const user = currentUser(req);
    if (!user) throw httpError(401, "Not signed in");
    const body = await readJsonBody(req);
    if (!verifyPassword(String(body.currentPassword || ""), user.salt, user.hash))
      throw httpError(403, "Current password is incorrect");
    if (!body.newPassword || String(body.newPassword).length < 8)
      throw httpError(400, "New password must be at least 8 characters");
    const store = readUsers();
    const rec = store.users.find((u) => u.id === user.id);
    Object.assign(rec, hashPassword(String(body.newPassword)));
    writeUsers(store);
    return sendJson(res, 200, { ok: true });
  }

  throw httpError(404, "Unknown auth route");
}

/* ---------- User management (admin only) ---------- */

async function handleUsers(req, res, idPart) {
  const actor = currentUser(req);
  if (!actor) throw httpError(401, "Not signed in");
  if (actor.role !== "admin") throw httpError(403, "Admin access required");

  // GET /api/users
  if (!idPart && req.method === "GET") {
    return sendJson(res, 200, { users: readUsers().users.map(publicUser) });
  }

  // POST /api/users — create
  if (!idPart && req.method === "POST") {
    const body = await readJsonBody(req);
    const user = createUser({
      username: body.username,
      password: body.password,
      displayName: body.displayName,
      role: body.role,
    });
    return sendJson(res, 200, { user: publicUser(user) });
  }

  // PUT /api/users/:id — update role / displayName / reset password
  if (idPart && req.method === "PUT") {
    const body = await readJsonBody(req);
    const store = readUsers();
    const rec = store.users.find((u) => u.id === idPart);
    if (!rec) throw httpError(404, "User not found");
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) throw httpError(400, "Invalid role");
      // Don't allow removing the last admin.
      if (rec.role === "admin" && body.role !== "admin" && countAdmins(store) <= 1)
        throw httpError(400, "At least one admin is required");
      rec.role = body.role;
    }
    if (body.displayName !== undefined) rec.displayName = String(body.displayName).trim();
    if (body.password !== undefined && body.password !== "") {
      if (String(body.password).length < 8) throw httpError(400, "Password must be at least 8 characters");
      Object.assign(rec, hashPassword(String(body.password)));
      destroyUserSessions(rec.id); // force re-login after a reset
    }
    writeUsers(store);
    return sendJson(res, 200, { user: publicUser(rec) });
  }

  // DELETE /api/users/:id
  if (idPart && req.method === "DELETE") {
    const store = readUsers();
    const rec = store.users.find((u) => u.id === idPart);
    if (!rec) throw httpError(404, "User not found");
    if (rec.id === actor.id) throw httpError(400, "You can't delete your own account");
    if (rec.role === "admin" && countAdmins(store) <= 1)
      throw httpError(400, "At least one admin is required");
    store.users = store.users.filter((u) => u.id !== idPart);
    writeUsers(store);
    destroyUserSessions(idPart);
    return sendJson(res, 200, { ok: true });
  }

  throw httpError(405, "Method not allowed");
}

function countAdmins(store) {
  return store.users.filter((u) => u.role === "admin").length;
}

/* ---------- Budget routes ---------- */

async function handleBudget(req, res) {
  const user = currentUser(req);
  if (!user) throw httpError(401, "Not signed in");

  if (req.method === "GET") {
    return sendJson(res, 200, readBudget());
  }

  if (req.method === "PUT") {
    if (user.role !== "editor" && user.role !== "admin")
      throw httpError(403, "Your account is read-only");
    const payload = await readJsonBody(req);
    if (typeof payload.rev !== "number" || !payload.data)
      throw httpError(400, "Expected { rev, data }");
    const cur = readBudget();
    if (payload.rev !== cur.rev) {
      return sendJson(res, 409, { rev: cur.rev, data: cur.data });
    }
    const next = { rev: cur.rev + 1, data: payload.data };
    writeBudget(next);
    return sendJson(res, 200, { rev: next.rev });
  }

  throw httpError(405, "Method not allowed");
}

/* ---------- Static files ---------- */

function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }
  let pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname === "/") pathname = "/index.html";

  const segments = pathname.split("/").filter(Boolean);
  const denied =
    segments.some((s) => s.startsWith(".")) ||
    pathname === "/server.js" ||
    pathname === "/package.json";

  const filePath = path.normalize(path.join(ROOT, pathname));
  if (denied || !filePath.startsWith(ROOT + path.sep) || filePath.startsWith(DATA_DIR + path.sep)) {
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

/* ---------- Router ---------- */

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  try {
    if (pathname.startsWith("/api/auth/")) {
      await handleAuth(req, res, pathname.slice("/api/auth/".length));
    } else if (pathname === "/api/users") {
      await handleUsers(req, res, null);
    } else if (pathname.startsWith("/api/users/")) {
      await handleUsers(req, res, pathname.slice("/api/users/".length));
    } else if (pathname === "/api/budget") {
      await handleBudget(req, res);
    } else {
      serveStatic(req, res);
    }
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
  }
});

maybeBootstrapAdmin();
server.listen(PORT, () => {
  console.log(`IT Budget Tracker running at http://localhost:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  const n = readUsers().users.length;
  console.log(n ? `${n} user account(s) configured.` : "No users yet — first visit will show the setup screen.");
  if (COOKIE_SECURE) console.log("Secure cookies enabled (serve over HTTPS).");
});
