/* storage.js — persistence, seed data, and migrations for the IT Budget Tracker.
 *
 * When served by server.js, all data lives on the shared backend (one budget
 * for the whole team) and this layer syncs to it: writes are debounced and
 * pushed with an optimistic revision number; concurrent edits are detected as
 * conflicts; light polling keeps multiple viewers in sync.
 *
 * When opened directly from disk (file://) with no backend reachable, it
 * transparently falls back to the browser's localStorage as a single-user
 * store, so the app still works standalone.
 *
 * Data model (v2) — see the migrate() notes below.
 */

const STORAGE_KEY = "it-budget-tracker:v1"; // local cache / offline fallback
const API = "/api/budget";

const FREQUENCIES = ["As Needed", "Monthly", "Yearly", "Other"];

/* The seven high-level categories requested, with their budget numbers. */
const SEED_CATEGORIES = [
  { name: "Student wages", budgetNumber: "1.1.65.6500.5015.0000" },
  { name: "Contract services", budgetNumber: "1.1.65.6500.5360.0000" },
  { name: "Contract services - Bandwidth and telephone", budgetNumber: "1.1.65.6500.5363.0000" },
  { name: "Equipment", budgetNumber: "1.1.65.6500.5435.0000" },
  { name: "Software licensing", budgetNumber: "1.1.65.6500.5601.0000" },
  { name: "Contingency", budgetNumber: "1.1.65.6500.5730.0000" },
  { name: "Hardware infrastructure", budgetNumber: "1.1.65.6500.5625.0000" },
];

