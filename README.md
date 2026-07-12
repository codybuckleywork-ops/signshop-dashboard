# Signshop Dashboard

A self-hosted production system for a sign shop. Flask + SQLite, runs on
your own PC, no subscription, no cloud — your data stays in the shop.

Every **job** travels a fixed pipeline:

**Design → Print → Laminate → Cut → Mask → Install → Complete**

Advance it by clicking a stage on the job card or dragging it on the board.

## What's inside

- **Dashboard** — big "Today" board (due, installs, overdue), KPI cards with
  drill-downs, pipeline bar with per-stage job chips, average-days-per-stage
  analytics, weather center (current, hourly, 7-day, live radar) with
  install-day warnings like "rain likely (70%)", quick notes, shop tasks,
  and industry news headlines.
- **Jobs** — list / kanban / week planner / month calendar views, search,
  substrate filters and batching, checklists, file uploads, material usage
  that auto-deducts inventory, printable work orders with QR codes that
  deep-link back to the job.
- **Quotes** — line-item quotes with tax and live totals, draft → sent →
  accepted/declined tracking, printable customer copy, one-click convert
  to a job.
- **Proof approval** — email a proof to the customer; they approve or
  request changes from a private link, and the decision lands in the job's
  activity timeline.
- **Customers** — lightweight CRM built from your job history.
- **Materials** — inventory with product codes/SKUs, vendors (Grimco-ready),
  costs, reorder points, low-stock alerts, paste-a-product-URL autofill,
  and a one-click emailed reorder list grouped by vendor.
- **Equipment** — service intervals with due warnings.
- **Email** — daily shop overview (overdue / due / installs / tasks / low
  stock) sent via your own Gmail every morning. Settings → Daily email
  overview (needs a Gmail app password, one-time setup).
- **Backups** — full snapshots (database + uploads + config + code) on
  every startup, nightly at midnight, before every import, and on demand.
  One-click restore rolls everything back. Keeps the newest 30.
- **Import/export** — jobs sync via CSV **or calendar (.ics)** files;
  materials, customers, history, and usage all export to CSV.

## Run it

Needs Python 3.9+.

```bash
pip install -r requirements.txt
python SignshopDashboard.py
```

Open http://localhost:5000. The database (`dashboard.db`) and config
(`config.json`) are created automatically on first run.

`python app.py` also works — it's a compatibility launcher kept so older
scheduled tasks keep running.

### Auto-start on Windows

Run `setup-autostart.ps1` in PowerShell **as Administrator** from this
folder. It creates a login task and opens firewall port 5000 (for phones /
other PCs, e.g. over Tailscale).

## Layout

```
SignshopDashboard.py   # the whole backend (Flask + SQLite)
static/app.js          # all frontend logic
static/theme.css       # design system, light + dark
templates/index.html   # single-page UI
website/               # static marketing site + project page
```

`dashboard.db`, `config.json`, `backups/`, and `uploads/` are local data
and are gitignored — they never leave your machine.

*This is a development project — expect it to keep evolving.*
