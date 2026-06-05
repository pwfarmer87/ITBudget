/* server.js — zero-dependency shared backend for the IT Budget Tracker.
 *
 * Features:
 *   - Per-user accounts with roles: admin / editor / viewer
 *   - Passwords hashed with scrypt; strength policy enforced server-side
 *   - httpOnly session cookies; sessions PERSISTED to disk (survive restarts),
 *     stored as token hashes; optional "remember me" for long-lived sessions
 *   - Login lockout after repeated failures (per account)
 *   - Admin-managed users; first admin via setup screen or env vars
 *   - Budget read = any user; budget write = editor/admin
 *   - Optimistic concurrency on the budget (revision number)
 *   - Audit log of budget changes (who changed what, when)
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
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit.json");

const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 1 day (non-"remember")
const REMEMBER_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days ("remember me")
const MAX_BODY = 8 * 1024 * 1024;

const MAX_FAILED = 5; // failed logins before lockout
const LOCK_MS = 1000 * 60 * 15; // lockout duration: 15 minutes
const AUDIT_CAP = 2000; // max audit entries kept on disk

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

/* ---------- Password policy & hashing ---------- */

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890",
  "qwertyuiop", "letmein", "iloveyou", "admin123", "welcome1", "changeme",
  "passw0rd", "qwerty123", "iloveyou1", "trustno1",
]);

// Returns an error string if invalid, or null if the password is acceptable.
function passwordError(pw, username) {
  pw = String(pw || "");
  if (pw.length < 10) return "Password must be at least 10 characters";
  if (/^(.)\1+$/.test(pw)) return "Password is too repetitive";
  if (username && pw.toLowerCase().includes(String(username).toLowerCase()))
    return "Password must not contain the username";
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return "That password is too common";
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  if (classes < 2) return "Password should mix letters, numbers, or symbols";
  return null;
}

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

/* ---------- Users ---------- */

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
  const pwErr = passwordError(password, username);
  if (pwErr) throw httpError(400, pwErr);
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

function countAdmins(store) {
  return store.users.filter((u) => u.role === "admin").length;
}

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
      console.error("(Password must satisfy the strength policy: 10+ chars, mixed.)");
    }
  }
}

/* ---------- Sessions (persisted; stored as token hashes) ---------- */

const sessions = new Map(); // tokenHash -> { userId, expires }

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function loadSessions() {
  const s = readJson(SESSIONS_FILE, null);
  if (s && s.sessions) {
    const now = Date.now();
    for (const [h, v] of Object.entries(s.sessions)) if (v.expires > now) sessions.set(h, v);
  }
}
function saveSessions() {
  try {
    writeJson(SESSIONS_FILE, { sessions: Object.fromEntries(sessions) });
  } catch {
    /* best-effort */
  }
}
function createSession(userId, remember) {
  const token = crypto.randomBytes(32).toString("hex");
  const ttl = remember ? REMEMBER_TTL_MS : SESSION_TTL_MS;
  sessions.set(hashToken(token), { userId, expires: Date.now() + ttl });
  saveSessions();
  return { token, ttl };
}
function getSession(token) {
  if (!token) return null;
  const h = hashToken(token);
  const s = sessions.get(h);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(h);
    saveSessions();
    return null;
  }
  return s;
}
function destroyToken(token) {
  if (token && sessions.delete(hashToken(token))) saveSessions();
}
function destroyUserSessions(userId) {
  let changed = false;
  for (const [h, s] of sessions) if (s.userId === userId) (sessions.delete(h), (changed = true));
  if (changed) saveSessions();
}
function currentUser(req) {
  const s = getSession(parseCookies(req).sid);
  if (!s) return null;
  return readUsers().users.find((u) => u.id === s.userId) || null;
}

/* ---------- Login lockout (in-memory, per account) ---------- */

const loginFails = new Map(); // username -> { count, lockedUntil }

function lockState(username) {
  const rec = loginFails.get(username);
  if (rec && rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return { locked: true, retryMs: rec.lockedUntil - Date.now() };
  }
  return { locked: false };
}
function noteFailure(username) {
  const rec = loginFails.get(username) || { count: 0, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= MAX_FAILED) {
    rec.lockedUntil = Date.now() + LOCK_MS;
    rec.count = 0;
  }
  loginFails.set(username, rec);
}
function clearFailures(username) {
  loginFails.delete(username);
}

