/* storage.js — persistence, seed data, and migrations for the IT Budget Tracker.
 *
 * Data model (v2) supports multiple fiscal years:
 * {
 *   version: 2,
 *   activeYearId,
 *   years: [
 *     { id, label, start, end, categories: [
 *         { id, key, name, budgetNumber, lineItems: [
 *             { id, key, name, frequency, budgetedAmount, note, subitems: [
 *                 { id, name, actual, note }
 *             ]}
 *         ]}
 *     ]}
 *   ],
 *   otherDepartments: [ { id, lineItem, frequency, budgetNumber, note } ]
 * }
 *
 * `key` is a STABLE identifier preserved when a year is rolled forward, so the
 * same category / line item can be matched across years for reporting even if
 * it is later renamed. `id` is unique per record and never reused.
 */

const STORAGE_KEY = "it-budget-tracker:v1";

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

/* Migrate older shapes forward so existing saved data is never lost. */
function migrate(data) {
  if (!data || typeof data !== "object") return defaultData();

  // v1: single year stored as top-level { fiscalYear, categories, otherDepartments }
  if (!data.years && Array.isArray(data.categories)) {
    const fy = data.fiscalYear || { label: "Fiscal Year 2027", start: "2026-06-01", end: "2027-05-30" };
    const year = {
      id: uid(),
      label: fy.label,
      start: fy.start,
      end: fy.end,
      categories: data.categories,
    };
    data = {
      version: 2,
      activeYearId: year.id,
      years: [year],
      otherDepartments: data.otherDepartments || [],
    };
  }

  // Ensure stable keys exist on every category and line item.
  (data.years || []).forEach((y) => {
    (y.categories || []).forEach((c) => {
      if (!c.key) c.key = genKey();
      (c.lineItems || []).forEach((li) => {
        if (!li.key) li.key = genKey();
        li.subitems = li.subitems || [];
      });
    });
  });

  if (!data.activeYearId && data.years && data.years.length) {
    data.activeYearId = data.years[0].id;
  }
  data.otherDepartments = data.otherDepartments || [];
  data.version = 2;
  return data;
}

const Storage = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const data = defaultData();
        this.save(data);
        return data;
      }
      return migrate(JSON.parse(raw));
    } catch (err) {
      console.error("Failed to load data, starting fresh:", err);
      return defaultData();
    }
  },

  save(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
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
