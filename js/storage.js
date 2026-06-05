/* storage.js — persistence + seed data for the IT Budget Tracker.
 * Data lives in the browser's localStorage. Export/Import lets you
 * move a backup between machines or keep it in version control. */

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

function defaultData() {
  return {
    version: 1,
    fiscalYear: { label: "Fiscal Year 2027", start: "2026-06-01", end: "2027-05-30" },
    categories: SEED_CATEGORIES.map((c) => ({
      id: uid(),
      name: c.name,
      budgetNumber: c.budgetNumber,
      lineItems: [],
    })),
    otherDepartments: [],
  };
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
      return JSON.parse(raw);
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
          if (!parsed || !Array.isArray(parsed.categories)) {
            throw new Error("File does not look like a budget export.");
          }
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  },
};
