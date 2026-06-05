/* app.js — IT Budget Tracker application logic (multi-year). */

let data; // loaded asynchronously in boot()

// Auth state. In standalone mode (no backend) there is no user and full edit.
let meUser = null; // current signed-in user, or null
let canEdit = true; // editor or admin (true when standalone)
let isAdminUser = false;
let appStarted = false; // guard so polling starts only once

/* ---------- Year helpers ---------- */

function activeYear() {
  return data.years.find((y) => y.id === data.activeYearId) || data.years[0];
}

// Years sorted oldest -> newest (by start date, falling back to label/order).
function yearsChrono() {
  return [...data.years].sort((a, b) => {
    const sa = a.start || "";
    const sb = b.start || "";
    if (sa && sb) return sa.localeCompare(sb);
    return data.years.indexOf(a) - data.years.indexOf(b);
  });
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}/${y}`;
}

/* ---------- Calculation helpers ---------- */

// A line item's Actual is the sum of its subitems' actual costs.
function lineItemActual(li) {
  return (li.subitems || []).reduce((sum, s) => sum + (Number(s.actual) || 0), 0);
}

function lineItemRemaining(li) {
  return (Number(li.budgetedAmount) || 0) - lineItemActual(li);
}

function categoryTotals(cat) {
  return cat.lineItems.reduce(
    (acc, li) => {
      acc.budgeted += Number(li.budgetedAmount) || 0;
      acc.actual += lineItemActual(li);
      return acc;
    },
    { budgeted: 0, actual: 0 }
  );
}

function yearTotals(year) {
  return year.categories.reduce(
    (acc, cat) => {
      const t = categoryTotals(cat);
      acc.budgeted += t.budgeted;
      acc.actual += t.actual;
      return acc;
    },
    { budgeted: 0, actual: 0 }
  );
}

function grandTotals() {
  return yearTotals(activeYear());
}

/* ---------- Formatting ---------- */

function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// Signed money for deltas/savings, e.g. +$1,200 / −$300.
function signedMoney(n) {
  const v = Number(n) || 0;
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return sign + money(Math.abs(v));
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------- Persistence wrapper ---------- */

function commit() {
  Storage.save(data);
}

/* ============================================================
 * DASHBOARD
 * ============================================================ */

function renderDashboard() {
  const year = activeYear();
  const g = grandTotals();
  const remaining = g.budgeted - g.actual;
  const spentPct = pct(g.actual, g.budgeted);

  const cards = [
    { label: "Total Budgeted", value: money(g.budgeted), sub: year.label },
    { label: "Total Actual", value: money(g.actual), sub: `${spentPct}% of budget spent` },
    {
      label: "Budget Remaining",
      value: money(remaining),
      sub: remaining < 0 ? "Over budget" : "Available",
      cls: remaining < 0 ? "is-over" : "is-good",
    },
    {
      label: "Line Items",
      value: String(year.categories.reduce((n, c) => n + c.lineItems.length, 0)),
      sub: `${year.categories.length} categories`,
    },
  ];

  document.getElementById("dashCards").innerHTML = cards
    .map(
      (c) => `
      <div class="stat">
        <div class="stat__label">${c.label}</div>
        <div class="stat__value ${c.cls || ""}">${c.value}</div>
        <div class="stat__sub">${c.sub}</div>
      </div>`
    )
    .join("");

  // Spend by category bars
  const byCat = year.categories
    .map((cat) => {
      const t = categoryTotals(cat);
      const p = pct(t.actual, t.budgeted);
      let fillCls = "";
      if (t.actual > t.budgeted) fillCls = "is-over";
      else if (p >= 85) fillCls = "is-warn";
      const width = t.budgeted ? Math.min(p, 100) : 0;
      return `
        <div class="cat-bar">
          <div class="cat-bar__top">
            <span class="cat-bar__name">${escapeHtml(cat.name)}</span>
            <span class="muted">${money(t.actual)} / ${money(t.budgeted)}${t.budgeted ? ` · ${p}%` : ""}</span>
          </div>
          <div class="cat-bar__track">
            <div class="cat-bar__fill ${fillCls}" style="width:${width}%"></div>
          </div>
        </div>`;
    })
    .join("");
  document.getElementById("dashByCategory").innerHTML =
    byCat || `<p class="muted">No categories yet.</p>`;

  // Alerts
  const alerts = [];
  year.categories.forEach((cat) => {
    const t = categoryTotals(cat);
    if (t.budgeted && t.actual > t.budgeted) {
      alerts.push({
        cls: "over",
        text: `<strong>${escapeHtml(cat.name)}</strong> is over budget by ${money(t.actual - t.budgeted)}.`,
      });
    } else if (t.budgeted && pct(t.actual, t.budgeted) >= 85) {
      alerts.push({
        cls: "warn",
        text: `<strong>${escapeHtml(cat.name)}</strong> has used ${pct(t.actual, t.budgeted)}% of its budget.`,
      });
    }
    cat.lineItems.forEach((li) => {
      if ((Number(li.budgetedAmount) || 0) > 0 && lineItemRemaining(li) < 0) {
        alerts.push({
          cls: "over",
          text: `Line item <strong>${escapeHtml(li.name)}</strong> (${escapeHtml(cat.name)}) is over by ${money(-lineItemRemaining(li))}.`,
        });
      }
    });
  });

  document.getElementById("dashAlerts").innerHTML = alerts.length
    ? alerts.map((a) => `<div class="alert alert--${a.cls}">${a.text}</div>`).join("")
    : `<div class="alert alert--ok">Everything is tracking within budget.</div>`;
}

/* ============================================================
 * BUDGET TRACKER
 * ============================================================ */

// Track which line items are expanded (persisted in memory for the session).
const expanded = new Set();

function renderBudget() {
  const host = document.getElementById("categories");
  const year = activeYear();
  if (!year.categories.length) {
    host.innerHTML = `<p class="muted">No categories yet. Use "Add Category" to begin.</p>`;
    return;
  }

  host.innerHTML = year.categories.map(renderCategory).join("");
  bindBudgetEvents();
}

function renderCategory(cat) {
  const t = categoryTotals(cat);
  const remaining = t.budgeted - t.actual;
  const overCls = remaining < 0 ? "is-over" : "";

  const header = `
    <div class="category__head">
      <div>
        <div class="category__title">${escapeHtml(cat.name)}</div>
        <div class="category__num">${escapeHtml(cat.budgetNumber)}</div>
      </div>
      <div class="category__totals">
        <div class="mini"><div class="mini__label">Budgeted</div><div class="mini__value">${money(t.budgeted)}</div></div>
        <div class="mini"><div class="mini__label">Actual</div><div class="mini__value">${money(t.actual)}</div></div>
        <div class="mini"><div class="mini__label">Remaining</div><div class="mini__value ${overCls}">${money(remaining)}</div></div>
        ${canEdit ? `<div class="category__actions">
          <button class="icon-btn" data-action="edit-cat" data-cat="${cat.id}" title="Edit category">✎</button>
          <button class="icon-btn icon-btn--danger" data-action="del-cat" data-cat="${cat.id}" title="Delete category">🗑</button>
        </div>` : ""}
      </div>
    </div>`;

  const headerRow = `
    <div class="lineitem__row is-header">
      <span></span>
      <span>Line Item</span>
      <span>Frequency</span>
      <span class="num">Budgeted</span>
      <span class="num">Actual</span>
      <span class="num">Remaining</span>
      <span></span>
    </div>`;

  const rows = cat.lineItems.map((li) => renderLineItem(cat, li)).join("");

  const addBtn = canEdit
    ? `<div style="padding:10px 18px;">
        <button class="btn--link" data-action="add-li" data-cat="${cat.id}">+ Add Line Item</button>
      </div>`
    : "";

  return `
    <div class="category" data-cat="${cat.id}">
      ${header}
      <div class="lineitems">
        ${cat.lineItems.length ? headerRow + rows : `<div style="padding:14px 18px;" class="muted">No line items yet.</div>`}
      </div>
      ${addBtn}
    </div>`;
}

function renderLineItem(cat, li) {
  const actual = lineItemActual(li);
  const remaining = lineItemRemaining(li);
  const isOpen = expanded.has(li.id);
  const overCls = remaining < 0 ? "is-over" : "";
  const count = (li.subitems || []).length;

  const row = `
    <div class="lineitem__row">
      <button class="lineitem__toggle" data-action="toggle" data-li="${li.id}" title="Show/hide subitems">${isOpen ? "▾" : "▸"}</button>
      <div>
        <div class="lineitem__name">${escapeHtml(li.name)}</div>
        ${li.note ? `<div class="lineitem__name-note">${escapeHtml(li.note)}</div>` : ""}
      </div>
      <div><span class="lineitem__freq">${escapeHtml(li.frequency || "—")}</span></div>
      <div class="num">${money(li.budgetedAmount)}</div>
      <div class="num">${money(actual)}${count ? ` <span class="muted">(${count})</span>` : ""}</div>
      <div class="num ${overCls}">${money(remaining)}</div>
      <div class="lineitem__actions">
        ${canEdit ? `<button class="icon-btn" data-action="edit-li" data-cat="${cat.id}" data-li="${li.id}" title="Edit line item">✎</button>
        <button class="icon-btn icon-btn--danger" data-action="del-li" data-cat="${cat.id}" data-li="${li.id}" title="Delete line item">🗑</button>` : ""}
      </div>
    </div>`;

  const sub = renderSubitems(li, isOpen);
  return `<div class="lineitem">${row}${sub}</div>`;
}

function renderSubitems(li, isOpen) {
  const subs = li.subitems || [];
  const rows = subs.length
    ? subs
        .map(
          (s) => `
        <div class="subitem-row">
          <div class="subitem__name">${escapeHtml(s.name)}</div>
          <div class="num">${money(s.actual)}</div>
          <div class="subitem__note">${escapeHtml(s.note || "")}</div>
          <div class="lineitem__actions">
            ${canEdit ? `<button class="icon-btn" data-action="edit-sub" data-li="${li.id}" data-sub="${s.id}" title="Edit">✎</button>
            <button class="icon-btn icon-btn--danger" data-action="del-sub" data-li="${li.id}" data-sub="${s.id}" title="Delete">🗑</button>` : ""}
          </div>
        </div>`
        )
        .join("")
    : `<div class="subitems__empty">No expenses entered yet.</div>`;

  // Quick-add inline form (editors only)
  const addForm = canEdit
    ? `<form class="subitem-add" data-action="quick-add-sub" data-li="${li.id}">
        <input class="input" name="name" placeholder="Expense (e.g. May invoice)" required />
        <input class="input num" name="actual" type="number" step="0.01" placeholder="Cost" required />
        <input class="input" name="note" placeholder="Note (optional)" />
        <button class="btn btn--primary btn--sm" type="submit">Add</button>
      </form>`
    : "";

  const headerRow = subs.length
    ? `<div class="subitem-row is-header">
         <span>Expense</span><span class="num">Actual Cost</span><span>Note</span><span></span>
       </div>`
    : "";

  return `<div class="subitems" data-sub-for="${li.id}" ${isOpen ? "" : "hidden"}>${headerRow}${rows}${addForm}</div>`;
}

/* ---------- Budget event binding ---------- */

function bindBudgetEvents() {
  const host = document.getElementById("categories");

  host.querySelectorAll("[data-action]").forEach((el) => {
    const action = el.dataset.action;
    if (action === "quick-add-sub") {
      el.addEventListener("submit", onQuickAddSub);
    } else {
      el.addEventListener("click", onBudgetAction);
    }
  });
}

function onBudgetAction(e) {
  const el = e.currentTarget;
  const action = el.dataset.action;
  switch (action) {
    case "toggle":
      toggleSubitems(el.dataset.li);
      break;
    case "edit-cat":
      openCategoryModal(el.dataset.cat);
      break;
    case "del-cat":
      deleteCategory(el.dataset.cat);
      break;
    case "add-li":
      openLineItemModal(el.dataset.cat, null);
      break;
    case "edit-li":
      openLineItemModal(el.dataset.cat, el.dataset.li);
      break;
    case "del-li":
      deleteLineItem(el.dataset.cat, el.dataset.li);
      break;
    case "edit-sub":
      openSubitemModal(el.dataset.li, el.dataset.sub);
      break;
    case "del-sub":
      deleteSubitem(el.dataset.li, el.dataset.sub);
      break;
  }
}

function toggleSubitems(liId) {
  if (expanded.has(liId)) expanded.delete(liId);
  else expanded.add(liId);
  // Toggle just the affected DOM without a full re-render for snappiness.
  const panel = document.querySelector(`[data-sub-for="${liId}"]`);
  const toggleBtn = document.querySelector(`[data-action="toggle"][data-li="${liId}"]`);
  if (panel) panel.hidden = !expanded.has(liId);
  if (toggleBtn) toggleBtn.textContent = expanded.has(liId) ? "▾" : "▸";
}

function onQuickAddSub(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const liId = form.dataset.li;
  // Use form.elements (not form.name) — form.name resolves to the form's own
  // name property, shadowing the control named "name".
  const name = form.elements.name.value.trim();
  const actual = parseFloat(form.elements.actual.value);
  const note = form.elements.note.value.trim();
  if (!name || isNaN(actual)) return;

  const li = findLineItem(liId);
  if (!li) return;
  li.subitems = li.subitems || [];
  li.subitems.push({ id: uid(), name, actual, note });
  expanded.add(liId);
  commit();
  renderAll();
}

/* ---------- Lookups (scoped to the active year) ---------- */

function findCategory(catId) {
  return activeYear().categories.find((c) => c.id === catId);
}
function findLineItem(liId) {
  for (const c of activeYear().categories) {
    const li = c.lineItems.find((l) => l.id === liId);
    if (li) return li;
  }
  return null;
}

/* ---------- Mutations ---------- */

function deleteCategory(catId) {
  const cat = findCategory(catId);
  if (!cat) return;
  if (!confirm(`Delete category "${cat.name}" and all its line items?`)) return;
  const year = activeYear();
  year.categories = year.categories.filter((c) => c.id !== catId);
  commit();
  renderAll();
}

function deleteLineItem(catId, liId) {
  const cat = findCategory(catId);
  if (!cat) return;
  const li = cat.lineItems.find((l) => l.id === liId);
  if (!li) return;
  if (!confirm(`Delete line item "${li.name}"?`)) return;
  cat.lineItems = cat.lineItems.filter((l) => l.id !== liId);
  commit();
  renderAll();
}

function deleteSubitem(liId, subId) {
  const li = findLineItem(liId);
  if (!li) return;
  li.subitems = (li.subitems || []).filter((s) => s.id !== subId);
  commit();
  renderAll();
}

/* ============================================================
 * MODALS
 * ============================================================ */

function openModal(title, bodyHtml, onSave) {
  const backdrop = document.getElementById("modalBackdrop");
  const modal = document.getElementById("modal");
  modal.innerHTML = `
    <div class="modal__head">${title}</div>
    <div class="modal__body">${bodyHtml}</div>
    <div class="modal__foot">
      <button class="btn btn--ghost" data-modal="cancel">Cancel</button>
      <button class="btn btn--primary" data-modal="save">Save</button>
    </div>`;
  backdrop.hidden = false;

  const close = () => {
    backdrop.hidden = true;
    modal.innerHTML = "";
  };

  modal.querySelector('[data-modal="cancel"]').onclick = close;
  modal.querySelector('[data-modal="save"]').onclick = () => {
    if (onSave(modal) !== false) close();
  };
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };
  // Focus first input
  const first = modal.querySelector("input, select, textarea");
  if (first) first.focus();
}

function freqOptions(selected) {
  return FREQUENCIES.map(
    (f) => `<option value="${f}" ${f === selected ? "selected" : ""}>${f}</option>`
  ).join("");
}

function openCategoryModal(catId) {
  const cat = catId ? findCategory(catId) : null;
  const body = `
    <div class="field">
      <label>Category Name</label>
      <input class="input" id="f-name" value="${escapeHtml(cat ? cat.name : "")}" placeholder="e.g. Software licensing" />
    </div>
    <div class="field">
      <label>Budget Number</label>
      <input class="input" id="f-num" value="${escapeHtml(cat ? cat.budgetNumber : "")}" placeholder="1.1.65.6500.0000.0000" />
    </div>`;
  openModal(cat ? "Edit Category" : "Add Category", body, (modal) => {
    const name = modal.querySelector("#f-name").value.trim();
    const num = modal.querySelector("#f-num").value.trim();
    if (!name) return false;
    if (cat) {
      cat.name = name;
      cat.budgetNumber = num;
    } else {
      activeYear().categories.push({ id: uid(), key: genKey(), name, budgetNumber: num, lineItems: [] });
    }
    commit();
    renderAll();
  });
}

function openLineItemModal(catId, liId) {
  const cat = findCategory(catId);
  if (!cat) return;
  const li = liId ? cat.lineItems.find((l) => l.id === liId) : null;
  const body = `
    <div class="field">
      <label>Line Item Name</label>
      <input class="input" id="f-name" value="${escapeHtml(li ? li.name : "")}" placeholder="e.g. Microsoft 365 licensing" />
    </div>
    <div class="field__row">
      <div class="field">
        <label>Frequency</label>
        <select class="select" id="f-freq">${freqOptions(li ? li.frequency : "Yearly")}</select>
      </div>
      <div class="field">
        <label>Budgeted Amount</label>
        <input class="input" id="f-budget" type="number" step="0.01" value="${li ? (li.budgetedAmount ?? "") : ""}" placeholder="0.00" />
      </div>
    </div>
    <div class="field">
      <label>Note</label>
      <textarea class="input" id="f-note" placeholder="Details about this line item...">${escapeHtml(li ? li.note || "" : "")}</textarea>
    </div>`;
  openModal(li ? "Edit Line Item" : "Add Line Item", body, (modal) => {
    const name = modal.querySelector("#f-name").value.trim();
    if (!name) return false;
    const payload = {
      name,
      frequency: modal.querySelector("#f-freq").value,
      budgetedAmount: parseFloat(modal.querySelector("#f-budget").value) || 0,
      note: modal.querySelector("#f-note").value.trim(),
    };
    if (li) {
      Object.assign(li, payload);
    } else {
      cat.lineItems.push({ id: uid(), key: genKey(), ...payload, subitems: [] });
    }
    commit();
    renderAll();
  });
}

function openSubitemModal(liId, subId) {
  const li = findLineItem(liId);
  if (!li) return;
  const sub = subId ? (li.subitems || []).find((s) => s.id === subId) : null;
  const body = `
    <div class="field">
      <label>Expense</label>
      <input class="input" id="f-name" value="${escapeHtml(sub ? sub.name : "")}" placeholder="e.g. May invoice" />
    </div>
    <div class="field">
      <label>Actual Cost</label>
      <input class="input" id="f-actual" type="number" step="0.01" value="${sub ? (sub.actual ?? "") : ""}" placeholder="0.00" />
    </div>
    <div class="field">
      <label>Note</label>
      <textarea class="input" id="f-note" placeholder="Optional note...">${escapeHtml(sub ? sub.note || "" : "")}</textarea>
    </div>`;
  openModal(sub ? "Edit Expense" : "Add Expense", body, (modal) => {
    const name = modal.querySelector("#f-name").value.trim();
    const actual = parseFloat(modal.querySelector("#f-actual").value);
    if (!name || isNaN(actual)) return false;
    const payload = { name, actual, note: modal.querySelector("#f-note").value.trim() };
    if (sub) {
      Object.assign(sub, payload);
    } else {
      li.subitems = li.subitems || [];
      li.subitems.push({ id: uid(), ...payload });
    }
    expanded.add(liId);
    commit();
    renderAll();
  });
}

/* ============================================================
 * YEAR MANAGEMENT
 * ============================================================ */

function renderYearSelect() {
  const sel = document.getElementById("yearSelect");
  sel.innerHTML = yearsChrono()
    .map((y) => `<option value="${y.id}" ${y.id === data.activeYearId ? "selected" : ""}>${escapeHtml(y.label)}</option>`)
    .join("");
}

function syncFyLabel() {
  const y = activeYear();
  const range = y.start && y.end ? ` · ${fmtDate(y.start)} – ${fmtDate(y.end)}` : "";
  document.getElementById("fyLabel").textContent = `${y.label}${range}`;
}

// Suggest the next year's label and dates by incrementing the most recent year.
function suggestNextYear() {
  const latest = yearsChrono().slice(-1)[0];
  const addYear = (iso) => {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${Number(y) + 1}-${m}-${d}`;
  };
  const nextLabel = latest
    ? latest.label.replace(/\d{4}/, (m) => String(Number(m) + 1))
    : "Fiscal Year";
  return {
    label: latest ? nextLabel : "Fiscal Year",
    start: latest ? addYear(latest.start) : "",
    end: latest ? addYear(latest.end) : "",
    source: latest ? latest.id : "",
  };
}

