# IT Budget Tracker — FY2027

A lightweight, self-contained web app for managing the IT department budget for
**Fiscal Year 2027 (6/1/2026 – 5/30/2027)**. No server, database, or build step
required — open it in a browser and start tracking.

## Features

### Dashboard
High-level view of how you're tracking:
- Total Budgeted, Total Actual, and Budget Remaining (turns **red** when over budget)
- Spend-by-category progress bars (amber at ≥85%, red when over)
- "Attention Needed" alerts for categories and line items that are over or near budget

### Budget Tracker
Pre-loaded with the seven IT categories and their budget numbers:

| Category | Budget Number |
| --- | --- |
| Student wages | 1.1.65.6500.5015.0000 |
| Contract services | 1.1.65.6500.5360.0000 |
| Contract services - Bandwidth and telephone | 1.1.65.6500.5363.0000 |
| Equipment | 1.1.65.6500.5435.0000 |
| Software licensing | 1.1.65.6500.5601.0000 |
| Contingency | 1.1.65.6500.5730.0000 |
| Hardware infrastructure | 1.1.65.6500.5625.0000 |

Each category holds **Line Items** that track:
- **Frequency** — As Needed, Monthly, Yearly, or Other
- **Budgeted Amount** — what you planned to spend
- **Actual** — rolled up automatically from subitems
- **Budget Remaining** — `Budgeted − Actual`, highlighted **red** when negative
- **Note** — free-text details

Each Line Item has **Subitems** (expenses such as a monthly invoice or yearly
renewal):
- Quick inline add — just type the expense name and cost, then **Add**
- Each subitem has an Actual cost and an optional Note
- Subitem actuals roll up into the Line Item's Actual and Budget Remaining
- Subitems live in a **collapsible/expandable** section. Use the ▸/▾ toggle per
  line item, or **Expand all / Collapse all** to scan categories and line items
  without the detail.

### Multiple Fiscal Years
The header has a **Year** selector plus **New Year** and **Edit Year** buttons.
- **New Year** rolls the prior year's categories and line items forward (it
  suggests the next year's name and dates automatically), copies last year's
  **budgeted amounts** as a starting point so you can adjust them, and resets
  actuals to empty for the fresh year. You can also start a year empty with the
  seven default categories, or zero out the carried budgets.
- Each year keeps its own budgets and actuals. Categories and line items carry a
  stable identity across years so the same item can be tracked over time even if
  you rename it.
- **Edit Year** renames a year, changes its dates, or deletes it.

### Reports
Year-over-year reporting, viewable **By Line Item** or **By Category**:
- Summary cards: years tracked, latest year's budget with **year-over-year
  growth** ($ and %), latest actual, and latest **savings**.
- A table showing, for every year, each item's **Budget**, **Actual**, and
  **Savings** (`budgeted − actual` — green when under budget, red when over),
  plus a **Budget Growth** column comparing the latest year's budget to the
  prior year. Category subtotals and a grand-total footer are included.

### Other Departments
A simple reference list — no spend or budget tracking. Record a **Line Item**,
**Frequency**, **Budget Number**, and **Note** for budget lines owned by other
departments, including things you may need to be aware of.

## Running it

Just open `index.html` in any modern browser.

If your browser restricts `localStorage` on `file://` URLs, serve the folder
locally instead:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Data & backups

All data is stored in your browser's `localStorage`, so it stays on your
machine. Use the **Export** button in the header to download a JSON backup
(handy for moving between computers or committing a snapshot to git), and
**Import** to restore one.
