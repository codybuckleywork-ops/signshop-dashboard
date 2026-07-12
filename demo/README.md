# Public demo of the sign-shop dashboard

This folder turns the real dashboard into a **live, click-around demo** you can
link from your website — without exposing your production data.

`demo.py` imports the actual app (`SignshopDashboard.py`) unchanged, then:

- points the database/uploads/backups at a throwaway folder (`$DEMO_DATA_DIR`,
  default `/tmp/signshop-demo` on the host) — your real `dashboard.db` is never touched;
- seeds it with lifelike jobs across every stage, customers, inventory (with
  low-stock items), quotes, and equipment;
- adds a **"Live demo" banner with a Reset button**;
- never starts the email digest thread and never sends email.

## Deploy on Render (free, no credit card)

1. Put the app source (this repo: `SignshopDashboard.py`, `templates/`,
   `static/`, and this `demo/` folder) in a **GitHub repo Render can read**.
   Use a **private repo** so your dashboard source stays private — Render's free
   tier deploys private repos fine. (Don't reuse your public website repo.)
2. Go to **render.com** → sign up → **New → Blueprint**.
3. Pick the repo. Render reads `demo/render.yaml` and configures everything
   (build: `pip install -r demo/requirements.txt`; start:
   `gunicorn demo.demo:app`). Click **Apply**.
4. Wait ~2 minutes for the first build. You'll get a public URL like
   `https://signshop-dashboard-demo.onrender.com`.

That URL is your demo. Link to it from the site, e.g. in
`shop-website-public/project/index.html`:

```html
<a href="https://signshop-dashboard-demo.onrender.com" target="_blank">See the live dashboard →</a>
```

### What to expect (free-tier tradeoffs)

- **Cold start:** after ~15 min idle the service sleeps; the next visit takes
  30–60s to wake. Fine for a portfolio/demo link.
- **Self-resetting:** the free disk is wiped on restart, so the demo returns to
  clean sample data on its own. Visitors can also hit **Reset demo** anytime.
- **Shared, no login:** everyone sees and edits the same board (that's the point
  of a demo). There's no authentication, so don't put anything real here.
- **Free quota:** 750 instance-hours/month per workspace — plenty for one demo.

## Run it locally first

From the **repo root** (not inside `demo/`):

```bash
pip install -r demo/requirements.txt
python demo/demo.py          # opens http://localhost:5000
```

Set a different port or data dir with env vars:

```bash
PORT=8080 DEMO_DATA_DIR=./demo_data python demo/demo.py
```

## Other hosts

Any host that runs a Python web service works. The start command is always:

```bash
gunicorn demo.demo:app --bind 0.0.0.0:$PORT
```

PythonAnywhere (free, always-on) also works, but its disk **persists**, so the
demo won't auto-reset — use the **Reset demo** button, or hit
`POST /api/demo/reset`, to clean it up.
