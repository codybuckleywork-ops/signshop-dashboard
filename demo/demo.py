"""
Demo launcher for the sign-shop dashboard.

This wraps the REAL app (SignshopDashboard.py) without changing a line of it,
so a public demo shows the actual product driving realistic sample data.

What it does differently from production:
  * Points the database, uploads, and backups at a throwaway demo folder
    (default: ./demo_data next to this file, or $DEMO_DATA_DIR). Your real
    dashboard.db is never touched.
  * Seeds that database with lifelike jobs, customers, materials, and quotes
    so the board looks alive the moment someone opens it.
  * Adds a "DEMO" banner and a Reset button so visitors can play freely and
    put things back to a clean state.
  * Never starts the email digest thread and never sends email.

Run locally:      python demo/demo.py
Serve for real:   gunicorn demo.demo:app --bind 0.0.0.0:$PORT   (run from repo root)
"""

import os
import sys
import sqlite3
import json
from datetime import datetime, timedelta

# Make the repo root importable no matter where gunicorn is launched from.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import SignshopDashboard as sd  # the real app module
from flask import request, jsonify

# --- Redirect all storage to a disposable demo location -----------------------
DEMO_DIR = os.environ.get("DEMO_DATA_DIR", os.path.join(os.path.dirname(__file__), "demo_data"))
os.makedirs(DEMO_DIR, exist_ok=True)

sd.DB_PATH = os.path.join(DEMO_DIR, "dashboard.db")
sd.CONFIG_PATH = os.path.join(DEMO_DIR, "config.json")
sd.UPLOAD_DIR = os.path.join(DEMO_DIR, "uploads")
sd.BACKUP_DIR = os.path.join(DEMO_DIR, "backups")
os.makedirs(sd.UPLOAD_DIR, exist_ok=True)

app = sd.app  # gunicorn entry point: demo.demo:app


# --- Sample data --------------------------------------------------------------

def _iso(days_from_now=0):
    return (datetime.now() + timedelta(days=days_from_now)).isoformat()


def _date(days_from_now=0):
    return (datetime.now() + timedelta(days=days_from_now)).date().isoformat()