/* ---------- Audit log ---------- */

function readAudit() {
  const a = readJson(AUDIT_FILE, null);
  return a && Array.isArray(a.entries) ? a : { entries: [] };
}
function appendAudit(entry) {
  const store = readAudit();
  store.entries.push(entry);
  if (store.entries.length > AUDIT_CAP) store.entries = store.entries.slice(-AUDIT_CAP);
  writeJson(AUDIT_FILE, store);
}

// Flatten a budget document into id-keyed lookups for diffing.
function indexBudget(data) {
  const cats = {}, items = {}, subs = {}, years = {}, depts = {};
  if (data) {
    (data.years || []).forEach((y) => {
      years[y.id] = { label: y.label, start: y.start, end: y.end };
      (y.categories || []).forEach((c) => {
        cats[c.id] = { name: c.name, budgetNumber: c.budgetNumber, yearLabel: y.label };
        (c.lineItems || []).forEach((li) => {
          items[li.id] = {
            name: li.name,
            budgetedAmount: Number(li.budgetedAmount) || 0,
            frequency: li.frequency,
            note: li.note || "",
            catName: c.name,
            yearLabel: y.label,
          };
          (li.subitems || []).forEach((s) => {
            subs[s.id] = { name: s.name, actual: Number(s.actual) || 0, liName: li.name };
          });
        });
      });
    });
    (data.otherDepartments || []).forEach((d) => {
      depts[d.id] = { lineItem: d.lineItem, frequency: d.frequency, budgetNumber: d.budgetNumber, note: d.note };
    });
  }
  return { cats, items, subs, years, depts };
}

function diffBudget(prev, next) {
  if (!prev) return ["Initialized the budget"];
  const A = indexBudget(prev);
  const B = indexBudget(next);
  const m = [];
  const money = (n) => "$" + (Number(n) || 0).toLocaleString("en-US");

  for (const id in B.years)
    if (!A.years[id]) m.push(`Added fiscal year "${B.years[id].label}"`);
    else {
      const a = A.years[id], b = B.years[id];
      if (a.label !== b.label) m.push(`Renamed fiscal year "${a.label}" to "${b.label}"`);
      if (a.start !== b.start || a.end !== b.end) m.push(`Changed dates for "${b.label}"`);
    }
  for (const id in A.years) if (!B.years[id]) m.push(`Deleted fiscal year "${A.years[id].label}"`);

  for (const id in B.cats)
    if (!A.cats[id]) m.push(`Added category "${B.cats[id].name}" (${B.cats[id].yearLabel})`);
    else {
      const a = A.cats[id], b = B.cats[id];
      if (a.name !== b.name) m.push(`Renamed category "${a.name}" to "${b.name}"`);
      if (a.budgetNumber !== b.budgetNumber) m.push(`Changed budget number of "${b.name}"`);
    }
  for (const id in A.cats) if (!B.cats[id]) m.push(`Deleted category "${A.cats[id].name}" (${A.cats[id].yearLabel})`);

  for (const id in B.items) {
    const b = B.items[id];
    if (!A.items[id]) m.push(`Added line item "${b.name}" to "${b.catName}" (${b.yearLabel})`);
    else {
      const a = A.items[id];
      if (a.name !== b.name) m.push(`Renamed line item "${a.name}" to "${b.name}"`);
      if (a.budgetedAmount !== b.budgetedAmount)
        m.push(`Changed budget of "${b.name}" from ${money(a.budgetedAmount)} to ${money(b.budgetedAmount)}`);
      if (a.frequency !== b.frequency) m.push(`Changed frequency of "${b.name}" to ${b.frequency}`);
      if (a.note !== b.note) m.push(`Updated note on "${b.name}"`);
    }
  }
  for (const id in A.items) if (!B.items[id]) m.push(`Deleted line item "${A.items[id].name}" from "${A.items[id].catName}"`);

  for (const id in B.subs) {
    const b = B.subs[id];
    if (!A.subs[id]) m.push(`Added expense "${b.name}" (${money(b.actual)}) under "${b.liName}"`);
    else {
      const a = A.subs[id];
      if (a.actual !== b.actual || a.name !== b.name)
        m.push(`Updated expense "${b.name}" under "${b.liName}" to ${money(b.actual)}`);
    }
  }
  for (const id in A.subs) if (!B.subs[id]) m.push(`Removed expense "${A.subs[id].name}" (${money(A.subs[id].actual)}) under "${A.subs[id].liName}"`);

  for (const id in B.depts)
    if (!A.depts[id]) m.push(`Added department line "${B.depts[id].lineItem}"`);
    else if (JSON.stringify(A.depts[id]) !== JSON.stringify(B.depts[id]))
      m.push(`Updated department line "${B.depts[id].lineItem}"`);
  for (const id in A.depts) if (!B.depts[id]) m.push(`Deleted department line "${A.depts[id].lineItem}"`);

  return m;
}

