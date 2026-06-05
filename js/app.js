/* app.js — IT Budget Tracker application logic. */

let data = Storage.load();

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

function grandTotals() {
  return data.categories.reduce(
    (acc, cat) => {
      const t = categoryTotals(cat);
      acc.budgeted += t.budgeted;
      acc.actual += t.actual;
      return acc;
    },
    { budgeted: 0, actual: 0 }
  );
}

/* ---------- Formatting ---------- */

function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
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
  const g = grandTotals();
  const remaining = g.budgeted - g.actual;
  const spentPct = pct(g.actual, g.budgeted);

  const cards = [
    { label: "Total Budgeted", value: money(g.budgeted), sub: data.fiscalYear.label },
    { label: "Total Actual", value: money(g.actual), sub: `${spentPct}% of budget spent` },
    {
      label: "Budget Remaining",
      value: money(remaining),
      sub: remaining < 0 ? "Over budget" : "Available",
      cls: remaining < 0 ? "is-over" : "is-good",
    },
    {
      label: "Line Items",
      value: String(data.categories.reduce((n, c) => n + c.lineItems.length, 0)),
      sub: `${data.categories.length} categories`,
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
  const byCat = data.categories
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
  data.categories.forEach((cat) => {
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
  if (!data.categories.length) {
    host.innerHTML = `<p class="muted">No categories yet. Use "Add Category" to begin.</p>`;
    return;
  }

  host.innerHTML = data.categories.map(renderCategory).join("");
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
        <div class="category__actions">
          <button class="icon-btn" data-action="edit-cat" data-cat="${cat.id}" title="Edit category">✎</button>
          <button class="icon-btn icon-btn--danger" data-action="del-cat" data-cat="${cat.id}" title="Delete category">🗑</button>
        </div>
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

  const addBtn = `
    <div style="padding:10px 18px;">
      <button class="btn--link" data-action="add-li" data-cat="${cat.id}">+ Add Line Item</button>
    </div>`;

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
        <button class="icon-btn" data-action="edit-li" data-cat="${cat.id}" data-li="${li.id}" title="Edit line item">✎</button>
        <button class="icon-btn icon-btn--danger" data-action="del-li" data-cat="${cat.id}" data-li="${li.id}" title="Delete line item">🗑</button>
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
            <button class="icon-btn" data-action="edit-sub" data-li="${li.id}" data-sub="${s.id}" title="Edit">✎</button>
            <button class="icon-btn icon-btn--danger" data-action="del-sub" data-li="${li.id}" data-sub="${s.id}" title="Delete">🗑</button>
          </div>
        </div>`
        )
        .join("")
    : `<div class="subitems__empty">No expenses entered yet.</div>`;

  // Quick-add inline form
  const addForm = `
    <form class="subitem-add" data-action="quick-add-sub" data-li="${li.id}">
      <input class="input" name="name" placeholder="Expense (e.g. May invoice)" required />
      <input class="input num" name="actual" type="number" step="0.01" placeholder="Cost" required />
      <input class="input" name="note" placeholder="Note (optional)" />
      <button class="btn btn--primary btn--sm" type="submit">Add</button>
    </form>`;

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
    case "add-cat":
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

/* ---------- Lookups ---------- */

function findCategory(catId) {
  return data.categories.find((c) => c.id === catId);
}
function findLineItem(liId) {
  for (const c of data.categories) {
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
  data.categories = data.categories.filter((c) => c.id !== catId);
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
      data.categories.push({ id: uid(), name, budgetNumber: num, lineItems: [] });
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
      cat.lineItems.push({ id: uid(), ...payload, subitems: [] });
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
          <button class="icon-btn" data-dept-action="edit" data-id="${d.id}" title="Edit">✎</button>
          <button class="icon-btn icon-btn--danger" data-dept-action="del" data-id="${d.id}" title="Delete">🗑</button>
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
  renderDepartments();
}

function setupTabs() {
  document.querySelectorAll(".tabs__tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tabs__tab").forEach((t) => t.classList.remove("is-active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      document.getElementById("panel-" + tab.dataset.tab).classList.add("is-active");
    });
  });
}

function setupHeader() {
  document.getElementById("fyLabel").textContent =
    `${data.fiscalYear.label} · 6/1/2026 – 5/30/2027`;

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
      renderAll();
    } catch (err) {
      alert("Could not import file: " + err.message);
    } finally {
      e.target.value = "";
    }
  };

  document.getElementById("addCategoryBtn").onclick = () => openCategoryModal(null);
  document.getElementById("addDeptBtn").onclick = () => openDeptModal(null);

  document.getElementById("expandAllBtn").onclick = () => {
    data.categories.forEach((c) => c.lineItems.forEach((l) => expanded.add(l.id)));
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

setupTabs();
setupHeader();
renderAll();