def seed(force=False):
    """Populate the demo DB. If force=True, wipe existing rows first."""
    sd.init_db()  # create tables / run migrations against the demo DB
    db = sqlite3.connect(sd.DB_PATH)
    db.row_factory = sqlite3.Row

    # Seed on a fresh DB or when a reset is forced. Visitor edits otherwise
    # survive page reloads (until the free host spins down and wipes the disk).
    has_jobs = db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] > 0
    if has_jobs and not force:
        db.close()
        return

    # Start from a clean slate (also clears the single equipment row that
    # init_db seeds by default, so nothing is duplicated).
    for t in ("tasks", "equipment", "notes", "jobs", "quotes", "materials",
              "job_events", "job_files", "job_materials", "customers"):
        db.execute(f"DELETE FROM {t}")
    db.commit()

    # Materials - a few sit at/below reorder point to show low-stock highlighting.
    materials = [
        # name, sku, vendor, category, on_hand, unit, reorder_at, cost, location
        ("3M IJ180Cv3 Gloss Vinyl 54\"", "IJ180-54", "Grimco", "vinyl", 3, "rolls", 4, 289.00, "Rack A2"),
        ("3M 8518 Gloss Laminate 54\"", "8518-54", "Grimco", "laminate", 2, "rolls", 3, 245.00, "Rack A3"),
        ("Coroplast 4mm White 48x96", "CORO-4-4896", "Grimco", "substrate", 40, "sheets", 20, 11.50, "Bay 1"),
        ("ACM 3mm White 48x96", "ACM-3-4896", "Grimco", "substrate", 6, "sheets", 12, 34.00, "Bay 2"),
        ("Aluminum .063 48x96", "AL063-4896", "Grimco", "substrate", 18, "sheets", 8, 41.00, "Bay 2"),
        ("Banner 13oz Matte 54\"", "BAN13-54", "Grimco", "banner", 1, "rolls", 2, 96.00, "Rack B1"),
        ("Application Tape 48\"", "APT-48", "Grimco", "misc", 9, "rolls", 4, 62.00, "Shelf C"),
        ("Grommets #2 (box 500)", "GROM-2", "Grimco", "hardware", 5, "boxes", 2, 18.00, "Shelf C"),
    ]
    for m in materials:
        db.execute(
            "INSERT INTO materials (name, sku, vendor, category, on_hand, unit, reorder_at, cost, location, product_url, notes) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (*m, "", ""))

    # Customers with contact cards.
    customers = [
        ("Riverside Dental", "Dr. Amy Colton", "256-555-0142", "front@riversidedental.com"),
        ("Hazel Green HS Athletics", "Coach Beck", "256-555-0177", "beck@hghsathletics.org"),
        ("Northside Auto", "Marcus Lee", "256-555-0190", "marcus@northsideauto.com"),
        ("Bloom Coffee Co.", "Priya Shah", "256-555-0133", "hello@bloomcoffee.co"),
        ("Valley Realty Group", "Tom Alvarez", "256-555-0166", "tom@valleyrealty.com"),
    ]
    for name, contact, phone, email in customers:
        db.execute(
            "INSERT INTO customers (name, contact, phone, email, notes, created_at) VALUES (?,?,?,?,?,?)",
            (name, contact, phone, email, "", _iso(-30)))

    # Jobs spread across every stage, with realistic dates and a couple overdue.
    # (customer, job_name, stage, substrate, assigned_to, priority, due_offset,
    #  install_offset, on_hold, install_location, notes)
    jobs = [
        ("Riverside Dental", "Monument sign face", "design", "acm", "Sam", "high", 5, 9, 0, "1200 River Rd", "Waiting on final logo vector"),
        ("Bloom Coffee Co.", "Storefront window graphics", "print", "vinyl", "Dana", "medium", 3, 6, 0, "88 Main St", "Frosted + full color combo"),
        ("Northside Auto", "6 lot directional signs", "laminate", "coroplast", "Sam", "medium", 2, 4, 0, "Northside lot", ""),
        ("Hazel Green HS Athletics", "Football field banner 4x8", "cut", "banner", "Dana", "high", 0, 1, 0, "HGHS stadium", "Install before Friday game"),
        ("Valley Realty Group", "25 open-house yard signs", "mask", "coroplast", "Sam", "low", -1, 2, 0, "Various", "Overdue - client pushed art late"),
        ("Northside Auto", "Building ID channel letters (vinyl faces)", "install", "acrylic", "Sam", "high", -2, 0, 0, "410 Commerce Blvd", "Overdue install, crew scheduled AM"),
        ("Bloom Coffee Co.", "A-frame sidewalk sign", "install", "aluminum", "Dana", "medium", 1, 0, 1, "88 Main St", "On hold - customer choosing colors"),
        ("Riverside Dental", "Reception wall logo", "complete", "acrylic", "Dana", "medium", -6, -5, 0, "1200 River Rd", "Installed, customer thrilled"),
        ("Valley Realty Group", "Vehicle door magnets (x4)", "complete", "magnetic", "Sam", "low", -10, -9, 0, "", "Picked up"),
        ("Hazel Green HS Athletics", "Booster banner set (x3)", "complete", "banner", "Dana", "medium", -14, -12, 0, "HGHS gym", "Reorder likely next season"),
    ]
    for (cust, jn, stage, sub, who, prio, due, inst, hold, loc, notes) in jobs:
        created = _iso(-(abs(due) + 7))
        completed = _iso(inst) if stage == "complete" else None
        cur = db.execute(
            "INSERT INTO jobs (customer, job_name, stage, substrate, assigned_to, priority, on_hold, "
            "due_date, install_date, install_location, notes, created_at, completed_at, stage_changed_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cust, jn, stage, sub, who, prio, hold, _date(due), _date(inst), loc, notes,
             created, completed, _iso(-1)))
        jid = cur.lastrowid
        # A little stage history so analytics + the job timeline populate.
        db.execute("INSERT INTO job_events (job_id, event, detail, created_at) VALUES (?,?,?,?)",
                   (jid, "created", "Job created at stage 'design'", created))
        order = sd.STAGES[:sd.STAGES.index(stage) + 1] if stage in sd.STAGES else ["design"]
        step = created
        for a, b in zip(order, order[1:]):
            step = (datetime.fromisoformat(step) + timedelta(days=1, hours=6)).isoformat()
            db.execute("INSERT INTO job_events (job_id, event, detail, created_at) VALUES (?,?,?,?)",
                       (jid, "stage", f"{a} → {b}", step))
        # Log some material usage on a couple of jobs (drives sqft + usage log).
        if sub == "coroplast":
            db.execute("INSERT INTO job_materials (job_id, material_name, qty, unit, sqft, notes, created_at) "
                       "VALUES (?,?,?,?,?,?,?)", (jid, "Coroplast 4mm White 48x96", 6, "sheets", 192, "", step))
        if sub in ("vinyl", "banner"):
            db.execute("INSERT INTO job_materials (job_id, material_name, qty, unit, sqft, notes, created_at) "
                       "VALUES (?,?,?,?,?,?,?)", (jid, "3M IJ180Cv3 Gloss Vinyl 54\"", 1, "rolls", 48, "", step))

    # Quotes in a few states (one convertible to a job in the demo).
    quotes = [
        ("Bloom Coffee Co.", "Patio menu board + hours decal", "sent",
         [{"desc": "48x36 ACM menu board", "qty": 1, "price": 240},
          {"desc": "Hours vinyl decal", "qty": 1, "price": 45}]),
        ("Valley Realty Group", "Rider signs (50)", "draft",
         [{"desc": "6x24 coroplast rider", "qty": 50, "price": 7.5}]),
        ("Northside Auto", "Full window perf wrap", "accepted",
         [{"desc": "Perforated window film install", "qty": 1, "price": 620}]),
    ]
    for cust, title, status, items in quotes:
        db.execute("INSERT INTO quotes (customer, title, items, tax_rate, status, notes, created_at) "
                   "VALUES (?,?,?,?,?,?,?)",
                   (cust, title, json.dumps(items), 9.0, status, "", _iso(-4)))

    # Equipment + a couple shop notes and tasks.
    db.execute("INSERT INTO equipment (name, last_service, interval_days, notes) VALUES (?,?,?,?)",
               ("GFP 363TH Laminator", _date(-40), 90, "Check heater roller and blades for nicks"))
    db.execute("INSERT INTO equipment (name, last_service, interval_days, notes) VALUES (?,?,?,?)",
               ("Roland TrueVIS Printer/Cutter", _date(-95), 90, "Overdue - head clean + capping station"))
    for content in ("Call Grimco about backordered 8518 laminate",
                    "Reorder application tape before Friday"):
        db.execute("INSERT INTO notes (content, resolved, created_at) VALUES (?,0,?)", (content, _iso(-1)))
    for title, prio, due in (("Order more grommets", "medium", 2),
                             ("Schedule printer maintenance", "high", 1)):
        db.execute("INSERT INTO tasks (title, category, priority, due_date, completed, created_at) "
                   "VALUES (?,?,?,?,0,?)", (title, "maintenance", prio, _date(due), _iso(-1)))

    db.commit()
    db.close()


