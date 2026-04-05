import urllib.request, json, ssl, time, datetime

SK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY2ODc1OCwiZXhwIjoyMDg4MjQ0NzU4fQ.jPRln_LQRrIGF5iA-H_DBsRW2FjPaf3ys5yBvy908eo"
BASE = "https://xyfyuvikqmxcazqgqoxb.supabase.co"
G_KEY = "AIzaSyCvX9TTFYBTSNT3G5A2X8bOEJOH24f2XFc"
ctx = ssl.create_default_context()

LOCATIONS = [
    ("bronx_10475", 40.8699, -73.8318),
    ("bronx_10458", 40.8590, -73.8900),
    ("bronx_10463", 40.8815, -73.9146),
]

def upsert_row(row):
    body = json.dumps(row).encode()
    req = urllib.request.Request(
        BASE + "/rest/v1/pollen_history",
        data=body, method="POST",
        headers={
            "apikey": SK, "Authorization": "Bearer " + SK,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal"
        }
    )
    with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
        return r.status

def run_daily_poller():
    print("Running daily pollen poller - " + str(datetime.date.today()))
    today = str(datetime.date.today())
    ok = 0

    for name, lat, lon in LOCATIONS:
        print("  Fetching Google Pollen: " + name)
        try:
            url = ("https://pollen.googleapis.com/v1/forecast:lookup"
                   + "?key=" + G_KEY
                   + "&location.latitude=" + str(lat)
                   + "&location.longitude=" + str(lon)
                   + "&days=5")
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
                d = json.loads(r.read())
            for day in (d.get("dailyInfo") or []):
                dt = (str(day["date"]["year"]) + "-"
                      + str(day["date"]["month"]).zfill(2) + "-"
                      + str(day["date"]["day"]).zfill(2))
                def gu(code, info=day):
                    for p in (info.get("pollenTypeInfo") or []):
                        if p.get("code") == code:
                            return (p.get("indexInfo") or {}).get("value")
                    return None
                dom = None; domv = 0
                for p in (day.get("pollenTypeInfo") or []):
                    v = (p.get("indexInfo") or {}).get("value") or 0
                    if v > domv:
                        domv = v; dom = p.get("displayName")
                row = {"date": dt, "location_name": name,
                       "lat": lat, "lon": lon,
                       "tree_upi": gu("TREE"), "grass_upi": gu("GRASS"), "weed_upi": gu("WEED"),
                       "dominant_type": dom, "dominant_upi": domv or None,
                       "source": "google_pollen"}
                try:
                    upsert_row(row); ok += 1
                except Exception as e:
                    print("    row ERR " + dt + ": " + str(e)[:40])
            print("    done")
        except Exception as e:
            print("    fetch ERR: " + str(e)[:60])
        time.sleep(1)

    print("  Google: " + str(ok) + " rows upserted")

    # pollen.com: scrape their public JSON (requires browser-like headers)
    # Note: run this from a browser session or use curl with cookies.
    # Skipping API call here - data is loaded via browser session separately.
    print("  pollen.com: loaded via browser session (see pollen_pollencom_load.py)")
    print("Daily poll complete.")

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "poll":
        run_daily_poller()
    else:
        run_daily_poller()