function uid() {
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function genKey() {
  return "k-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function seedYear() {
  return {
    id: uid(),
    label: "Fiscal Year 2027",
    start: "2026-06-01",
    end: "2027-05-30",
    categories: SEED_CATEGORIES.map((c) => ({
      id: uid(),
      key: genKey(),
      name: c.name,
      budgetNumber: c.budgetNumber,
      lineItems: [],
    })),
  };
}

function defaultData() {
  const year = seedYear();
  return {
    version: 2,
    activeYearId: year.id,
    years: [year],
    otherDepartments: [],
  };
}

/* Migrate older shapes forward so existing saved data is never lost.
 * v1 stored a single year as top-level { fiscalYear, categories, otherDepartments }.
 * v2 stores { version, activeYearId, years:[{id,label,start,end,categories}], otherDepartments }.
 * `key` is a STABLE id preserved across yearly roll-forwards for reporting. */
function migrate(data) {
  if (!data || typeof data !== "object") return defaultData();

  if (!data.years && Array.isArray(data.categories)) {
    const fy = data.fiscalYear || { label: "Fiscal Year 2027", start: "2026-06-01", end: "2027-05-30" };
    const year = { id: uid(), label: fy.label, start: fy.start, end: fy.end, categories: data.categories };
    data = { version: 2, activeYearId: year.id, years: [year], otherDepartments: data.otherDepartments || [] };
  }

  (data.years || []).forEach((y) => {
    (y.categories || []).forEach((c) => {
      if (!c.key) c.key = genKey();
      (c.lineItems || []).forEach((li) => {
        if (!li.key) li.key = genKey();
        li.subitems = li.subitems || [];
      });
    });
  });

  if (!data.activeYearId && data.years && data.years.length) data.activeYearId = data.years[0].id;
  data.otherDepartments = data.otherDepartments || [];
  data.version = 2;
  return data;
}

/* ============================================================
 * Sync engine
 * ============================================================ */

const Storage = {
  _rev: 0, // server revision we are currently synced to
  _online: false, // is a backend reachable?
  _saving: false,
  _dirty: false,
  _timer: null,
  _latest: null, // most recent data snapshot to push
  _handlers: { status: () => {}, conflict: () => {}, remote: () => {}, authRequired: () => {} },

  setHandlers(h) {
    Object.assign(this._handlers, h);
  },

  _setStatus(s) {
    this._handlers.status(s);
  },

  cacheLocal(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* storage may be unavailable on file:// — ignore */
    }
  },

  async load() {
    try {
      const res = await fetch(API, { credentials: "same-origin" });
      if (res.status === 401) {
        this._online = true;
        this._handlers.authRequired();
        throw new Error("auth");
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const env = await res.json();
      this._online = true;
      this._rev = env.rev || 0;

      if (env.data) {
        const d = migrate(env.data);
        this.cacheLocal(d);
        this._setStatus("synced");
        return d;
      }

      // Backend has no data yet — seed it.
      const d = defaultData();
      const put = await fetch(API, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rev: this._rev, data: d }),
      });
      if (put.status === 200) {
        this._rev = (await put.json()).rev;
      } else if (put.status === 409) {
        const e = await put.json();
        this._rev = e.rev;
        if (e.data) {
          const sd = migrate(e.data);
          this.cacheLocal(sd);
          this._setStatus("synced");
          return sd;
        }
      }
      this.cacheLocal(d);
      this._setStatus("synced");
      return d;
    } catch (err) {
      if (err && err.message === "auth") {
        // A backend is present but we're not signed in — let the app show login.
        return null;
      }
      // No backend (e.g. opened as a file) — fall back to local storage.
      this._online = false;
      this._setStatus("local");
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return migrate(JSON.parse(raw));
      } catch {
        /* ignore */
      }
      return defaultData();
    }
  },

  // Called by the app on every mutation. Caches immediately, pushes (debounced).
  save(data) {
    this._latest = data;
    this.cacheLocal(data);
    if (!this._online) return; // local-only mode: cache is the source of truth
    this._dirty = true;
    this._setStatus("saving");
    if (!this._timer) this._timer = setTimeout(() => this._flush(), 400);
  },

  async _flush() {
    this._timer = null;
    if (this._saving) {
      // A push is in flight; re-arm so the newest snapshot gets sent after.
      this._timer = setTimeout(() => this._flush(), 200);
      return;
    }
    if (!this._dirty) return;
    this._saving = true;
    this._dirty = false;
    const snapshot = this._latest;
    try {
      const res = await fetch(API, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rev: this._rev, data: snapshot }),
      });
      if (res.status === 401) {
        this._setStatus("conflict");
        this._handlers.authRequired();
        return;
      }
      if (res.status === 200) {
        this._rev = (await res.json()).rev;
        this._setStatus(this._dirty ? "saving" : "synced");
      } else if (res.status === 409) {
        const env = await res.json();
        this._rev = env.rev;
        this._dirty = false;
        this._setStatus("conflict");
        this._handlers.conflict(env.data ? migrate(env.data) : null);
      } else {
        throw new Error("HTTP " + res.status);
      }
    } catch (err) {
      this._online = false;
      this._setStatus("local");
    } finally {
      this._saving = false;
      if (this._dirty && this._online) this._timer = setTimeout(() => this._flush(), 200);
    }
  },

  // Pull the latest from the server; used by polling. Returns data if the
  // server has advanced beyond what we last saw, otherwise null.
  async poll() {
    if (!this._online || this._saving || this._dirty) return null;
    try {
      const res = await fetch(API, { credentials: "same-origin" });
      if (res.status === 401) {
        this._handlers.authRequired();
        return null;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const env = await res.json();
      if ((env.rev || 0) !== this._rev && env.data) {
        this._rev = env.rev;
        const d = migrate(env.data);
        this.cacheLocal(d);
        return d;
      }
      return null;
    } catch {
      this._online = false;
      this._setStatus("local");
      return null;
    }
  },

  export(data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `it-budget-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  import(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          const migrated = migrate(parsed);
          if (!Array.isArray(migrated.years) || !migrated.years.length) {
            throw new Error("File does not look like a budget export.");
          }
          resolve(migrated);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  },
};

/* ============================================================
 * Auth + user management API client
 * ============================================================ */

async function apiJson(url, options = {}) {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    const msg = (body && body.error) || "Request failed (" + res.status + ")";
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

const Auth = {
  status() {
    return apiJson("/api/auth/status");
  },
  setup(payload) {
    return apiJson("/api/auth/setup", { method: "POST", body: JSON.stringify(payload) });
  },
  login(username, password) {
    return apiJson("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  },
  logout() {
    return apiJson("/api/auth/logout", { method: "POST", body: "{}" });
  },
  changePassword(currentPassword, newPassword) {
    return apiJson("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },
};

const Users = {
  list() {
    return apiJson("/api/users");
  },
  create(payload) {
    return apiJson("/api/users", { method: "POST", body: JSON.stringify(payload) });
  },
  update(id, payload) {
    return apiJson("/api/users/" + encodeURIComponent(id), {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },
  remove(id) {
    return apiJson("/api/users/" + encodeURIComponent(id), { method: "DELETE" });
  },
};