// Deep-copy a year's categories/line items, preserving stable keys, resetting
// actuals (subitems) to empty. Budgets optionally carried forward.
function carryForwardCategories(sourceYear, copyBudgets) {
  return sourceYear.categories.map((cat) => ({
    id: uid(),
    key: cat.key,
    name: cat.name,
    budgetNumber: cat.budgetNumber,
    lineItems: cat.lineItems.map((li) => ({
      id: uid(),
      key: li.key,
      name: li.name,
      frequency: li.frequency,
      budgetedAmount: copyBudgets ? (Number(li.budgetedAmount) || 0) : 0,
      note: li.note || "",
      subitems: [],
    })),
  }));
}

function openNewYearModal() {
  const s = suggestNextYear();
  const sourceOpts = yearsChrono()
    .map((y) => `<option value="${y.id}" ${y.id === s.source ? "selected" : ""}>${escapeHtml(y.label)}</option>`)
    .join("");
  const body = `
    <div class="field">
      <label>Fiscal Year Name</label>
      <input class="input" id="f-label" value="${escapeHtml(s.label)}" placeholder="e.g. Fiscal Year 2028" />
    </div>
    <div class="field__row">
      <div class="field"><label>Start Date</label><input class="input" id="f-start" type="date" value="${s.start}" /></div>
      <div class="field"><label>End Date</label><input class="input" id="f-end" type="date" value="${s.end}" /></div>
    </div>
    <div class="field">
      <label>Carry forward setup from</label>
      <select class="select" id="f-source">
        <option value="">Start empty (seven default categories)</option>
        ${sourceOpts}
      </select>
    </div>
    <div class="field">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
        <input type="checkbox" id="f-copybudget" checked style="width:auto;" />
        Copy last year's budgeted amounts as a starting point
      </label>
    </div>`;
  openModal("New Fiscal Year", body, (modal) => {
    const label = modal.querySelector("#f-label").value.trim();
    if (!label) return false;
    const sourceId = modal.querySelector("#f-source").value;
    const copyBudgets = modal.querySelector("#f-copybudget").checked;
    const sourceYear = sourceId ? data.years.find((y) => y.id === sourceId) : null;

    const newYear = {
      id: uid(),
      label,
      start: modal.querySelector("#f-start").value,
      end: modal.querySelector("#f-end").value,
      categories: sourceYear
        ? carryForwardCategories(sourceYear, copyBudgets)
        : seedYear().categories,
    };
    data.years.push(newYear);
    data.activeYearId = newYear.id;
    commit();
    refreshShell();
    renderAll();
  });
}

