# Sign shop production dashboard — Flask + SQLite.
import csv
import io
import re
import sqlite3
import json
import os
import uuid
import zipfile
import smtplib
import threading
import time
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.application import MIMEApplication
from datetime import datetime
from flask import Flask, jsonify, request, render_template, g, Response, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "dashboard.db")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
BACKUP_DIR = os.path.join(BASE_DIR, "backups")
BACKUP_KEEP = 30  # keep the newest N snapshots

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024  # 64 MB uploads

DEFAULT_CONFIG = {
    "shop_name": "Production Dashboard",
    "location_name": "Hazel Green, AL",
    "lat": 34.9265,
    "lon": -86.5847,
    "google_calendar_connected": False,
    "digest_enabled": False,
    "digest_to": "",
    "digest_hour": 7,
    "smtp_user": "",
    "smtp_app_password": ""
}

CATEGORIES = ["print", "laminate", "cut", "mask", "install", "material", "maintenance", "general"]
STAGES = ["design", "print", "laminate", "cut", "mask", "install", "complete"]
SUBSTRATES = [
    "acm", "coroplast", "aluminum", "pvc", "acrylic",
    "banner", "vinyl", "magnetic", "mdo", "other",
]
FILE_KINDS = ["photo", "proof", "artwork", "document", "other"]

ALLOWED_EXTENSIONS = {
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "svg",
    "pdf", "ai", "eps", "psd", "cdr", "dxf", "plt",
    "doc", "docx", "xls", "xlsx", "csv", "txt", "zip",
}


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


@app.after_request
def no_cache_static(resp):
    # The browser was holding onto stale CSS/JS after updates; force it to
    # revalidate static assets on every load.
    if request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


def init_db():
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.execute("""
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            notes TEXT DEFAULT '',
            category TEXT DEFAULT 'general',
            due_date TEXT,
            priority TEXT DEFAULT 'medium',
            completed INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS equipment (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            last_service TEXT,
            interval_days INTEGER DEFAULT 90,
            notes TEXT DEFAULT ''
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            resolved INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer TEXT NOT NULL,
            job_name TEXT NOT NULL,
            stage TEXT DEFAULT 'design',
            due_date TEXT,
            install_date TEXT,
            priority TEXT DEFAULT 'medium',
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            completed_at TEXT
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS quotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer TEXT NOT NULL,
            title TEXT NOT NULL,
            items TEXT DEFAULT '[]',
            tax_rate REAL DEFAULT 0,
            status TEXT DEFAULT 'draft',
            notes TEXT DEFAULT '',
            job_id INTEGER,
            created_at TEXT NOT NULL
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS materials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            on_hand REAL DEFAULT 0,
            unit TEXT DEFAULT 'sheets',
            reorder_at REAL DEFAULT 0,
            notes TEXT DEFAULT ''
        )
    """)
    # Per-job stage/event history (verbose audit trail).
    db.execute("""
        CREATE TABLE IF NOT EXISTS job_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL,
            event TEXT NOT NULL,
            detail TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )
    """)
    # Files attached to a job: site photos, proofs, artwork, etc.
    db.execute("""
        CREATE TABLE IF NOT EXISTS job_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL,
            kind TEXT DEFAULT 'other',
            label TEXT DEFAULT '',
            orig_name TEXT NOT NULL,
            stored_name TEXT NOT NULL,
            size INTEGER DEFAULT 0,
            uploaded_at TEXT NOT NULL
        )
    """)
    # Material usage logged against a job (sq ft, sheets, rolls...).
    db.execute("""
        CREATE TABLE IF NOT EXISTS job_materials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL,
            material_id INTEGER,
            material_name TEXT NOT NULL,
            qty REAL DEFAULT 0,
            unit TEXT DEFAULT 'sqft',
            sqft REAL DEFAULT 0,
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )
    """)
    # Customer contact info; jobs reference customers by name so this is a
    # lightweight CRM layered over the job list.
    db.execute("""
        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            contact TEXT DEFAULT '',
            phone TEXT DEFAULT '',
            email TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )
    """)
    db.commit()

    # Proof files can be approved by the customer; track that on the file.
    existing_files = {r[1] for r in db.execute("PRAGMA table_info(job_files)").fetchall()}
    if "approved" not in existing_files:
        db.execute("ALTER TABLE job_files ADD COLUMN approved INTEGER DEFAULT 0")
    if "approve_token" not in existing_files:
        db.execute("ALTER TABLE job_files ADD COLUMN approve_token TEXT DEFAULT ''")
    db.commit()

    # Migrate older databases in place: add any missing job columns.
    existing = {r[1] for r in db.execute("PRAGMA table_info(jobs)").fetchall()}
    migrations = {
        "substrate": "ALTER TABLE jobs ADD COLUMN substrate TEXT DEFAULT ''",
        "on_hold": "ALTER TABLE jobs ADD COLUMN on_hold INTEGER DEFAULT 0",
        "stage_changed_at": "ALTER TABLE jobs ADD COLUMN stage_changed_at TEXT",
        "assigned_to": "ALTER TABLE jobs ADD COLUMN assigned_to TEXT DEFAULT ''",
        "install_location": "ALTER TABLE jobs ADD COLUMN install_location TEXT DEFAULT ''",
    }
    for col, ddl in migrations.items():
        if col not in existing:
            db.execute(ddl)
    # Backfill stage_changed_at so aging starts counting from job creation.
    db.execute("UPDATE jobs SET stage_changed_at = created_at WHERE stage_changed_at IS NULL")

    # Tasks can optionally belong to a job (a per-job checklist item).
    existing_tasks = {r[1] for r in db.execute("PRAGMA table_info(tasks)").fetchall()}
    if "job_id" not in existing_tasks:
        db.execute("ALTER TABLE tasks ADD COLUMN job_id INTEGER")
    db.commit()

    # Inventory management fields: product codes, vendor (e.g. Grimco),
    # cost, direct product link, and shop storage location.
    existing_mats = {r[1] for r in db.execute("PRAGMA table_info(materials)").fetchall()}
    mat_migrations = {
        "sku": "ALTER TABLE materials ADD COLUMN sku TEXT DEFAULT ''",
        "vendor": "ALTER TABLE materials ADD COLUMN vendor TEXT DEFAULT ''",
        "cost": "ALTER TABLE materials ADD COLUMN cost REAL DEFAULT 0",
        "product_url": "ALTER TABLE materials ADD COLUMN product_url TEXT DEFAULT ''",
        "category": "ALTER TABLE materials ADD COLUMN category TEXT DEFAULT ''",
        "location": "ALTER TABLE materials ADD COLUMN location TEXT DEFAULT ''",
    }
    for col, ddl in mat_migrations.items():
        if col not in existing_mats:
            db.execute(ddl)
    db.commit()

    # Seed with a couple of realistic starting rows if empty
    cur = db.execute("SELECT COUNT(*) FROM equipment")
    if cur.fetchone()[0] == 0:
        db.execute(
            "INSERT INTO equipment (name, last_service, interval_days, notes) VALUES (?,?,?,?)",
            ("GFP 363TH Laminator", datetime.now().date().isoformat(), 90,
             "Check heater roller and blades for nicks")
        )
        db.commit()
    db.close()


def load_config():
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "w") as f:
            json.dump(DEFAULT_CONFIG, f, indent=2)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)


def log_event(db, job_id, event, detail=""):
    db.execute(
        "INSERT INTO job_events (job_id, event, detail, created_at) VALUES (?,?,?,?)",
        (job_id, event, detail, datetime.now().isoformat()),
    )


@app.route("/")
def index():
    return render_template("index.html")


# ======================================================================
# Tasks
# ======================================================================

@app.route("/api/tasks", methods=["GET"])
def get_tasks():
    db = get_db()
    rows = db.execute("SELECT * FROM tasks ORDER BY completed ASC, due_date IS NULL, due_date ASC, priority DESC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/tasks", methods=["POST"])
