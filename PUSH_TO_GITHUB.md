# Pushing this to GitHub

This folder is a clean copy of the sign shop dashboard: **code only**.
Your live database (`dashboard.db`), settings (`config.json` — includes
your Gmail app password!), backups, and customer file uploads are NOT in
here, and the included `.gitignore` keeps them out of git forever.

## One-time setup

Open PowerShell in this folder and run:

```powershell
# install git if you don't have it:  winget install Git.Git
git init
git add .
git commit -m "Sign shop production dashboard"
```

## Create the repo on GitHub

**Option A — GitHub CLI (easiest):**
```powershell
winget install GitHub.cli
gh auth login          # follow the browser prompts once
gh repo create signshop-dashboard --private --source . --push
```

**Option B — manually:**
1. Go to https://github.com/new
2. Name it `signshop-dashboard`, set it to **Private**, do NOT add a README
3. Then:
```powershell
git remote add origin https://github.com/YOUR-USERNAME/signshop-dashboard.git
git branch -M main
git push -u origin main
```

## After future changes

```powershell
git add .
git commit -m "describe what changed"
git push
```

## Notes

- Keep the repo **Private** — the code reveals shop details even without data.
- First run on a new machine: `pip install -r requirements.txt` then
  `python SignshopDashboard.py` — the database and config are created fresh
  automatically. (`python app.py` also works; it's a compatibility launcher.)
- `setup-autostart.ps1` (run as Administrator) sets up auto-start at login
  and the firewall rule for access from other devices.