function openEditYearModal() {
  const y = activeYear();
  const canDelete = data.years.length > 1;
  const body = `
    <div class="field">
      <label>Fiscal Year Name</label>
      <input class="input" id="f-label" value="${escapeHtml(y.label)}" />
    </div>
    <div class="field__row">
      <div class="field"><label>Start Date</label><input class="input" id="f-start" type="date" value="${y.start || ""}" /></div>
      <div class="field"><label>End Date</label><input class="input" id="f-end" type="date" value="${y.end || ""}" /></div>
    </div>
    ${canDelete ? `<div class="field"><button class="btn btn--danger" id="f-delete">Delete this fiscal year</button></div>` : ""}`;
  openModal("Edit Fiscal Year", body, (modal) => {
    const label = modal.querySelector("#f-label").value.trim();
    if (!label) return false;
    y.label = label;
    y.start = modal.querySelector("#f-start").value;
    y.end = modal.querySelector("#f-end").value;
    commit();
    refreshShell();
    renderAll();
  });

  const delBtn = document.getElementById("f-delete");
  if (delBtn) {
    delBtn.onclick = () => {
      if (!confirm(`Delete "${y.label}" and all of its data? This cannot be undone.`)) return;
      data.years = data.years.filter((yr) => yr.id !== y.id);
      data.activeYearId = yearsChrono().slice(-1)[0].id;
      commit();
      document.getElementById("modalBackdrop").hidden = true;
      document.getElementById("modal").innerHTML = "";
      refreshShell();
      renderAll();
    };
  }
}