# --- Demo banner + reset ------------------------------------------------------

DEMO_BANNER = """
<div id="sd-demo-banner" style="position:fixed;left:0;right:0;bottom:0;z-index:99999;
  background:#0f766e;color:#fff;font:600 13px/1.4 system-ui,sans-serif;
  padding:8px 14px;display:flex;align-items:center;justify-content:center;gap:14px;
  box-shadow:0 -2px 10px rgba(0,0,0,.15)">
  <span>Live demo - sample data, everyone shares this board. Play freely.</span>
  <button onclick="if(confirm('Reset the demo to fresh sample data?')){fetch('/api/demo/reset',{method:'POST'}).then(function(){location.reload()})}"
    style="background:#fff;color:#0f766e;border:none;border-radius:999px;
    padding:5px 14px;font:inherit;cursor:pointer">Reset demo</button>
</div>
"""


@app.after_request
def _inject_demo_banner(resp):
    try:
        if (not resp.direct_passthrough
                and request.path == "/"
                and "text/html" in resp.headers.get("Content-Type", "")):
            html = resp.get_data(as_text=True)
            if "</body>" in html and "sd-demo-banner" not in html:
                resp.set_data(html.replace("</body>", DEMO_BANNER + "</body>"))
    except Exception:
        pass
    return resp


@app.route("/api/demo/reset", methods=["POST"])
def demo_reset():
    seed(force=True)
    return jsonify({"ok": True, "message": "Demo reset to sample data."})


# Seed on import so gunicorn 