def create_task():
    data = request.get_json(force=True)
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title is required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO tasks (title, notes, category, due_date, priority, completed, created_at, job_id) VALUES (?,?,?,?,?,0,?,?)",
        (
            title,
            data.get("notes", ""),
            data.get("category", "general") if data.get("category") in CATEGORIES else "general",
            data.get("due_date"),
            data.get("priority", "medium"),
            datetime.now().isoformat(),
            data.get("job_id"),
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/tasks/<int:task_id>", methods=["PATCH"])
def update_task(task_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404

    fields = {}
    for key in ["title", "notes", "category", "due_date", "priority", "completed", "job_id"]:
        if key in data:
            fields[key] = data[key]

    if fields:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        db.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", (*fields.values(), task_id))
        db.commit()

    row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/tasks/<int:task_id>", methods=["DELETE"])
def delete_task(task_id):
    db = get_db()
    db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    db.commit()
    return "", 204


# ======================================================================
# Equipment
# ======================================================================

@app.route("/api/equipment", methods=["GET"])
def get_equipment():
    db = get_db()
    rows = db.execute("SELECT * FROM equipment ORDER BY last_service ASC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/equipment", methods=["POST"])
def create_equipment():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO equipment (name, last_service, interval_days, notes) VALUES (?,?,?,?)",
        (name, data.get("last_service"), data.get("interval_days", 90), data.get("notes", "")),
    )
    db.commit()
    row = db.execute("SELECT * FROM equipment WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/equipment/<int:eq_id>", methods=["PATCH"])
def update_equipment(eq_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM equipment WHERE id = ?", (eq_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    fields = {}
    for key in ["name", "last_service", "interval_days", "notes"]:
        if key in data:
            fields[key] = data[key]
    if fields:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        db.execute(f"UPDATE equipment SET {set_clause} WHERE id = ?", (*fields.values(), eq_id))
        db.commit()
    row = db.execute("SELECT * FROM equipment WHERE id = ?", (eq_id,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/equipment/<int:eq_id>", methods=["DELETE"])
def delete_equipment(eq_id):
    db = get_db()
    db.execute("DELETE FROM equipment WHERE id = ?", (eq_id,))
    db.commit()
    return "", 204


# ======================================================================
# Jobs
# ======================================================================

JOB_FIELDS = ["customer", "job_name", "stage", "due_date", "install_date",
              "priority", "notes", "substrate", "on_hold", "assigned_to",
              "install_location"]


@app.route("/api/jobs", methods=["GET"])
def get_jobs():
    db = get_db()
    rows = db.execute(
        "SELECT jobs.*, "
        "(SELECT COUNT(*) FROM job_files f WHERE f.job_id = jobs.id AND f.kind = 'proof' AND f.approved = 0) AS pending_proofs "
        "FROM jobs ORDER BY "
        "CASE stage WHEN 'complete' THEN 1 ELSE 0 END ASC, "
        "on_hold ASC, "
        "due_date IS NULL, due_date ASC, priority DESC"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/jobs", methods=["POST"])
def create_job():
    data = request.get_json(force=True)
    customer = (data.get("customer") or "").strip()
    job_name = (data.get("job_name") or "").strip()
    if not customer or not job_name:
        return jsonify({"error": "customer and job_name are required"}), 400

    stage = data.get("stage", "design")
    if stage not in STAGES:
        return jsonify({"error": f"stage must be one of {STAGES}"}), 400

    substrate = data.get("substrate", "")
    if substrate and substrate not in SUBSTRATES:
        substrate = "other"

    now = datetime.now().isoformat()
    db = get_db()
    cur = db.execute(
        "INSERT INTO jobs (customer, job_name, stage, due_date, install_date, priority, notes, substrate, on_hold, assigned_to, install_location, created_at, completed_at, stage_changed_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            customer,
            job_name,
            stage,
            data.get("due_date"),
            data.get("install_date"),
            data.get("priority", "medium"),
            data.get("notes", ""),
            substrate,
            1 if data.get("on_hold") else 0,
            data.get("assigned_to", ""),
            data.get("install_location", ""),
            now,
            now if stage == "complete" else None,
            now,
        ),
    )
    log_event(db, cur.lastrowid, "created", f"Job created at stage '{stage}'")
    db.commit()
    row = db.execute("SELECT * FROM jobs WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/jobs/<int:job_id>", methods=["PATCH"])
def update_job(job_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404

    if "stage" in data and data["stage"] not in STAGES:
        return jsonify({"error": f"stage must be one of {STAGES}"}), 400

    if "substrate" in data and data["substrate"] and data["substrate"] not in SUBSTRATES:
        data["substrate"] = "other"

    fields = {}
    for key in JOB_FIELDS:
        if key in data:
            fields[key] = data[key]

    # Track completion timestamp automatically as the job enters/leaves the
    # complete stage. Also stamp stage_changed_at and write an event whenever
    # the stage actually changes, so history shows the full journey.
    if "stage" in fields:
        now = datetime.now().isoformat()
        fields["completed_at"] = now if fields["stage"] == "complete" else None
        if fields["stage"] != row["stage"]:
            fields["stage_changed_at"] = now
            log_event(db, job_id, "stage", f"{row['stage']} → {fields['stage']}")

    if "on_hold" in fields and bool(fields["on_hold"]) != bool(row["on_hold"]):
        log_event(db, job_id, "hold", "Put on hold" if fields["on_hold"] else "Released from hold")

    if fields:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        db.execute(f"UPDATE jobs SET {set_clause} WHERE id = ?", (*fields.values(), job_id))
    db.commit()

    row = db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/jobs/<int:job_id>", methods=["DELETE"])
def delete_job(job_id):
    db = get_db()
    # Remove uploaded files from disk along with the job.
    for f in db.execute("SELECT stored_name FROM job_files WHERE job_id = ?", (job_id,)).fetchall():
        try:
            os.remove(os.path.join(UPLOAD_DIR, f["stored_name"]))
        except OSError:
            pass
    db.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
    db.execute("DELETE FROM tasks WHERE job_id = ?", (job_id,))
    db.execute("DELETE FROM job_events WHERE job_id = ?", (job_id,))
    db.execute("DELETE FROM job_files WHERE job_id = ?", (job_id,))
    db.execute("DELETE FROM job_materials WHERE job_id = ?", (job_id,))
    db.commit()
    return "", 204


@app.route("/api/jobs/<int:job_id>/detail", methods=["GET"])
def job_detail(job_id):
    """Everything about one job in a single call: the verbose overview."""
    db = get_db()
    row = db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    events = db.execute("SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC", (job_id,)).fetchall()
    files = db.execute("SELECT * FROM job_files WHERE job_id = ? ORDER BY uploaded_at DESC", (job_id,)).fetchall()
    mats = db.execute("SELECT * FROM job_materials WHERE job_id = ? ORDER BY created_at DESC", (job_id,)).fetchall()
    checklist = db.execute("SELECT * FROM tasks WHERE job_id = ? ORDER BY completed ASC, id ASC", (job_id,)).fetchall()
    return jsonify({
        "job": dict(row),
        "events": [dict(e) for e in events],
        "files": [dict(f) for f in files],
        "materials": [dict(m) for m in mats],
        "checklist": [dict(c) for c in checklist],
        "total_sqft": sum((m["sqft"] or 0) for m in mats),
    })


# ======================================================================
# Job files (site photos, proofs, artwork...)
# ======================================================================

def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


@app.route("/api/jobs/<int:job_id>/files", methods=["GET"])
def get_job_files(job_id):
    db = get_db()
    rows = db.execute("SELECT * FROM job_files WHERE job_id = ? ORDER BY uploaded_at DESC", (job_id,)).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/jobs/<int:job_id>/files", methods=["POST"])
def upload_job_file(job_id):
    db = get_db()
    job = db.execute("SELECT id FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not job:
        return jsonify({"error": "job not found"}), 404

    file = request.files.get("file")
    if not file or not file.filename:
        return jsonify({"error": "no file provided"}), 400
    if not allowed_file(file.filename):
        return jsonify({"error": "file type not allowed"}), 400

    kind = request.form.get("kind", "other")
    if kind not in FILE_KINDS:
        kind = "other"
    label = (request.form.get("label") or "").strip()

    ext = file.filename.rsplit(".", 1)[1].lower()
    stored_name = f"job{job_id}_{uuid.uuid4().hex[:12]}.{ext}"
    file.save(os.path.join(UPLOAD_DIR, stored_name))
    size = os.path.getsize(os.path.join(UPLOAD_DIR, stored_name))

    cur = db.execute(
        "INSERT INTO job_files (job_id, kind, label, orig_name, stored_name, size, uploaded_at) VALUES (?,?,?,?,?,?,?)",
        (job_id, kind, label, file.filename, stored_name, size, datetime.now().isoformat()),
    )
    log_event(db, job_id, "file", f"Uploaded {kind}: {file.filename}")
    db.commit()
    row = db.execute("SELECT * FROM job_files WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/files/<int:file_id>", methods=["PATCH"])
def update_job_file(file_id):
    """Toggle proof approval (or update a file's label/kind)."""
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM job_files WHERE id = ?", (file_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    fields = {}
    for key in ["label", "kind", "approved"]:
        if key in data:
            fields[key] = data[key]
    if "kind" in fields and fields["kind"] not in FILE_KINDS:
        fields["kind"] = "other"
    if fields:
        if "approved" in fields and bool(fields["approved"]) != bool(row["approved"]):
            verb = "approved" if fields["approved"] else "approval revoked for"
            log_event(db, row["job_id"], "file", f"Proof {verb}: {row['label'] or row['orig_name']}")
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        db.execute(f"UPDATE job_files SET {set_clause} WHERE id = ?", (*fields.values(), file_id))
        db.commit()
    row = db.execute("SELECT * FROM job_files WHERE id = ?", (file_id,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/files/<int:file_id>", methods=["DELETE"])
def delete_job_file(file_id):
    db = get_db()
    row = db.execute("SELECT * FROM job_files WHERE id = ?", (file_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    try:
        os.remove(os.path.join(UPLOAD_DIR, row["stored_name"]))
    except OSError:
        pass
    log_event(db, row["job_id"], "file", f"Removed file: {row['orig_name']}")
    db.execute("DELETE FROM job_files WHERE id = ?", (file_id,))
    db.commit()
    return "", 204


@app.route("/files/<path:stored_name>")
def serve_file(stored_name):
    return send_from_directory(UPLOAD_DIR, stored_name)


# ======================================================================
# Job material usage (with auto-deduct from inventory)
# ======================================================================

@app.route("/api/jobs/<int:job_id>/materials", methods=["POST"])
def log_job_material(job_id):
    data = request.get_json(force=True)
    db = get_db()
    job = db.execute("SELECT id FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not job:
        return jsonify({"error": "job not found"}), 404

    material_id = data.get("material_id")
    name = (data.get("material_name") or "").strip()
    qty = float(data.get("qty") or 0)
    unit = data.get("unit", "sqft")
    sqft = float(data.get("sqft") or 0)

    mat = None
    if material_id:
        mat = db.execute("SELECT * FROM materials WHERE id = ?", (material_id,)).fetchone()
        if mat and not name:
            name = mat["name"]
    if not name:
        return jsonify({"error": "material_name (or valid material_id) is required"}), 400
    if qty <= 0 and sqft <= 0:
        return jsonify({"error": "qty or sqft must be greater than zero"}), 400

    cur = db.execute(
        "INSERT INTO job_materials (job_id, material_id, material_name, qty, unit, sqft, notes, created_at) VALUES (?,?,?,?,?,?,?,?)",
        (job_id, mat["id"] if mat else None, name, qty, unit, sqft,
         data.get("notes", ""), datetime.now().isoformat()),
    )

    # Auto-deduct from inventory when linked to a tracked material.
    deducted = 0
    if mat and data.get("deduct", True) and qty > 0:
        new_on_hand = max(0, (mat["on_hand"] or 0) - qty)
        deducted = (mat["on_hand"] or 0) - new_on_hand
        db.execute("UPDATE materials SET on_hand = ? WHERE id = ?", (new_on_hand, mat["id"]))

    detail = f"Used {qty} {unit} of {name}"
    if sqft:
        detail += f" ({sqft} sqft)"
    if deducted:
        detail += f" — deducted {deducted} from stock"
    log_event(db, job_id, "material", detail)
    db.commit()
    row = db.execute("SELECT * FROM job_materials WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/job-materials/<int:jm_id>", methods=["DELETE"])
def delete_job_material(jm_id):
    """Remove a usage entry and put the quantity back into inventory."""
    db = get_db()
    row = db.execute("SELECT * FROM job_materials WHERE id = ?", (jm_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    if row["material_id"]:
        mat = db.execute("SELECT * FROM materials WHERE id = ?", (row["material_id"],)).fetchone()
        if mat:
            db.execute("UPDATE materials SET on_hand = ? WHERE id = ?",
                       ((mat["on_hand"] or 0) + (row["qty"] or 0), mat["id"]))
    log_event(db, row["job_id"], "material",
              f"Removed usage entry: {row['qty']} {row['unit']} of {row['material_name']} (restocked)")
    db.execute("DELETE FROM job_materials WHERE id = ?", (jm_id,))
    db.commit()
    return "", 204


@app.route("/api/material-usage", methods=["GET"])
def material_usage():
    """All usage rows joined with job info — feeds the materials page log."""
    db = get_db()
    rows = db.execute(
        "SELECT jm.*, j.job_name, j.customer FROM job_materials jm "
        "LEFT JOIN jobs j ON j.id = jm.job_id ORDER BY jm.created_at DESC LIMIT 200"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


# ======================================================================
# Customers (lightweight CRM over the job list)
# ======================================================================

@app.route("/api/customers", methods=["GET"])
def get_customers():
    """Every customer seen on a job, merged with saved contact info and
    aggregated job stats — a Printavo-style customer profile."""
    db = get_db()
    saved = {r["name"].lower(): dict(r) for r in db.execute("SELECT * FROM customers").fetchall()}
    jobs = db.execute("SELECT * FROM jobs").fetchall()
    usage = db.execute("SELECT job_id, SUM(sqft) AS sqft FROM job_materials GROUP BY job_id").fetchall()
    sqft_by_job = {r["job_id"]: r["sqft"] or 0 for r in usage}

    stats = {}
    for j in jobs:
        key = (j["customer"] or "").strip()
        if not key:
            continue
        s = stats.setdefault(key.lower(), {
            "name": key, "total_jobs": 0, "open_jobs": 0, "completed_jobs": 0,
            "overdue_jobs": 0, "total_sqft": 0, "last_activity": "", "open_names": [],
        })
        s["total_jobs"] += 1
        s["total_sqft"] += sqft_by_job.get(j["id"], 0)
        if j["stage"] == "complete":
            s["completed_jobs"] += 1
        else:
            s["open_jobs"] += 1
            if len(s["open_names"]) < 3:
                s["open_names"].append(j["job_name"])
            today = datetime.now().date().isoformat()
            if j["due_date"] and j["due_date"] < today:
                s["overdue_jobs"] += 1
        latest = j["completed_at"] or j["stage_changed_at"] or j["created_at"] or ""
        if latest > s["last_activity"]:
            s["last_activity"] = latest

    out = []
    seen = set()
    for key, s in stats.items():
        seen.add(key)
        c = saved.get(key, {})
        out.append({**s, "id": c.get("id"), "contact": c.get("contact", ""),
                    "phone": c.get("phone", ""), "email": c.get("email", ""),
                    "notes": c.get("notes", "")})
    # Customers saved with contact info but no jobs yet.
    for key, c in saved.items():
        if key not in seen:
            out.append({"name": c["name"], "id": c["id"], "contact": c["contact"],
                        "phone": c["phone"], "email": c["email"], "notes": c["notes"],
                        "total_jobs": 0, "open_jobs": 0, "completed_jobs": 0,
                        "overdue_jobs": 0, "total_sqft": 0, "last_activity": "", "open_names": []})
    out.sort(key=lambda c: (-c["open_jobs"], c["name"].lower()))
    return jsonify(out)


@app.route("/api/customers", methods=["POST"])
def upsert_customer():
    """Create or update a customer's contact card, keyed by name."""
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    db = get_db()
    row = db.execute("SELECT * FROM customers WHERE lower(name) = lower(?)", (name,)).fetchone()
    fields = {k: (data.get(k) or "").strip() for k in ["contact", "phone", "email", "notes"]}
    if row:
        db.execute("UPDATE customers SET contact = ?, phone = ?, email = ?, notes = ? WHERE id = ?",
                   (fields["contact"], fields["phone"], fields["email"], fields["notes"], row["id"]))
        cid = row["id"]
    else:
        cur = db.execute(
            "INSERT INTO customers (name, contact, phone, email, notes, created_at) VALUES (?,?,?,?,?,?)",
            (name, fields["contact"], fields["phone"], fields["email"], fields["notes"],
             datetime.now().isoformat()),
        )
        cid = cur.lastrowid
    db.commit()
    row = db.execute("SELECT * FROM customers WHERE id = ?", (cid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/customers/<int:cust_id>", methods=["DELETE"])
def delete_customer(cust_id):
    """Removes the saved contact card only — jobs keep their customer name."""
    db = get_db()
    db.execute("DELETE FROM customers WHERE id = ?", (cust_id,))
    db.commit()
    return "", 204


@app.route("/api/export/customers.csv", methods=["GET"])
def export_customers_csv():
    data = get_customers().json
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["name", "contact", "phone", "email", "notes", "open_jobs",
                     "completed_jobs", "total_jobs", "total_sqft", "last_activity"])
    for c in data:
        writer.writerow([c["name"], c["contact"], c["phone"], c["email"], c["notes"],
                         c["open_jobs"], c["completed_jobs"], c["total_jobs"],
                         c["total_sqft"], c["last_activity"]])
    return csv_response(out.getvalue(), "customers.csv")


# ======================================================================
# History (verbose record of completed jobs)
# ======================================================================

@app.route("/api/history", methods=["GET"])
def get_history():
    db = get_db()
    jobs = db.execute(
        "SELECT * FROM jobs WHERE stage = 'complete' ORDER BY completed_at DESC"
    ).fetchall()
    out = []
    for j in jobs:
        jd = dict(j)
        jid = j["id"]
        events = db.execute("SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC", (jid,)).fetchall()
        mats = db.execute("SELECT * FROM job_materials WHERE job_id = ?", (jid,)).fetchall()
        files = db.execute("SELECT * FROM job_files WHERE job_id = ?", (jid,)).fetchall()
        checklist = db.execute("SELECT * FROM tasks WHERE job_id = ?", (jid,)).fetchall()
        turnaround_days = None
        if j["completed_at"] and j["created_at"]:
            try:
                delta = datetime.fromisoformat(j["completed_at"]) - datetime.fromisoformat(j["created_at"])
                turnaround_days = max(0, round(delta.total_seconds() / 86400, 1))
            except ValueError:
                pass
        jd.update({
            "events": [dict(e) for e in events],
            "materials": [dict(m) for m in mats],
            "files": [dict(f) for f in files],
            "checklist_done": sum(1 for c in checklist if c["completed"]),
            "checklist_total": len(checklist),
            "total_sqft": sum((m["sqft"] or 0) for m in mats),
            "turnaround_days": turnaround_days,
        })
        out.append(jd)
    return jsonify(out)


# ======================================================================
# Quotes (API kept for future use; no UI)
# ======================================================================

QUOTE_STATUSES = ["draft", "sent", "accepted", "declined"]


@app.route("/api/quotes", methods=["GET"])
def get_quotes():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM quotes ORDER BY "
        "CASE status WHEN 'accepted' THEN 1 WHEN 'declined' THEN 2 ELSE 0 END ASC, "
        "created_at DESC"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/quotes", methods=["POST"])
def create_quote():
    data = request.get_json(force=True)
    customer = (data.get("customer") or "").strip()
    title = (data.get("title") or "").strip()
    if not customer or not title:
        return jsonify({"error": "customer and title are required"}), 400
    status = data.get("status", "draft")
    if status not in QUOTE_STATUSES:
        status = "draft"
    db = get_db()
    cur = db.execute(
        "INSERT INTO quotes (customer, title, items, tax_rate, status, notes, created_at) VALUES (?,?,?,?,?,?,?)",
        (
            customer,
            title,
            json.dumps(data.get("items", [])),
            data.get("tax_rate", 0) or 0,
            status,
            data.get("notes", ""),
            datetime.now().isoformat(),
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM quotes WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/quotes/<int:quote_id>", methods=["PATCH"])
def update_quote(quote_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM quotes WHERE id = ?", (quote_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    if "status" in data and data["status"] not in QUOTE_STATUSES:
        return jsonify({"error": f"status must be one of {QUOTE_STATUSES}"}), 400
    fields = {}
    for key in ["customer", "title", "tax_rate", "status", "notes"]:
        if key in data:
            fields[key] = data[key]
    if "items" in data:
        fields["items"] = json.dumps(data["items"])
    if fields:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        db.execute(f"UPDATE quotes SET {set_clause} WHERE id = ?", (*fields.values(), quote_id))
        db.commit()
    row = db.execute("SELECT * FROM quotes WHERE id = ?", (quote_id,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/quotes/<int:quote_id>", methods=["DELETE"])
def delete_quote(quote_id):
    db = get_db()
    db.execute("DELETE FROM quotes WHERE id = ?", (quote_id,))
    db.commit()
    return "", 204


# ======================================================================
# CSV export / import
# ======================================================================

JOB_CSV_COLS = ["id", "customer", "job_name", "stage", "substrate", "assigned_to",
                "priority", "on_hold", "due_date", "install_date", "install_location",
                "notes", "created_at", "stage_changed_at", "completed_at"]


def csv_response(text, filename):
    return Response(
        text,
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.route("/api/export/jobs.csv", methods=["GET"])
def export_jobs_csv():
    db = get_db()
    rows = db.execute("SELECT * FROM jobs ORDER BY id ASC").fetchall()
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(JOB_CSV_COLS)
    for r in rows:
        d = dict(r)
        writer.writerow([d.get(c, "") for c in JOB_CSV_COLS])
    return csv_response(out.getvalue(), "jobs.csv")


@app.route("/api/import/jobs", methods=["POST"])
@app.route("/api/import/jobs.csv", methods=["POST"])
def import_jobs():
    """Upload a CSV or ICS calendar file to sync with the board.
    CSV: rows with an id matching an existing job update that job; rows
    without an id (or with an unknown id) create new jobs.
    ICS: each VEVENT becomes a job (matched to an existing open job by
    customer + job name so re-importing the same calendar won't duplicate)."""
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "no file provided"}), 400
    try:
        text = file.read().decode("utf-8-sig")
    except UnicodeDecodeError:
        return jsonify({"error": "file must be UTF-8 encoded (CSV or ICS)"}), 400

    # Snapshot before touching the board, so any import can be rolled back.
    try:
        make_backup("pre-import")
    except Exception:
        pass

    fname = (file.filename or "").lower()
    if fname.endswith(".ics") or text.lstrip().upper().startswith("BEGIN:VCALENDAR"):
        return import_jobs_ics(text)
    return import_jobs_csv_text(text)


def import_jobs_csv_text(text):
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        return jsonify({"error": "empty or invalid CSV"}), 400
    headers = {h.strip().lower(): h for h in reader.fieldnames}
    if "customer" not in headers or ("job_name" not in headers and "job name" not in headers):
        return jsonify({"error": "CSV must include 'customer' and 'job_name' columns"}), 400

    def val(row, *names):
        for n in names:
            if n in headers:
                v = (row.get(headers[n]) or "").strip()
                if v:
                    return v
        return ""

    db = get_db()
    now = datetime.now().isoformat()
    created = updated = skipped = 0
    errors = []

    for i, row in enumerate(reader, start=2):
        customer = val(row, "customer")
        job_name = val(row, "job_name", "job name")
        if not customer or not job_name:
            skipped += 1
            errors.append(f"Row {i}: missing customer or job_name")
            continue

        stage = val(row, "stage").lower() or "design"
        if stage not in STAGES:
            errors.append(f"Row {i}: unknown stage '{stage}', defaulted to design")
            stage = "design"
        substrate = val(row, "substrate").lower()
        if substrate and substrate not in SUBSTRATES:
            substrate = "other"
        on_hold = 1 if val(row, "on_hold").lower() in ("1", "true", "yes", "y") else 0
        priority = val(row, "priority").lower()
        if priority not in ("low", "medium", "high"):
            priority = "medium"

        fields = {
            "customer": customer,
            "job_name": job_name,
            "stage": stage,
            "substrate": substrate,
            "assigned_to": val(row, "assigned_to", "assigned to", "assignee"),
            "priority": priority,
            "on_hold": on_hold,
            "due_date": val(row, "due_date", "due") or None,
            "install_date": val(row, "install_date", "install") or None,
            "install_location": val(row, "install_location", "location"),
            "notes": val(row, "notes"),
        }

        job_id = val(row, "id")
        existing = None
        if job_id.isdigit():
            existing = db.execute("SELECT * FROM jobs WHERE id = ?", (int(job_id),)).fetchone()

        if existing:
            if stage != existing["stage"]:
                fields["stage_changed_at"] = now
                fields["completed_at"] = now if stage == "complete" else None
                log_event(db, existing["id"], "stage", f"{existing['stage']} → {stage} (CSV import)")
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            db.execute(f"UPDATE jobs SET {set_clause} WHERE id = ?", (*fields.values(), existing["id"]))
            updated += 1
        else:
            cur = db.execute(
                "INSERT INTO jobs (customer, job_name, stage, substrate, assigned_to, priority, on_hold, due_date, install_date, install_location, notes, created_at, completed_at, stage_changed_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (fields["customer"], fields["job_name"], fields["stage"], fields["substrate"],
                 fields["assigned_to"], fields["priority"], fields["on_hold"], fields["due_date"],
                 fields["install_date"], fields["install_location"], fields["notes"],
                 now, now if stage == "complete" else None, now),
            )
            log_event(db, cur.lastrowid, "created", "Created via CSV import")
            created += 1

    db.commit()
    return jsonify({"created": created, "updated": updated, "skipped": skipped, "errors": errors[:20]})


# --- ICS (calendar) import ---

def _ics_unescape(v):
    return (v.replace("\\n", "\n").replace("\\N", "\n")
             .replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\"))


def _ics_date(v):
    m = re.match(r"(\d{4})(\d{2})(\d{2})", v or "")
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None


def parse_ics(text):
    """Minimal, dependency-free VEVENT parser (handles folded lines)."""
    lines = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    events, cur = [], None
    for line in lines:
        upper = line.strip().upper()
        if upper == "BEGIN:VEVENT":
            cur = {}
        elif upper == "END:VEVENT":
            if cur is not None:
                events.append(cur)
            cur = None
        elif cur is not None and ":" in line:
            key, val = line.split(":", 1)
            key = key.split(";", 1)[0].upper()  # drop params like DTSTART;VALUE=DATE
            cur[key] = _ics_unescape(val.strip())
    return events


def import_jobs_ics(text):
    events = parse_ics(text)
    if not events:
        return jsonify({"error": "no calendar events (VEVENT) found in this file"}), 400

    db = get_db()
    now = datetime.now().isoformat()
    created = updated = skipped = 0
    errors = []

    for i, ev in enumerate(events, start=1):
        summary = (ev.get("SUMMARY") or "").strip()
        if not summary:
            skipped += 1
            errors.append(f"Event {i}: no title (SUMMARY), skipped")
            continue

        # "Customer - Job name" in the event title splits into both fields;
        # otherwise the whole title becomes the job name.
        if " - " in summary:
            customer, job_name = (p.strip() for p in summary.split(" - ", 1))
        else:
            customer, job_name = "Calendar import", summary

        due = _ics_date(ev.get("DTSTART"))
        location = (ev.get("LOCATION") or "").strip()
        desc = (ev.get("DESCRIPTION") or "").strip()

        existing = db.execute(
            "SELECT * FROM jobs WHERE lower(customer) = lower(?) AND lower(job_name) = lower(?) "
            "AND stage != 'complete'",
            (customer, job_name),
        ).fetchone()

        if existing:
            fields = {"due_date": due or existing["due_date"]}
            if location and not existing["install_location"]:
                fields["install_location"] = location
            if desc and not existing["notes"]:
                fields["notes"] = desc
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            db.execute(f"UPDATE jobs SET {set_clause} WHERE id = ?", (*fields.values(), existing["id"]))
            log_event(db, existing["id"], "stage", "Updated via calendar (.ics) import")
            updated += 1
        else:
            cur = db.execute(
                "INSERT INTO jobs (customer, job_name, stage, due_date, install_location, priority, notes, created_at, stage_changed_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (customer, job_name, "design", due, location, "medium", desc, now, now),
            )
            log_event(db, cur.lastrowid, "created", "Created via calendar (.ics) import")
            created += 1

    db.commit()
    return jsonify({"created": created, "updated": updated, "skipped": skipped, "errors": errors[:20]})


@app.route("/api/export/materials.csv", methods=["GET"])
def export_materials_csv():
    db = get_db()
    rows = db.execute("SELECT * FROM materials ORDER BY name ASC").fetchall()
    out = io.StringIO()
    writer = csv.writer(out)
    cols = ["id", "name", "sku", "vendor", "category", "on_hand", "unit",
            "reorder_at", "cost", "location", "product_url", "notes"]
    writer.writerow(cols)
    for r in rows:
        d = dict(r)
        writer.writerow([d.get(c, "") for c in cols])
    return csv_response(out.getvalue(), "materials.csv")


@app.route("/api/import/materials.csv", methods=["POST"])
def import_materials_csv():
    """Upsert materials by name: existing names update stock, new names are added."""
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "no file provided"}), 400
    try:
        text = file.read().decode("utf-8-sig")
    except UnicodeDecodeError:
        return jsonify({"error": "file must be UTF-8 encoded CSV"}), 400

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        return jsonify({"error": "empty or invalid CSV"}), 400
    headers = {h.strip().lower(): h for h in reader.fieldnames}
    if "name" not in headers:
        return jsonify({"error": "CSV must include a 'name' column"}), 400

    def val(row, name, default=""):
        if name in headers:
            return (row.get(headers[name]) or "").strip() or default
        return default

    def fnum(v, default=0):
        try:
            return float(v)
        except (TypeError, ValueError):
            return default

    db = get_db()
    created = updated = skipped = 0
    for row in reader:
        name = val(row, "name")
        if not name:
            skipped += 1
            continue
        on_hand = max(0, fnum(val(row, "on_hand")))
        unit = val(row, "unit", "sheets")
        reorder_at = max(0, fnum(val(row, "reorder_at")))
        notes = val(row, "notes")
        sku = val(row, "sku") or val(row, "product code") or val(row, "product_code") or val(row, "item #") or val(row, "item number")
        vendor = val(row, "vendor") or val(row, "supplier") or val(row, "distributor")
        cost = max(0, fnum(val(row, "cost") or val(row, "price") or val(row, "unit cost")))
        product_url = val(row, "product_url") or val(row, "url") or val(row, "link")
        category = val(row, "category")
        location = val(row, "location") or val(row, "bin")
        # Match by SKU first (more reliable than names), then by name.
        existing = None
        if sku:
            existing = db.execute("SELECT id FROM materials WHERE sku != '' AND lower(sku) = lower(?)", (sku,)).fetchone()
        if not existing:
            existing = db.execute("SELECT id FROM materials WHERE lower(name) = lower(?)", (name,)).fetchone()
        if existing:
            db.execute(
                "UPDATE materials SET name = ?, on_hand = ?, unit = ?, reorder_at = ?, notes = ?, "
                "sku = ?, vendor = ?, cost = ?, product_url = ?, category = ?, location = ? WHERE id = ?",
                (name, on_hand, unit, reorder_at, notes, sku, vendor, cost, product_url,
                 category, location, existing["id"]))
            updated += 1
        else:
            db.execute(
                "INSERT INTO materials (name, on_hand, unit, reorder_at, notes, sku, vendor, cost, product_url, category, location) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (name, on_hand, unit, reorder_at, notes, sku, vendor, cost, product_url, category, location))
            created += 1
    db.commit()
    return jsonify({"created": created, "updated": updated, "skipped": skipped})


@app.route("/api/export/history.csv", methods=["GET"])
def export_history_csv():
    db = get_db()
    jobs = db.execute("SELECT * FROM jobs WHERE stage = 'complete' ORDER BY completed_at DESC").fetchall()
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["id", "customer", "job_name", "substrate", "assigned_to", "priority",
                     "install_location", "due_date", "install_date", "created_at", "completed_at",
                     "turnaround_days", "total_sqft", "materials_used", "notes"])
    for j in jobs:
        mats = db.execute("SELECT * FROM job_materials WHERE job_id = ?", (j["id"],)).fetchall()
        total_sqft = sum((m["sqft"] or 0) for m in mats)
        mat_summary = "; ".join(f"{m['qty']} {m['unit']} {m['material_name']}" for m in mats)
        turnaround = ""
        if j["completed_at"] and j["created_at"]:
            try:
                delta = datetime.fromisoformat(j["completed_at"]) - datetime.fromisoformat(j["created_at"])
                turnaround = max(0, round(delta.total_seconds() / 86400, 1))
            except ValueError:
                pass
        writer.writerow([j["id"], j["customer"], j["job_name"], j["substrate"], j["assigned_to"],
                         j["priority"], j["install_location"], j["due_date"], j["install_date"],
                         j["created_at"], j["completed_at"], turnaround, total_sqft, mat_summary,
                         j["notes"]])
    return csv_response(out.getvalue(), "job_history.csv")


@app.route("/api/export/material-usage.csv", methods=["GET"])
def export_material_usage_csv():
    db = get_db()
    rows = db.execute(
        "SELECT jm.*, j.job_name, j.customer FROM job_materials jm "
        "LEFT JOIN jobs j ON j.id = jm.job_id ORDER BY jm.created_at DESC"
    ).fetchall()
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["id", "job_id", "job_name", "customer", "material_name", "qty", "unit", "sqft", "notes", "created_at"])
    for r in rows:
        writer.writerow([r["id"], r["job_id"], r["job_name"], r["customer"], r["material_name"],
                         r["qty"], r["unit"], r["sqft"], r["notes"], r["created_at"]])
    return csv_response(out.getvalue(), "material_usage.csv")


# ======================================================================
# Materials inventory
# ======================================================================

@app.route("/api/materials", methods=["GET"])
def get_materials():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM materials ORDER BY "
        "CASE WHEN reorder_at > 0 AND on_hand <= reorder_at THEN 0 ELSE 1 END ASC, "
        "name ASC"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/materials", methods=["POST"])
def create_material():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO materials (name, on_hand, unit, reorder_at, notes, sku, vendor, cost, product_url, category, location) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (
            name,
            data.get("on_hand", 0),
            data.get("unit", "sheets"),
            data.get("reorder_at", 0),
            data.get("notes", ""),
            (data.get("sku") or "").strip(),
            (data.get("vendor") or "").strip(),
            data.get("cost", 0) or 0,
            (data.get("product_url") or "").strip(),
            (data.get("category") or "").strip(),
            (data.get("location") or "").strip(),
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM materials WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/materials/<int:mat_id>", methods=["PATCH"])
def update_material(mat_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM materials WHERE id = ?", (mat_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    fields = {}
    for key in ["name", "on_hand", "unit", "reorder_at", "notes",
                "sku", "vendor", "cost", "product_url", "category", "location"]:
        if key in data:
            fields[key] = data[key]
    if "on_hand" in fields:
        fields["on_hand"] = max(0, fields["on_hand"] or 0)
    if fields:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        db.execute(f"UPDATE materials SET {set_clause} WHERE id = ?", (*fields.values(), mat_id))
        db.commit()
    row = db.execute("SELECT * FROM materials WHERE id = ?", (mat_id,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/materials/<int:mat_id>", methods=["DELETE"])
def delete_material(mat_id):
    db = get_db()
    db.execute("DELETE FROM materials WHERE id = ?", (mat_id,))
    db.commit()
    return "", 204


# ======================================================================
# Notes
# ======================================================================

@app.route("/api/notes", methods=["GET"])
def get_notes():
    db = get_db()
    rows = db.execute("SELECT * FROM notes ORDER BY resolved ASC, created_at DESC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/notes", methods=["POST"])
def create_note():
    data = request.get_json(force=True)
    content = (data.get("content") or "").strip()
    if not content:
        return jsonify({"error": "content is required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO notes (content, resolved, created_at) VALUES (?,0,?)",
        (content, datetime.now().isoformat()),
    )
    db.commit()
    row = db.execute("SELECT * FROM notes WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/notes/<int:note_id>", methods=["PATCH"])
def update_note(note_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    fields = {}
    for key in ["content", "resolved"]:
        if key in data:
            fields[key] = data[key]
    if fields:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        db.execute(f"UPDATE notes SET {set_clause} WHERE id = ?", (*fields.values(), note_id))
        db.commit()
    row = db.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/notes/<int:note_id>", methods=["DELETE"])
def delete_note(note_id):
    db = get_db()
    db.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    db.commit()
    return "", 204



# ======================================================================
# Material lookup — paste a product URL, get name/SKU/cost autofilled.
# Tries JSON-LD and meta tags first; storefronts that render everything
# in JavaScript (like grimco.com) fall back to parsing the URL slug.
# ======================================================================

@app.route("/api/materials/lookup", methods=["GET"])
def material_lookup():
    url = (request.args.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        return jsonify({"error": "invalid url"}), 400

    parsed = urllib.parse.urlparse(url)
    out = {"name": "", "sku": "", "vendor": "", "cost": 0, "source": "slug"}
    if "grimco" in parsed.netloc.lower():
        out["vendor"] = "Grimco"

    # Fallback first: build a readable name from the last URL segment.
    seg = urllib.parse.unquote(parsed.path.rstrip("/").split("/")[-1])
    if seg and not seg.isdigit():
        out["name"] = re.sub(r"[-_+]+", " ", seg).strip().title()
    # Trailing product ids like ".../vinyl-roll/12345" make a better SKU.
    parts = parsed.path.rstrip("/").split("/")
    if len(parts) >= 2 and parts[-1].isdigit():
        out["sku"] = parts[-1]
        seg2 = urllib.parse.unquote(parts[-2])
        if seg2:
            out["name"] = re.sub(r"[-_+]+", " ", seg2).strip().title()

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (sign-shop dashboard)"})
        html = urllib.request.urlopen(req, timeout=8).read(500000).decode("utf-8", "ignore")

        # JSON-LD Product blocks (most reliable when present)
        for m in re.finditer(r"<script[^>]*ld\+json[^>]*>(.*?)</script>", html, re.S | re.I):
            try:
                data = json.loads(m.group(1).strip())
            except ValueError:
                continue
            for o in (data if isinstance(data, list) else [data]):
                if isinstance(o, dict) and str(o.get("@type", "")).lower() == "product":
                    out["name"] = (o.get("name") or out["name"] or "").strip()
                    out["sku"] = str(o.get("sku") or o.get("mpn") or out["sku"] or "").strip()
                    offers = o.get("offers") or {}
                    if isinstance(offers, list):
                        offers = offers[0] if offers else {}
                    try:
                        out["cost"] = float(offers.get("price") or 0)
                    except (TypeError, ValueError):
                        pass
                    out["source"] = "jsonld"

        # og:title / <title> as a name upgrade over the slug
        if out["source"] != "jsonld":
            m = (re.search(r"<meta[^>]+property=[\"']og:title[\"'][^>]+content=[\"']([^\"']+)", html, re.I)
                 or re.search(r"<title[^>]*>([^<]+)</title>", html, re.I))
            if m:
                title = m.group(1).strip().strip("|").strip()
                # ignore useless generic shells like "Grimco |"
                if title and title.lower() not in ("grimco", "grimco |") and len(title) > 3:
                    out["name"] = title
                    out["source"] = "meta"
            if not out["sku"]:
                m = re.search(r"(?:Item|SKU|Part)\s*#?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\.]{2,20})", html)
                if m:
                    out["sku"] = m.group(1)
    except Exception:
        pass  # slug fallback already filled what it could

    return jsonify(out)


# ======================================================================
# Industry news (RSS proxy — the browser can't fetch these cross-origin)
# ======================================================================

import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET

NEWS_FEEDS = [
    {"source": "Signs of the Times", "url": "https://signsofthetimes.com/feed/",
     "home": "https://signsofthetimes.com/"},
    {"source": "Signs101 forum", "url": "https://www.signs101.com/forums/-/index.rss",
     "home": "https://www.signs101.com/"},
]
NEWS_CACHE = {"at": None, "items": []}
NEWS_TTL_SECONDS = 3600


def fetch_feed(feed):
    req = urllib.request.Request(
        feed["url"],
        headers={"User-Agent": "Mozilla/5.0 (sign-shop dashboard RSS reader)"},
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        raw = resp.read()
    root = ET.fromstring(raw)
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    items = []
    # RSS 2.0
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub = (item.findtext("pubDate") or "").strip()
        if title and link:
            items.append({"source": feed["source"], "title": title, "link": link, "date": pub})
    # Atom fallback
    if not items:
        for entry in root.iter("{http://www.w3.org/2005/Atom}entry"):
            title = (entry.findtext("atom:title", namespaces=ns) or "").strip()
            link_el = entry.find("atom:link", ns)
            link = link_el.get("href") if link_el is not None else ""
            pub = (entry.findtext("atom:updated", namespaces=ns) or "").strip()
            if title and link:
                items.append({"source": feed["source"], "title": title, "link": link, "date": pub})
    return items[:8]


@app.route("/api/news", methods=["GET"])
def get_news():
    now = datetime.now()
    if NEWS_CACHE["at"] and (now - NEWS_CACHE["at"]).total_seconds() < NEWS_TTL_SECONDS:
        return jsonify({"items": NEWS_CACHE["items"], "cached": True})
    items = []
    for feed in NEWS_FEEDS:
        try:
            items.extend(fetch_feed(feed))
        except Exception:
            pass  # a dead feed never breaks the dashboard
    NEWS_CACHE["at"] = now
    NEWS_CACHE["items"] = items
    return jsonify({"items": items, "cached": False})


# ======================================================================
# Backups (rollback safety net)
# ======================================================================
# Every snapshot is a plain .zip of the whole app — database, config,
# uploads, and the code itself (app.py, templates, static). Restoring a
# snapshot rolls all of it back, so "go back to before my last change"
# is always possible. Snapshots are taken automatically on startup and
# before every import or restore, and can be made manually from Settings.

SKIP_DIRS = {"backups", "__pycache__", ".git"}


def make_backup(label=""):
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", label or "").strip("-")[:40]
    name = f"backup-{stamp}{('-' + safe) if safe else ''}.zip"
    path = os.path.join(BACKUP_DIR, name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(BASE_DIR):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for fname in files:
                fp = os.path.join(root, fname)
                rel = os.path.relpath(fp, BASE_DIR)
                try:
                    z.write(fp, rel)
                except OSError:
                    pass  # locked/transient file; skip rather than fail the snapshot
    prune_backups()
    return name


def prune_backups():
    if not os.path.isdir(BACKUP_DIR):
        return
    zips = sorted(
        (f for f in os.listdir(BACKUP_DIR) if f.endswith(".zip")),
        reverse=True,
    )
    for old in zips[BACKUP_KEEP:]:
        try:
            os.remove(os.path.join(BACKUP_DIR, old))
        except OSError:
            pass


def valid_backup_name(name):
    return bool(re.fullmatch(r"backup-[0-9]{8}-[0-9]{6}(-[A-Za-z0-9_-]+)?\.zip", name or ""))


@app.route("/api/backups", methods=["GET"])
def list_backups():
    out = []
    if os.path.isdir(BACKUP_DIR):
        for f in sorted(os.listdir(BACKUP_DIR), reverse=True):
            if not f.endswith(".zip"):
                continue
            fp = os.path.join(BACKUP_DIR, f)
            out.append({"name": f, "size": os.path.getsize(fp),
                        "created_at": datetime.fromtimestamp(os.path.getmtime(fp)).isoformat()})
    return jsonify(out)


@app.route("/api/backups", methods=["POST"])
def create_backup():
    data = request.get_json(silent=True) or {}
    name = make_backup(data.get("label", "manual"))
    return jsonify({"name": name}), 201


@app.route("/api/backups/<name>/restore", methods=["POST"])
def restore_backup(name):
    if not valid_backup_name(name):
        return jsonify({"error": "invalid backup name"}), 400
    path = os.path.join(BACKUP_DIR, name)
    if not os.path.exists(path):
        return jsonify({"error": "backup not found"}), 404

    # Safety net for the safety net: snapshot the current state first,
    # so a restore can itself be undone.
    make_backup("pre-restore")

    code_changed = False
    errors = []
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            rel = info.filename.replace("\\", "/")
            # Never allow paths that escape the app folder.
            if rel.startswith("/") or ".." in rel.split("/"):
                continue
            dest = os.path.join(BASE_DIR, *rel.split("/"))
            if info.is_dir():
                os.makedirs(dest, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            try:
                with z.open(info) as src, open(dest, "wb") as dst:
                    dst.write(src.read())
                if rel.endswith((".py", ".js", ".css", ".html")):
                    code_changed = True
            except OSError as e:
                errors.append(f"{rel}: {e}")

    msg = "Backup restored."
    if code_changed:
        msg += " Code files were rolled back too — restart the server to pick them up."
    return jsonify({"ok": True, "message": msg, "errors": errors[:10]})


@app.route("/api/backups/<name>/download", methods=["GET"])
def download_backup(name):
    if not valid_backup_name(name):
        return jsonify({"error": "invalid backup name"}), 400
    return send_from_directory(BACKUP_DIR, name, as_attachment=True)



# ======================================================================
# Daily email overview (Gmail SMTP with an app password)
# ======================================================================

def build_digest(db):
    today = datetime.now().date().isoformat()
    jobs = [dict(r) for r in db.execute("SELECT * FROM jobs WHERE stage != 'complete'").fetchall()]
    overdue = sorted((j for j in jobs if j["due_date"] and j["due_date"] < today), key=lambda j: j["due_date"])
    due = [j for j in jobs if j["due_date"] == today]
    installs = [j for j in jobs if j["install_date"] == today]
    hold = [j for j in jobs if j["on_hold"]]
    low = [dict(r) for r in db.execute(
        "SELECT * FROM materials WHERE reorder_at > 0 AND on_hand <= reorder_at").fetchall()]
    tasks = [dict(r) for r in db.execute(
        "SELECT * FROM tasks WHERE completed = 0 AND job_id IS NULL AND due_date IS NOT NULL AND due_date <= ?",
        (today,)).fetchall()]

    def jline(j):
        bits = [f"WO-{j['id']:04d}", j["customer"], "—", j["job_name"], f"[{j['stage']}]"]
        if j["due_date"]:
            bits.append(f"due {j['due_date']}")
        if j["install_location"]:
            bits.append(f"@ {j['install_location']}")
        return "  • " + " ".join(str(b) for b in bits)

    lines = [f"Shop overview — {today}", ""]
    if overdue:
        lines += [f"OVERDUE ({len(overdue)}):"] + [jline(j) for j in overdue] + [""]
    if due:
        lines += [f"Due today ({len(due)}):"] + [jline(j) for j in due] + [""]
    if installs:
        lines += [f"Installs today ({len(installs)}):"] + [jline(j) for j in installs] + [""]
    if hold:
        lines += [f"On hold ({len(hold)}):"] + [jline(j) for j in hold] + [""]
    if tasks:
        lines += [f"Shop tasks due ({len(tasks)}):"] + [f"  • {t['title']} (due {t['due_date']})" for t in tasks] + [""]
    if low:
        lines += [f"Low stock ({len(low)}):"] + [
            f"  • {m['name']}: {m['on_hand']} {m['unit']} left (reorder at {m['reorder_at']})"
            + (f" — #{m['sku']}" if m.get("sku") else "") for m in low] + [""]
    if len(lines) == 2:
        lines.append("Nothing overdue, due, or installing today. Stock levels healthy.")
    lines += ["", f"Open jobs total: {len(jobs)}"]
    return "\n".join(lines)


def send_email(cfg, to, subject, body, attach_path=None, attach_name=None):
    user = (cfg.get("smtp_user") or "").strip()
    pw = (cfg.get("smtp_app_password") or "").strip()
    if not user or not pw or not to:
        raise RuntimeError("Set Gmail address and app password in Settings first")
    if attach_path:
        msg = MIMEMultipart()
        msg.attach(MIMEText(body))
        with open(attach_path, "rb") as f:
            part = MIMEApplication(f.read())
        part.add_header("Content-Disposition", "attachment",
                        filename=attach_name or os.path.basename(attach_path))
        msg.attach(part)
    else:
        msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = user
    msg["To"] = to
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as s:
        s.login(user, pw)
        s.sendmail(user, [to], msg.as_string())
    return to


def send_digest(db, cfg):
    to = (cfg.get("digest_to") or "").strip() or (cfg.get("smtp_user") or "").strip()
    return send_email(cfg, to, f"Shop overview — {datetime.now().date().isoformat()}",
                      build_digest(db))


@app.route("/api/digest/test", methods=["POST"])
def digest_test():
    try:
        to = send_digest(get_db(), load_config())
        return jsonify({"ok": True, "message": f"Overview sent to {to}."})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


def digest_loop():
    """Background thread: daily email at the set hour + nightly snapshot."""
    last_sent = None
    last_snap = None
    while True:
        try:
            cfg = load_config()
            now = datetime.now()
            # Nightly snapshot shortly after midnight — runs whether or not
            # the server was restarted that day.
            if now.hour == 0 and last_snap != now.date():
                make_backup("nightly")
                last_snap = now.date()
            if (cfg.get("digest_enabled") and now.hour == int(cfg.get("digest_hour", 7) or 7)
                    and last_sent != now.date()):
                conn = sqlite3.connect(DB_PATH)
                conn.row_factory = sqlite3.Row
                try:
                    send_digest(conn, cfg)
                    last_sent = now.date()
                finally:
                    conn.close()
        except Exception:
            pass  # never let the mailer kill the app
        time.sleep(300)



# ======================================================================
# Shop features: reorder email, customer proof approval, stage analytics,
# quote -> job conversion
# ======================================================================

@app.route("/api/reorder/email", methods=["POST"])
def reorder_email():
    """Email the low-stock reorder list (SKUs, vendors, quantities) to you."""
    db = get_db()
    cfg = load_config()
    low = [dict(r) for r in db.execute(
        "SELECT * FROM materials WHERE reorder_at > 0 AND on_hand <= reorder_at ORDER BY vendor, name").fetchall()]
    if not low:
        return jsonify({"error": "Nothing is at or below its reorder point."}), 400
    lines = [f"Reorder list — {datetime.now().date().isoformat()}", ""]
    vendor = None
    for m in low:
        v = m.get("vendor") or "No vendor set"
        if v != vendor:
            lines.append(f"{v}:")
            vendor = v
        want = max(0, (m["reorder_at"] or 0) * 2 - (m["on_hand"] or 0))
        lines.append(f"  • {m['name']}"
                     + (f"  [#{m['sku']}]" if m.get("sku") else "")
                     + f" — {m['on_hand']} {m['unit']} left, reorder ~{want:g} {m['unit']}"
                     + (f" (~${want * m['cost']:.2f})" if m.get("cost") else ""))
        if m.get("product_url"):
            lines.append(f"    {m['product_url']}")
    try:
        to = send_email(cfg, (cfg.get("digest_to") or "").strip() or cfg.get("smtp_user", ""),
                        f"Reorder list — {len(low)} item{'s' if len(low) != 1 else ''}",
                        "\n".join(lines))
        return jsonify({"ok": True, "message": f"Reorder list ({len(low)} items) sent to {to}."})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/files/<int:file_id>/send-proof", methods=["POST"])
def send_proof(file_id):
    """Email a proof to the customer with an approve/decline link."""
    data = request.get_json(force=True)
    to = (data.get("to") or "").strip()
    if not to:
        return jsonify({"error": "customer email is required"}), 400
    db = get_db()
    f = db.execute("SELECT * FROM job_files WHERE id = ?", (file_id,)).fetchone()
    if not f:
        return jsonify({"error": "file not found"}), 404
    job = db.execute("SELECT * FROM jobs WHERE id = ?", (f["job_id"],)).fetchone()
    token = f["approve_token"] or uuid.uuid4().hex
    db.execute("UPDATE job_files SET approve_token = ? WHERE id = ?", (token, file_id))
    link = request.host_url.rstrip("/") + "/proof/" + token
    body = (f"Hi,\n\nHere is the proof for your sign project"
            f"{' — ' + job['job_name'] if job else ''}.\n\n"
            f"Review and approve (or request changes) here:\n{link}\n\n"
            f"The proof is also attached to this email.\n\nThank you!")
    try:
        cfg = load_config()
        send_email(cfg, to, f"Proof for approval — {job['job_name'] if job else 'your sign'}",
                   body, attach_path=os.path.join(UPLOAD_DIR, f["stored_name"]),
                   attach_name=f["orig_name"])
        log_event(db, f["job_id"], "file", f"Proof emailed to {to}")
        db.commit()
        return jsonify({"ok": True, "message": f"Proof sent to {to}.", "link": link})
    except Exception as e:
        db.commit()  # keep the token even if mail failed, link still shareable
        return jsonify({"error": str(e), "link": link}), 400


@app.route("/proof/<token>", methods=["GET", "POST"])
def public_proof(token):
    """Tiny public page a customer can open from the proof email.
    NOTE: reachable by anyone with the link — the token is the security."""
    if not re.fullmatch(r"[0-9a-f]{32}", token or ""):
        return "Not found", 404
    db = get_db()
    f = db.execute("SELECT * FROM job_files WHERE approve_token = ?", (token,)).fetchone()
    if not f:
        return "This proof link is no longer valid.", 404
    job = db.execute("SELECT * FROM jobs WHERE id = ?", (f["job_id"],)).fetchone()
    msg = ""
    if request.method == "POST":
        decision = request.form.get("decision")
        if decision in ("approve", "changes"):
            approved = 1 if decision == "approve" else 0
            db.execute("UPDATE job_files SET approved = ? WHERE id = ?", (approved, f["id"]))
            note = (request.form.get("note") or "").strip()[:500]
            log_event(db, f["job_id"], "file",
                      ("Customer APPROVED proof" if approved else "Customer requested changes")
                      + (f": {note}" if note else "") + f" ({f['orig_name']})")
            db.commit()
            msg = ("Thank you! Your approval has been recorded." if approved
                   else "Got it — we'll make changes and send a new proof.")
    ext = (f["orig_name"].rsplit(".", 1)[-1] or "").lower()
    is_img = ext in ("png", "jpg", "jpeg", "gif", "webp", "bmp", "svg")
    file_url = "/files/" + f["stored_name"]
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proof approval</title>
<style>body{{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#101828}}
img{{max-width:100%;border:1px solid #ddd;border-radius:10px}}
.btn{{display:inline-block;padding:12px 26px;border-radius:999px;border:none;font-size:15px;font-weight:600;cursor:pointer;margin-right:10px}}
.ok{{background:#059669;color:#fff}}.no{{background:#eee;color:#333}}
textarea{{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;margin:10px 0;font:inherit}}
.msg{{background:#e7f6f0;border:1px solid #059669;padding:14px;border-radius:10px;margin:16px 0}}</style></head><body>
<h2>Proof for: {job["job_name"] if job else "your sign"}</h2>
<p>Customer: {job["customer"] if job else ""}</p>
{f'<div class="msg">{msg}</div>' if msg else ''}
{f'<p><img src="{file_url}" alt="proof"></p>' if is_img else f'<p><a href="{file_url}">Open the proof file</a></p>'}
<p>Status: <strong>{"✔ Approved" if f["approved"] else "Awaiting your approval"}</strong></p>
<form method="post">
<textarea name="note" rows="2" placeholder="Optional note (colors, sizes, changes...)"></textarea><br>
<button class="btn ok" name="decision" value="approve">Approve this proof</button>
<button class="btn no" name="decision" value="changes">Request changes</button>
</form></body></html>"""


@app.route("/api/analytics/stages", methods=["GET"])
def stage_analytics():
    """Average time jobs spend in each stage, from the event history."""
    db = get_db()
    events = db.execute(
        "SELECT job_id, detail, created_at FROM job_events WHERE event IN ('created','stage') ORDER BY job_id, created_at"
    ).fetchall()
    jobs_created = {r["id"]: r["created_at"] for r in db.execute("SELECT id, created_at FROM jobs").fetchall()}
    durations = {}  # stage -> [days,...]
    by_job = {}
    for ev in events:
        by_job.setdefault(ev["job_id"], []).append(ev)
    for jid, evs in by_job.items():
        cur_stage, cur_start = "design", jobs_created.get(jid)
        for ev in evs:
            d = ev["detail"] or ""
            if "→" not in d:
                continue
            frm, to = [p.strip().split(" ")[0] for p in d.split("→", 1)]
            if cur_start:
                try:
                    days = (datetime.fromisoformat(ev["created_at"]) - datetime.fromisoformat(cur_start)).total_seconds() / 86400
                    if 0 <= days < 365:
                        durations.setdefault(frm if frm in STAGES else cur_stage, []).append(days)
                except ValueError:
                    pass
            cur_stage, cur_start = to, ev["created_at"]
    out = []
    for s in STAGES[:-1]:
        vals = durations.get(s, [])
        out.append({"stage": s, "avg_days": round(sum(vals) / len(vals), 1) if vals else None,
                    "samples": len(vals)})
    return jsonify(out)


@app.route("/api/quotes/<int:quote_id>/convert", methods=["POST"])
def convert_quote(quote_id):
    """Accepted quote becomes a job at the Design stage."""
    db = get_db()
    q = db.execute("SELECT * FROM quotes WHERE id = ?", (quote_id,)).fetchone()
    if not q:
        return jsonify({"error": "not found"}), 404
    try:
        items = json.loads(q["items"] or "[]")
    except ValueError:
        items = []
    summary = "; ".join(f"{i.get('qty', 1)}x {i.get('desc', '')}" for i in items if i.get("desc"))
    now = datetime.now().isoformat()
    cur = db.execute(
        "INSERT INTO jobs (customer, job_name, stage, priority, notes, created_at, stage_changed_at) VALUES (?,?,?,?,?,?,?)",
        (q["customer"], q["title"], "design", "medium",
         ("From quote: " + summary) if summary else "Created from quote", now, now))
    db.execute("UPDATE quotes SET status = 'accepted', job_id = ? WHERE id = ?", (cur.lastrowid, quote_id))
    log_event(db, cur.lastrowid, "created", f"Created from accepted quote #{quote_id}")
    db.commit()
    return jsonify({"job_id": cur.lastrowid}), 201


# ======================================================================
# Settings
# ======================================================================

@app.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify(load_config())


@app.route("/api/settings", methods=["PUT"])
def update_settings():
    data = request.get_json(force=True)
    cfg = load_config()
    cfg.update({k: v for k, v in data.items() if k in DEFAULT_CONFIG})
    save_config(cfg)
    return jsonify(cfg)


if __name__ == "__main__":
    init_db()
    load_config()
    # Automatic snapshot on every startup — cheap insurance.
    try:
        make_backup("startup")
    except Exception:
        pass
    # debug=False by default since this is meant to run continuously on a
    # self-hosted box. Set FLASK_DEBUG=1 in your shell if you want the
    # auto-reloader while making changes.
    threading.Thread(target=digest_loop, daemon=True).start()
    debug_mode = os.environ.get("FLASK_DEBUG") == "1"
    app.run(host="0.0.0.0", port=5000, debug=debug_mode)