/* ============================================================
 * REPORTS — budget growth vs. savings across years
 * ============================================================ */

// Build a cross-year model keyed by stable category/line-item keys.
function buildReportModel() {
  const years = yearsChrono();
  // categoryKey -> { name, budgetNumber, items: Map(itemKey -> { name, perYear: {yearId:{budgeted,actual}} }) , perYear }
  const cats = new Map();

  years.forEach((year) => {
    year.categories.forEach((cat) => {
      if (!cats.has(cat.key)) {
        cats.set(cat.key, { key: cat.key, name: cat.name, budgetNumber: cat.budgetNumber, items: new Map(), perYear: {} });
      }
      const cm = cats.get(cat.key);
      // Most recent year wins for display name.
      cm.name = cat.name;
      cm.budgetNumber = cat.budgetNumber;
      const ct = categoryTotals(cat);
      cm.perYear[year.id] = { budgeted: ct.budgeted, actual: ct.actual };

      cat.lineItems.forEach((li) => {
        if (!cm.items.has(li.key)) {
          cm.items.set(li.key, { key: li.key, name: li.name, perYear: {} });
        }
        const im = cm.items.get(li.key);
        im.name = li.name;
        im.perYear[year.id] = { budgeted: Number(li.budgetedAmount) || 0, actual: lineItemActual(li) };
      });
    });
  });

  return { years, cats };
}

// Growth between the two most recent years in which an entity has data.
function computeGrowth(perYear, years) {
  const present = years.filter((y) => perYear[y.id]);
  if (present.length < 2) return null;
  const last = perYear[present[present.length - 1].id].budgeted;
  const prev = perYear[present[present.length - 2].id].budgeted;
  const delta = last - prev;
  const pctChange = prev ? (delta / prev) * 100 : null;
  return { delta, pctChange };
}

function growthCell(growth) {
  if (!growth) return `<td class="num muted">—</td>`;
  const cls = growth.delta > 0 ? "delta-up" : growth.delta < 0 ? "delta-down" : "muted";
  const arrow = growth.delta > 0 ? "▲" : growth.delta < 0 ? "▼" : "";
  const pctTxt = growth.pctChange == null ? "" : ` (${growth.pctChange > 0 ? "+" : ""}${growth.pctChange.toFixed(1)}%)`;
  return `<td class="num ${cls}">${arrow} ${signedMoney(growth.delta)}<span class="report-sub">${pctTxt}</span></td>`;
}

