# The dashboard now lives in SignshopDashboard.py.
# This launcher is kept so anything that still runs "python app.py"
# (like the existing scheduled task) keeps working unchanged.
import runpy

runpy.run_module("SignshopDashboard", run_name="__main__")
