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

Each category can have an **Owner** (the person responsible for that budget),
shown in the category header and recorded in the activity log when it changes.

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

### Shared mode (whole team, one budget) — recommended

Run the included zero-dependency Node server. Everyone who points their browser
at it reads and writes **the same budget**.

```bash
node server.js          # or: npm start
# then visit http://localhost:3000
```

- **No dependencies, no build step, no database** — just Node 16+. Data is
  stored on the server in `data/budget.json` (written atomically).
- **Concurrent editing is safe.** Each save carries a revision number; if two
  people edit at once, the second save is detected as a conflict instead of
  silently overwriting, and you're offered **Load latest** or **Keep mine**.
- A small **status dot** in the header shows *Saved / Saving… / Conflict /
  Local only*. Open viewers auto-refresh every ~10s so everyone stays in sync.
- Configure the port with `PORT` (e.g. `PORT=8080 node server.js`).

To host it for the team, run it on any machine/VM/container they can reach.
Keep `data/` on persistent storage and back it up — it holds the budget **and**
the user accounts.

### Per-user login & roles

The server has real per-user accounts (passwords hashed with scrypt; httpOnly
session cookies). There are three roles:

| Role | Can do |
| --- | --- |
| **Admin** | Manage user accounts **and** edit the budget |
| **Editor** | Edit the budget (categories, line items, expenses, years) |
| **Viewer** | Read-only — see dashboards, budget, and reports; no editing |

- **First launch:** with no accounts yet, the app shows a one-time **setup
  screen** to create the initial admin. (Alternatively, set `ADMIN_USER` and
  `ADMIN_PASSWORD` when starting the server to bootstrap the first admin for
  automated deploys.)
- **Adding people:** an admin opens the **Users** tab to add/remove accounts,
  assign roles, and reset passwords. (Accounts are admin-managed — there is no
  open self-registration.) The last remaining admin can't be demoted or deleted.
- **Account:** any user can change their own password via the **Account** button.
- Read-only users simply don't see the edit controls, and the server also
  enforces it (budget writes from a viewer are rejected).

**Password policy & lockout.** New/changed passwords must be at least 10
characters, mix character types, not contain the username, and not be a common
password — enforced on the server, with a live strength meter in the UI. After
5 failed logins an account is locked for 15 minutes.

**Staying signed in.** Tick **Remember me** at login for a 30-day session;
otherwise the session ends when you close the browser. Sessions are persisted
to disk (as token hashes) so **restarting the server no longer logs everyone
out**.

**Password reset by email.** Each account can have an email address. A
**Forgot password?** link on the sign-in screen emails a one-time, one-hour
reset link. The response is always generic ("if that account exists…") so it
can't be used to probe for accounts, and using the link signs out that user's
other sessions.

Configure email by setting SMTP environment variables when starting the server:

```bash
SMTP_HOST=smtp.example.com SMTP_PORT=587 \
SMTP_USER=apikey SMTP_PASS=secret \
SMTP_FROM="IT Budget <no-reply@example.com>" \
APP_URL=https://budget.example.com \
node server.js
```

`SMTP_SECURE=1` uses implicit TLS (port 465); otherwise STARTTLS is used when
the server offers it. **If SMTP isn't configured**, the reset flow still works —
the reset link is written to the server log for an admin to relay.

### Activity log

Every budget change is recorded — who changed what, and when. Signed-in users
can review it in the **Activity** tab (e.g. *"Alice — Changed budget of 'M365'
from $1,000 to $1,200"*). The log is stored in `data/audit.json` and capped to
the most recent 2,000 entries.

Filter the activity by **text, user, and date range**, and **Export CSV**
(one row per change) for reporting or record-keeping — the export respects the
current filters.

> **Deploy securely:** run behind HTTPS (a reverse proxy is fine) and start the
> server with `COOKIE_SECURE=1` so the session cookie is marked `Secure`.
> Accounts, sessions, the budget, and the activity log all persist in `data/` —
> keep it on durable storage and back it up.

### Standalone mode (single user, no server)

Open `index.html` directly in a browser. With no backend reachable, the app
automatically falls back to the browser's `localStorage` and works as a
single-user tool. (Some browsers restrict `localStorage` on `file://` URLs; if
so, use shared mode above.)

## Data & backups

In shared mode, data lives in `data/budget.json` on the server; in standalone
mode it lives in your browser's `localStorage`. Either way, use the **Export**
button in the header to download a JSON backup (handy for snapshots or moving
between deployments) and **Import** to restore one.