/* ---------- HTTP helpers ---------- */

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
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
function sessionCookie(token, maxAgeSec, persistent) {
  const attrs = [`sid=${token}`, "HttpOnly", "Path=/", "SameSite=Lax"];
  if (maxAgeSec === 0) attrs.push("Max-Age=0");
  else if (persistent) attrs.push(`Max-Age=${maxAgeSec}`); // else: session cookie
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
  } catch {
    throw httpError(400, "Invalid JSON");
  }
}

/* ---------- Auth routes ---------- */

async function handleAuth(req, res, sub) {
  if (sub === "status" && req.method === "GET") {
    const store = readUsers();
    const user = currentUser(req);
    return sendJson(res, 200, { setupRequired: store.users.length === 0, user: user ? publicUser(user) : null });
  }

  if (sub === "setup" && req.method === "POST") {
    if (readUsers().users.length) throw httpError(409, "Setup has already been completed");
    const body = await readJsonBody(req);
    const user = createUser({ username: body.username, password: body.password, displayName: body.displayName, role: "admin" });
    const { token, ttl } = createSession(user.id, !!body.remember);
    return sendJson(res, 200, { user: publicUser(user) }, { "Set-Cookie": sessionCookie(token, ttl / 1000, !!body.remember) });
  }

  if (sub === "login" && req.method === "POST") {
    const body = await readJsonBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const lock = lockState(username);
    if (lock.locked)
      throw httpError(429, `Too many failed attempts. Try again in ${Math.ceil(lock.retryMs / 60000)} minute(s).`);

    const store = readUsers();
    const user = store.users.find((u) => u.username === username);
    const ok = user
      ? verifyPassword(String(body.password || ""), user.salt, user.hash)
      : (hashPassword(String(body.password || "")), false); // constant-ish work
    if (!ok) {
      noteFailure(username);
      throw httpError(401, "Incorrect username or password");
    }
    clearFailures(username);
    const { token, ttl } = createSession(user.id, !!body.remember);
    return sendJson(res, 200, { user: publicUser(user) }, { "Set-Cookie": sessionCookie(token, ttl / 1000, !!body.remember) });
  }

  if (sub === "logout" && req.method === "POST") {
    destroyToken(parseCookies(req).sid);
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0, false) });
  }

  if (sub === "password" && req.method === "POST") {
    const user = currentUser(req);
    if (!user) throw httpError(401, "Not signed in");
    const body = await readJsonBody(req);
    if (!verifyPassword(String(body.currentPassword || ""), user.salt, user.hash))
      throw httpError(403, "Current password is incorrect");
    const pwErr = passwordError(body.newPassword, user.username);
    if (pwErr) throw httpError(400, pwErr);
    const store = readUsers();
    const rec = store.users.find((u) => u.id === user.id);
    Object.assign(rec, hashPassword(String(body.newPassword)));
    writeUsers(store);
    return sendJson(res, 200, { ok: true });
  }

  throw httpError(404, "Unknown auth route");
}

/* ---------- User management (admin) ---------- */