function savingsCell(cell) {
  if (!cell) return `<td class="num muted year-group">—</td><td class="num muted">—</td><td class="num muted">—</td>`;
  const savings = cell.budgeted - cell.actual;
  const sCls = savings > 0 ? "pos" : savings < 0 ? "neg" : "";
  return `<td class="num year-group">${money(cell.budgeted)}</td><td class="num">${money(cell.actual)}</td><td class="num ${sCls}">${signedMoney(savings)}</td>`;
}

function renderReports() {
  const view = document.getElementById("reportView").value;
  const { years, cats } = buildReportModel();

  document.getElementById("reportTableTitle").textContent =
    view === "category" ? "Budget Growth vs. Savings by Category" : "Budget Growth vs. Savings by Line Item";

  // Summary cards: per-year totals + latest-year growth/savings.
  const yearCards = years.map((y) => {
    const t = yearTotals(y);
    return { label: y.label, budgeted: t.budgeted, actual: t.actual };
  });
  let cardsHtml = "";
  if (years.length) {
    const latest = yearCards[yearCards.length - 1];
    const prev = yearCards.length > 1 ? yearCards[yearCards.length - 2] : null;
    const growth = prev ? latest.budgeted - prev.budgeted : null;
    const growthPct = prev && prev.budgeted ? ((latest.budgeted - prev.budgeted) / prev.budgeted) * 100 : null;
    const savings = latest.budgeted - latest.actual;
    cardsHtml = [
      { label: "Years Tracked", value: String(years.length), sub: `${years[0].label} → ${years[years.length - 1].label}` },
      {
        label: `${latest.label} Budget`,
        value: money(latest.budgeted),
        sub: growth == null ? "First year" : `${growth >= 0 ? "▲" : "▼"} ${signedMoney(growth)}${growthPct == null ? "" : ` (${growthPct >= 0 ? "+" : ""}${growthPct.toFixed(1)}%)`} vs prior`,
        cls: growth == null ? "" : growth > 0 ? "is-over" : "is-good",
      },
      { label: `${latest.label} Actual`, value: money(latest.actual), sub: `${pct(latest.actual, latest.budgeted)}% of budget` },
      {
        label: `${latest.label} Savings`,
        value: signedMoney(savings),
        sub: savings >= 0 ? "Under budget" : "Over budget",
        cls: savings >= 0 ? "is-good" : "is-over",
      },
    ]
      .map(
        (c) => `<div class="stat"><div class="stat__label">${c.label}</div><div class="stat__value ${c.cls || ""}">${c.value}</div><div class="stat__sub">${c.sub}</div></div>`
      )
      .join("");
  }
  document.getElementById("reportCards").innerHTML = cardsHtml;

  if (years.length < 1) {
    document.getElementById("reportTableWrap").innerHTML = `<p class="report-empty">No fiscal years yet.</p>`;
    return;
  }

  // Build table header: Item/Category | [per year: Budgeted, Actual, Savings] | Growth
  const yearHeadCols = years
    .map(
      (y) => `<th class="num year-group" colspan="3">${escapeHtml(y.label)}</th>`
    )
    .join("");
  const yearSubCols = years
    .map(() => `<th class="num year-group subhead">Budget</th><th class="num subhead">Actual</th><th class="num subhead">Savings</th>`)
    .join("");

  const leftHead = view === "category" ? "Category" : "Line Item";
  const thead = `
    <thead>
      <tr>
        <th class="txt" rowspan="2">${leftHead}</th>
        ${yearHeadCols}
        <th class="num" rowspan="2">Budget Growth<div class="report-sub">latest vs prior yr</div></th>
      </tr>
      <tr>${yearSubCols}</tr>
    </thead>`;

  let bodyRows = "";

  if (view === "category") {
    cats.forEach((cm) => {
      const cells = years.map((y) => savingsCell(cm.perYear[y.id])).join("");
      const growth = growthCell(computeGrowth(cm.perYear, years));
      bodyRows += `<tr><td class="txt item-name">${escapeHtml(cm.name)}<div class="report-sub">${escapeHtml(cm.budgetNumber || "")}</div></td>${cells}${growth}</tr>`;
    });
  } else {
    cats.forEach((cm) => {
      // Category subtotal row
      const catCells = years.map((y) => savingsCell(cm.perYear[y.id])).join("");
      const catGrowth = growthCell(computeGrowth(cm.perYear, years));
      bodyRows += `<tr class="cat-row"><td class="txt">${escapeHtml(cm.name)}</td>${catCells}${catGrowth}</tr>`;
      if (cm.items.size === 0) {
        bodyRows += `<tr><td class="txt muted" colspan="${years.length * 3 + 2}" style="padding-left:24px;">No line items.</td></tr>`;
      }
      cm.items.forEach((im) => {
        const cells = years.map((y) => savingsCell(im.perYear[y.id])).join("");
        const growth = growthCell(computeGrowth(im.perYear, years));
        bodyRows += `<tr><td class="txt item-name" style="padding-left:24px;">${escapeHtml(im.name)}</td>${cells}${growth}</tr>`;
      });
    });
  }

  // Footer: grand totals per year
  const footCells = years
    .map((y) => {
      const t = yearTotals(y);
      const savings = t.budgeted - t.actual;
      const sCls = savings > 0 ? "pos" : savings < 0 ? "neg" : "";
      return `<td class="num year-group">${money(t.budgeted)}</td><td class="num">${money(t.actual)}</td><td class="num ${sCls}">${signedMoney(savings)}</td>`;
    })
    .join("");
  const totalGrowth = growthCell(
    computeGrowth(
      Object.fromEntries(years.map((y) => [y.id, yearTotals(y)])),
      years
    )
  );
  const tfoot = `<tfoot><tr><td class="txt">All Categories</td>${footCells}${totalGrowth}</tr></tfoot>`;

  document.getElementById("reportTableWrap").innerHTML =
    `<table class="report-table">${thead}<tbody>${bodyRows}</tbody>${tfoot}</table>`;

  document.getElementById("reportLegend").innerHTML =
    `<span class="pos">■</span> saved &nbsp; <span class="neg">■</span> over`;
}

/* ============================================================
 * OTHER DEPARTMENTS
 * ============================================================ */

function renderDepartments() {
  const tbody = document.getElementById("deptRows");
  if (!data.otherDepartments.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="dept-empty">No department lines yet. Use "Add Line" to record budget lines for other departments.</td></tr>`;
    return;
  }
  tbody.innerHTML = data.otherDepartments
    .map(
      (d) => `
      <tr>
        <td>${escapeHtml(d.lineItem)}</td>
        <td>${escapeHtml(d.frequency || "—")}</td>
        <td class="mono">${escapeHtml(d.budgetNumber || "")}</td>
        <td>${escapeHtml(d.note || "")}</td>
        <td>
          ${canEdit ? `<button class="icon-btn" data-dept-action="edit" data-id="${d.id}" title="Edit">✎</button>
          <button class="icon-btn icon-btn--danger" data-dept-action="del" data-id="${d.id}" title="Delete">🗑</button>` : ""}
        </td>
      </tr>`
    )
    .join("");

  tbody.querySelectorAll("[data-dept-action]").forEach((el) => {
    el.addEventListener("click", () => {
      if (el.dataset.deptAction === "edit") openDeptModal(el.dataset.id);
      else deleteDept(el.dataset.id);
    });
  });
}

function openDeptModal(id) {
  const dept = id ? data.otherDepartments.find((d) => d.id === id) : null;
  const body = `
    <div class="field">
      <label>Line Item</label>
      <input class="input" id="f-line" value="${escapeHtml(dept ? dept.lineItem : "")}" placeholder="e.g. Library database subscription" />
    </div>
    <div class="field__row">
      <div class="field">
        <label>Frequency</label>
        <select class="select" id="f-freq">${freqOptions(dept ? dept.frequency : "Yearly")}</select>
      </div>
      <div class="field">
        <label>Budget Number</label>
        <input class="input" id="f-num" value="${escapeHtml(dept ? dept.budgetNumber || "" : "")}" placeholder="1.1.xx.xxxx.xxxx.0000" />
      </div>
    </div>
    <div class="field">
      <label>Note</label>
      <textarea class="input" id="f-note" placeholder="Why this matters / what to be aware of...">${escapeHtml(dept ? dept.note || "" : "")}</textarea>
    </div>`;
  openModal(dept ? "Edit Department Line" : "Add Department Line", body, (modal) => {
    const lineItem = modal.querySelector("#f-line").value.trim();
    if (!lineItem) return false;
    const payload = {
      lineItem,
      frequency: modal.querySelector("#f-freq").value,
      budgetNumber: modal.querySelector("#f-num").value.trim(),
      note: modal.querySelector("#f-note").value.trim(),
    };
    if (dept) {
      Object.assign(dept, payload);
    } else {
      data.otherDepartments.push({ id: uid(), ...payload });
    }
    commit();
    renderDepartments();
  });
}

function deleteDept(id) {
  const dept = data.otherDepartments.find((d) => d.id === id);
  if (!dept) return;
  if (!confirm(`Delete "${dept.lineItem}"?`)) return;
  data.otherDepartments = data.otherDepartments.filter((d) => d.id !== id);
  commit();
  renderDepartments();
}

/* ============================================================
 * APP SHELL: tabs, header actions, init
 * ============================================================ */

function renderAll() {
  renderDashboard();
  renderBudget();
  renderReports();
  renderDepartments();
}

// Refresh chrome that depends on the active/known years.
function refreshShell() {
  renderYearSelect();
  syncFyLabel();
}

function setupTabs() {
  document.querySelectorAll(".tabs__tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tabs__tab").forEach((t) => t.classList.remove("is-active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      document.getElementById("panel-" + tab.dataset.tab).classList.add("is-active");
      if (tab.dataset.tab === "users") renderUsers();
      if (tab.dataset.tab === "activity") renderActivity();
    });
  });
}

function setupHeader() {
  // Note: refreshShell() is called from startApp() once data has loaded.

  document.getElementById("yearSelect").onchange = (e) => {
    data.activeYearId = e.target.value;
    commit();
    syncFyLabel();
    renderAll();
  };
  document.getElementById("newYearBtn").onclick = openNewYearModal;
  document.getElementById("editYearBtn").onclick = openEditYearModal;
  document.getElementById("reportView").onchange = renderReports;

  document.getElementById("exportBtn").onclick = () => Storage.export(data);
  document.getElementById("importBtn").onclick = () =>
    document.getElementById("importFile").click();
  document.getElementById("importFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const imported = await Storage.import(file);
      if (!confirm("Importing will replace your current data. Continue?")) return;
      data = imported;
      commit();
      refreshShell();
      renderAll();
    } catch (err) {
      alert("Could not import file: " + err.message);
    } finally {
      e.target.value = "";
    }
  };

  document.getElementById("addCategoryBtn").onclick = () => openCategoryModal(null);
  document.getElementById("addDeptBtn").onclick = () => openDeptModal(null);
  document.getElementById("addUserBtn").onclick = () => openUserModal(null);
  document.getElementById("accountBtn").onclick = openAccountModal;
  document.getElementById("logoutBtn").onclick = doLogout;
  document.getElementById("refreshActivityBtn").onclick = renderActivity;

  document.getElementById("expandAllBtn").onclick = () => {
    activeYear().categories.forEach((c) => c.lineItems.forEach((l) => expanded.add(l.id)));
    renderBudget();
  };
  document.getElementById("collapseAllBtn").onclick = () => {
    expanded.clear();
    renderBudget();
  };
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const backdrop = document.getElementById("modalBackdrop");
    if (!backdrop.hidden) {
      backdrop.hidden = true;
      document.getElementById("modal").innerHTML = "";
    }
  }
});

/* ============================================================
 * SYNC: status indicator, conflict/update banners, polling
 * ============================================================ */

function setSyncStatus(state) {
  const el = document.getElementById("syncStatus");
  const map = {
    synced: ["is-synced", "Saved", "All changes saved to the shared server"],
    saving: ["is-saving", "Saving…", "Saving to the shared server"],
    local: ["is-local", "Local only", "No shared server — changes are saved in this browser only"],
    conflict: ["is-conflict", "Conflict", "Another user changed the budget"],
  };
  const [cls, text, title] = map[state] || map.local;
  el.className = "sync " + cls;
  el.setAttribute("data-text", text);
  el.title = title;
}

let bannerTimer = null;
function showBanner(html, { conflict = false, actions = [], autoHideMs = 0 } = {}) {
  const b = document.getElementById("updateBanner");
  b.className = "banner" + (conflict ? " is-conflict" : "");
  b.innerHTML = `<span>${html}</span><span class="banner__actions"></span>`;
  const host = b.querySelector(".banner__actions");
  actions.forEach((a) => {
    const btn = document.createElement("button");
    btn.className = "btn btn--sm";
    btn.textContent = a.label;
    btn.onclick = a.onClick;
    host.appendChild(btn);
  });
  b.hidden = false;
  if (bannerTimer) clearTimeout(bannerTimer);
  if (autoHideMs) bannerTimer = setTimeout(hideBanner, autoHideMs);
}
function hideBanner() {
  document.getElementById("updateBanner").hidden = true;
}

function onConflict(serverData) {
  showBanner(
    "This budget was just changed by someone else, so your most recent edit wasn't saved to the server.",
    {
      conflict: true,
      actions: [
        {
          label: "Load latest",
          onClick: () => {
            if (serverData) {
              data = serverData;
              refreshShell();
              renderAll();
            }
            hideBanner();
          },
        },
        {
          label: "Keep mine (overwrite)",
          onClick: () => {
            Storage.save(data); // _rev was advanced to the server's, so this now wins
            hideBanner();
          },
        },
      ],
    }
  );
}

function startPolling() {
  setInterval(async () => {
    // Don't yank the UI out from under an open dialog.
    if (!document.getElementById("modalBackdrop").hidden) return;
    const fresh = await Storage.poll();
    if (fresh) {
      data = fresh;
      refreshShell();
      renderAll();
      showBanner("Budget updated by another user.", { autoHideMs: 4000 });
    }
  }, 10000);
}

/* ============================================================
 * AUTH UI: login / setup overlay, roles, account, user admin
 * ============================================================ */

function hideModalNow() {
  document.getElementById("modalBackdrop").hidden = true;
  document.getElementById("modal").innerHTML = "";
}

function hideAuthOverlay() {
  const o = document.getElementById("authOverlay");
  o.hidden = true;
  document.getElementById("authForms").innerHTML = "";
}

function showAuthError(msg) {
  const el = document.getElementById("authError");
  if (el) {
    el.textContent = msg;
    el.hidden = false;
  }
}

// Lightweight password strength heuristic (length + character variety).
function passwordStrength(pw) {
  pw = pw || "";
  let s = 0;
  if (pw.length >= 10) s++;
  if (pw.length >= 14) s++;
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  if (classes >= 2) s++;
  if (classes >= 3) s++;
  const score = Math.min(s, 4);
  const label = ["Very weak", "Weak", "Fair", "Good", "Strong"][score];
  return { score, label };
}

// HTML for a meter element; pair with attachStrengthMeter(inputId, meterId).
function strengthMeterHtml(meterId) {
  return `<div class="pw-meter" id="${meterId}">
      <div class="pw-meter__bar"><div class="pw-meter__fill s0"></div></div>
      <div class="pw-meter__label">Use at least 10 characters with a mix of letters, numbers, or symbols.</div>
    </div>`;
}
function attachStrengthMeter(inputEl, meterEl) {
  if (!inputEl || !meterEl) return;
  const fill = meterEl.querySelector(".pw-meter__fill");
  const label = meterEl.querySelector(".pw-meter__label");
  const update = () => {
    const { score, label: text } = passwordStrength(inputEl.value);
    fill.className = "pw-meter__fill s" + score;
    if (inputEl.value) label.textContent = "Strength: " + text;
  };
  inputEl.addEventListener("input", update);
}

function showLogin() {
  const overlay = document.getElementById("authOverlay");
  overlay.hidden = false;
  document.getElementById("authForms").innerHTML = `
    <p class="auth-sub">Sign in to continue.</p>
    <div class="auth-error" id="authError" hidden></div>
    <form id="loginForm">
      <div class="field"><label>Username</label><input class="input" id="lg-user" autocomplete="username" /></div>
      <div class="field"><label>Password</label><input class="input" id="lg-pass" type="password" autocomplete="current-password" /></div>
      <label class="remember-row"><input type="checkbox" id="lg-remember" /> Remember me on this device</label>
      <button class="btn btn--primary" type="submit">Sign in</button>
    </form>`;
  document.getElementById("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { user } = await Auth.login(
        document.getElementById("lg-user").value.trim(),
        document.getElementById("lg-pass").value,
        document.getElementById("lg-remember").checked
      );
      await onAuthenticated(user);
    } catch (err) {
      showAuthError(err.message);
    }
  };
  document.getElementById("lg-user").focus();
}

function showSetup() {
  const overlay = document.getElementById("authOverlay");
  overlay.hidden = false;
  document.getElementById("authForms").innerHTML = `
    <p class="auth-sub">Welcome! Create the first administrator account.</p>
    <div class="auth-error" id="authError" hidden></div>
    <form id="setupForm">
      <div class="field"><label>Your name</label><input class="input" id="su-name" autocomplete="name" /></div>
      <div class="field"><label>Username</label><input class="input" id="su-user" autocomplete="username" /></div>
      <div class="field"><label>Password</label><input class="input" id="su-pass" type="password" autocomplete="new-password" placeholder="At least 10 characters" />${strengthMeterHtml("su-meter")}</div>
      <div class="field"><label>Confirm password</label><input class="input" id="su-pass2" type="password" autocomplete="new-password" /></div>
      <button class="btn btn--primary" type="submit">Create admin &amp; continue</button>
    </form>
    <div class="auth-foot">This screen appears only once, on first launch.</div>`;
  attachStrengthMeter(document.getElementById("su-pass"), document.getElementById("su-meter"));
  document.getElementById("setupForm").onsubmit = async (e) => {
    e.preventDefault();
    const pass = document.getElementById("su-pass").value;
    if (pass.length < 10) return showAuthError("Password must be at least 10 characters.");
    if (pass !== document.getElementById("su-pass2").value) return showAuthError("Passwords do not match.");
    try {
      const { user } = await Auth.setup({
        username: document.getElementById("su-user").value.trim(),
        password: pass,
        displayName: document.getElementById("su-name").value.trim(),
        remember: true,
      });
      await onAuthenticated(user);
    } catch (err) {
      showAuthError(err.message);
    }
  };
  document.getElementById("su-name").focus();
}

function applyRoleUI() {
  document.querySelectorAll(".editor-only").forEach((el) => {
    el.style.display = canEdit ? "" : "none";
  });
  document.querySelectorAll(".admin-only").forEach((el) => {
    el.hidden = !isAdminUser;
  });
  document.querySelectorAll(".auth-only").forEach((el) => {
    el.hidden = !meUser; // server-backed features (e.g. activity log)
  });
  const userArea = document.getElementById("userArea");
  const userSep = document.getElementById("userSep");
  if (meUser) {
    userArea.hidden = false;
    userSep.hidden = false;
    document.getElementById("userName").textContent = meUser.displayName;
    const rb = document.getElementById("roleBadge");
    rb.textContent = meUser.role;
    rb.className = "role-badge is-" + meUser.role;
  } else {
    userArea.hidden = true;
    userSep.hidden = true;
  }
}

async function onAuthenticated(user) {
  meUser = user;
  canEdit = user.role === "editor" || user.role === "admin";
  isAdminUser = user.role === "admin";
  hideAuthOverlay();
  applyRoleUI();
  await startApp();
}

async function doLogout() {
  try {
    await Auth.logout();
  } catch {
    /* ignore */
  }
  meUser = null;
  canEdit = false;
  isAdminUser = false;
  applyRoleUI();
  // Switch to the Dashboard tab so we don't return into an admin-only panel.
  document.querySelector('.tabs__tab[data-tab="dashboard"]').click();
  showLogin();
}

async function startApp() {
  data = await Storage.load();
  if (!data) return; // not authenticated; overlay is showing
  refreshShell();
  renderAll();
  if (!appStarted) {
    startPolling();
    appStarted = true;
  }
}

/* ---------- Account (change own password) ---------- */

function openAccountModal() {
  const body = `
    <div class="field"><label>Current password</label><input class="input" id="ac-cur" type="password" autocomplete="current-password" /></div>
    <div class="field"><label>New password</label><input class="input" id="ac-new" type="password" autocomplete="new-password" placeholder="At least 10 characters" />${strengthMeterHtml("ac-meter")}</div>
    <div class="field"><label>Confirm new password</label><input class="input" id="ac-new2" type="password" autocomplete="new-password" /></div>`;
  openModal("Change Password", body, (modal) => {
    const cur = modal.querySelector("#ac-cur").value;
    const nw = modal.querySelector("#ac-new").value;
    if (nw.length < 10) {
      alert("New password must be at least 10 characters.");
      return false;
    }
    if (nw !== modal.querySelector("#ac-new2").value) {
      alert("New passwords do not match.");
      return false;
    }
    Auth.changePassword(cur, nw)
      .then(() => {
        hideModalNow();
        alert("Password changed.");
      })
      .catch((err) => alert(err.message));
    return false; // keep open until the async call resolves
  });
  attachStrengthMeter(document.getElementById("ac-new"), document.getElementById("ac-meter"));
}

/* ---------- User management (admin) ---------- */

function roleOptions(selected) {
  return ["admin", "editor", "viewer"]
    .map((r) => `<option value="${r}" ${r === selected ? "selected" : ""}>${r[0].toUpperCase() + r.slice(1)}</option>`)
    .join("");
}

async function renderUsers() {
  if (!isAdminUser) return;
  const tbody = document.getElementById("userRows");
  let list;
  try {
    list = (await Users.list()).users;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="dept-empty">${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  tbody.innerHTML = list
    .map(
      (u) => `
      <tr>
        <td>${escapeHtml(u.displayName)}${u.id === meUser.id ? ' <span class="muted">(you)</span>' : ""}</td>
        <td class="mono">${escapeHtml(u.username)}</td>
        <td><span class="role-badge is-${u.role}">${u.role}</span></td>
        <td>${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : ""}</td>
        <td>
          <button class="icon-btn" data-user-action="edit" data-id="${u.id}" title="Edit">✎</button>
          <button class="icon-btn icon-btn--danger" data-user-action="del" data-id="${u.id}" title="Delete">🗑</button>
        </td>
      </tr>`
    )
    .join("");

  tbody.querySelectorAll("[data-user-action]").forEach((el) => {
    el.addEventListener("click", () => {
      const u = list.find((x) => x.id === el.dataset.id);
      if (el.dataset.userAction === "edit") openUserModal(u);
      else deleteUser(u);
    });
  });
}

function openUserModal(user) {
  const editing = !!user;
  const body = `
    <div class="field"><label>Name</label><input class="input" id="us-name" value="${escapeHtml(editing ? user.displayName : "")}" /></div>
    <div class="field"><label>Username</label><input class="input" id="us-user" value="${escapeHtml(editing ? user.username : "")}" ${editing ? "disabled" : ""} placeholder="letters, numbers, . _ -" /></div>
    <div class="field"><label>Role</label><select class="select" id="us-role">${roleOptions(editing ? user.role : "viewer")}</select></div>
    <div class="field"><label>${editing ? "Reset password (optional)" : "Password"}</label><input class="input" id="us-pass" type="password" autocomplete="new-password" placeholder="${editing ? "Leave blank to keep current" : "At least 10 characters"}" />${strengthMeterHtml("us-meter")}</div>`;

  openModal(editing ? "Edit User" : "Add User", body, (modal) => {
    const displayName = modal.querySelector("#us-name").value.trim();
    const role = modal.querySelector("#us-role").value;
    const password = modal.querySelector("#us-pass").value;

    let promise;
    if (editing) {
      const payload = { displayName, role };
      if (password) payload.password = password;
      promise = Users.update(user.id, payload);
    } else {
      const username = modal.querySelector("#us-user").value.trim();
      promise = Users.create({ username, password, displayName, role });
    }

    promise
      .then(async () => {
        hideModalNow();
        // If we changed our own role, refresh our permissions/UI.
        if (editing && user.id === meUser.id && role !== meUser.role) {
          meUser = { ...meUser, role };
          canEdit = role === "editor" || role === "admin";
          isAdminUser = role === "admin";
          applyRoleUI();
          renderAll();
        }
        renderUsers();
      })
      .catch((err) => alert(err.message));
    return false; // keep modal open until the async call resolves
  });
  attachStrengthMeter(document.getElementById("us-pass"), document.getElementById("us-meter"));
}

function deleteUser(user) {
  if (!confirm(`Delete user "${user.displayName}" (${user.username})?`)) return;
  Users.remove(user.id)
    .then(() => renderUsers())
    .catch((err) => alert(err.message));
}

/* ---------- Activity / audit log ---------- */

function formatWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? `Today at ${time}` : `${d.toLocaleDateString()} ${time}`;
}

async function renderActivity() {
  const host = document.getElementById("activityList");
  host.innerHTML = `<p class="activity__empty">Loading…</p>`;
  let entries;
  try {
    entries = (await AuditLog.list(200)).entries;
  } catch (err) {
    host.innerHTML = `<p class="activity__empty">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!entries.length) {
    host.innerHTML = `<p class="activity__empty">No changes recorded yet.</p>`;
    return;
  }
  host.innerHTML =
    `<div class="activity">` +
    entries
      .map((e) => {
        const name = e.displayName || e.username || "Unknown";
        const initials = name.trim().slice(0, 2);
        const changes = (e.changes || []).map((c) => `<li>${escapeHtml(c)}</li>`).join("");
        return `
        <div class="activity__item">
          <div class="activity__avatar">${escapeHtml(initials)}</div>
          <div class="activity__body">
            <div class="activity__meta">
              <span class="activity__who">${escapeHtml(name)}</span>
              <span class="activity__when">${escapeHtml(formatWhen(e.ts))}</span>
              <span class="activity__rev">rev ${escapeHtml(String(e.rev))}</span>
            </div>
            <ul class="activity__changes">${changes}</ul>
          </div>
        </div>`;
      })
      .join("") +
    `</div>`;
}

/* ---------- Boot ---------- */

async function boot() {
  Storage.setHandlers({ status: setSyncStatus, conflict: onConflict, authRequired: showLogin });
  setupTabs();
  setupHeader();

  let status;
  try {
    status = await Auth.status();
  } catch {
    status = null; // no backend reachable -> standalone single-user mode
  }

  if (status === null) {
    meUser = null;
    canEdit = true;
    isAdminUser = false;
    applyRoleUI();
    await startApp();
    return;
  }
  if (status.setupRequired) return showSetup();
  if (!status.user) return showLogin();
  await onAuthenticated(status.user);
}

boot();