async function handleUsers(req, res, idPart) {
  const actor = currentUser(req);
  if (!actor) throw httpError(401, "Not signed in");
  if (actor.role !== "admin") throw httpError(403, "Admin access required");

  if (!idPart && req.method === "GET") return sendJson(res, 200, { users: readUsers().users.map(publicUser) });

  if (!idPart && req.method === "POST") {
    const body = await readJsonBody(req);
    const user = createUser({ username: body.username, password: body.password, displayName: body.displayName, role: body.role });
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (idPart && req.method === "PUT") {
    const body = await readJsonBody(req);
    const store = readUsers();
    const rec = store.users.find((u) => u.id === idPart);
    if (!rec) throw httpError(404, "User not found");
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) throw httpError(400, "Invalid role");
      if (rec.role === "admin" && body.role !== "admin" && countAdmins(store) <= 1)
        throw httpError(400, "At least one admin is required");
      rec.role = body.role;
    }
    if (body.displayName !== undefined) rec.displayName = String(body.displayName).trim();
    if (body.password !== undefined && body.password !== "") {
      const pwErr = passwordError(body.password, rec.username);
      if (pwErr) throw httpError(400, pwErr);
      Object.assign(rec, hashPassword(String(body.password)));
      destroyUserSessions(rec.id);
    }
    writeUsers(store);
    return sendJson(res, 200, { user: publicUser(rec) });
  }

  if (idPart && req.method === "DELETE") {
    const store = readUsers();
    const rec = store.users.find((u) => u.id === idPart);
    if (!rec) throw httpError(404, "User not found");
    if (rec.id === actor.id) throw httpError(400, "You can't delete your own account");
    if (rec.role === "admin" && countAdmins(store) <= 1) throw httpError(400, "At least one admin is required");
    store.users = store.users.filter((u) => u.id !== idPart);
    writeUsers(store);
    destroyUserSessions(idPart);
    return sendJson(res, 200, { ok: true });
  }

  throw httpError(405, "Method not allowed");
}

/* ---------- Budget ---------- */

async function handleBudget(req, res) {
  const user = currentUser(req);
  if (!user) throw httpError(401, "Not signed in");

  if (req.method === "GET") return sendJson(res, 200, readBudget());

  if (req.method === "PUT") {
    if (user.role !== "editor" && user.role !== "admin") throw httpError(403, "Your account is read-only");
    const payload = await readJsonBody(req);
    if (typeof payload.rev !== "number" || !payload.data) throw httpError(400, "Expected { rev, data }");
    const cur = readBudget();
    if (payload.rev !== cur.rev) return sendJson(res, 409, { rev: cur.rev, data: cur.data });

    const next = { rev: cur.rev + 1, data: payload.data };
    writeBudget(next);

    const changes = diffBudget(cur.data, payload.data);
    if (changes.length) {
      const capped = changes.slice(0, 40);
      if (changes.length > capped.length) capped.push(`…and ${changes.length - capped.length} more change(s)`);
      appendAudit({
        ts: new Date().toISOString(),
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        rev: next.rev,
        changes: capped,
      });
    }
    return sendJson(res, 200, { rev: next.rev });
  }

  throw httpError(405, "Method not allowed");
}

/* ---------- Audit route (any signed-in user) ---------- */

async function handleAudit(req, res) {
  const user = currentUser(req);
  if (!user) throw httpError(401, "Not signed in");
  if (req.method !== "GET") throw httpError(405, "Method not allowed");
  const url = new URL(req.url, "http://localhost");
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1), 1000);
  const all = readAudit().entries;
  return sendJson(res, 200, { entries: all.slice(-limit).reverse() });
}

/* ---------- Static files ---------- */

function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
  let pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname === "/") pathname = "/index.html";

  const segments = pathname.split("/").filter(Boolean);
  const denied = segments.some((s) => s.startsWith(".")) || pathname === "/server.js" || pathname === "/package.json";

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
    if (pathname.startsWith("/api/auth/")) await handleAuth(req, res, pathname.slice("/api/auth/".length));
    else if (pathname === "/api/users") await handleUsers(req, res, null);
    else if (pathname.startsWith("/api/users/")) await handleUsers(req, res, pathname.slice("/api/users/".length));
    else if (pathname === "/api/budget") await handleBudget(req, res);
    else if (pathname === "/api/audit") await handleAudit(req, res);
    else serveStatic(req, res);
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
  }
});

loadSessions();
maybeBootstrapAdmin();
server.listen(PORT, () => {
  console.log(`IT Budget Tracker running at http://localhost:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  const n = readUsers().users.length;
  console.log(n ? `${n} user account(s) configured.` : "No users yet — first visit will show the setup screen.");
  if (COOKIE_SECURE) console.log("Secure cookies enabled (serve over HTTPS).");
});
