import urllib.request, json, ssl, time, datetime

SK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY2ODc1OCwiZXhwIjoyMDg4MjQ0NzU4fQ.jPRln_LQRrIGF5iA-H_DBsRW2FjPaf3ys5yBvy908eo"
BASE = "https://xyfyuvikqmxcazqgqoxb.supabase.co"
G_KEY = "AIzaSyCvX9TTFYBTSNT3G5A2X8bOEJOH24f2XFc"
ctx = ssl.create_default_context()

LOCATIONS = [
    ("bronx_10475", 40.8699, -73.8318, "10475"),
    ("bronx_10458", 40.8590, -73.8900, "10458"),
    ("bronx_10463", 40.8815, -73.9146, "10463"),
]

def upsert(rows):
    body = json.dumps(rows).encode()
    req = urllib.request.Request(
        BASE + "/rest/v1/pollen_history", data=body, method="POST",
        headers={"apikey": SK, "Authorization": "Bearer " + SK,
                 "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"})
    with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
        return r.status

def run_daily_poller():
    print("Running daily pollen poller - " + str(datetime.date.today()))
    google_rows = []
    today = str(datetime.date.today())

    for name, lat, lon, zipcode in LOCATIONS:
        print("  Fetching Google Pollen: " + name)
        try:
            url = ("https://pollen.googleapis.com/v1/forecast:lookup"
                   "?key=" + G_KEY +
                   "&location.latitude=" + str(lat) +
                   "&location.longitude=" + str(lon) +
                   "&days=5")
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
                d = json.loads(r.read())
            days = d.get("dailyInfo") or []
            for day in days:
                yr = str(day["date"]["year"])
                mo = str(day["date"]["month"]).zfill(2)
                dy = str(day["date"]["day"]).zfill(2)
                dt = yr + "-" + mo + "-" + dy
                def gu(code, info=day):
                    for p in (info.get("pollenTypeInfo") or []):
                        if p.get("code") == code:
                            return (p.get("indexInfo") or {}).get("value")
                    return None
                t = gu("TREE"); g = gu("GRASS"); w = gu("WEED")
                dom = None; domv = 0
                for p in (day.get("pollenTypeInfo") or []):
                    v2 = (p.get("indexInfo") or {}).get("value") or 0
                    if v2 > domv:
                        domv = v2
                        dom = p.get("displayName")
                google_rows.append({
                    "date": dt, "location_name": name,
                    "lat": lat, "lon": lon,
                    "tree_upi": t, "grass_upi": g, "weed_upi": w,
                    "dominant_type": dom, "dominant_upi": domv or None,
                    "source": "google_pollen"
                })
            print("    " + str(len(days)) + " days")
        except Exception as e:
            print("    ERR: " + str(e)[:60])
        time.sleep(1)

    if google_rows:
        try:
            s = upsert(google_rows)
            print("  Google rows inserted: " + str(len(google_rows)) + " HTTP " + str(s))
        except Exception as e:
            print("  Google insert ERR: " + str(e)[:60])

    # pollen.com - insert separately (different schema)
    try:
        print("  Fetching pollen.com data...")
        url = "https://www.pollen.com/api/forecast/current/pollen/10475"
        req = urllib.request.Request(url, headers={
            "Accept": "application/json",
            "Referer": "https://www.pollen.com/forecast/current/pollen/10475",
            "User-Agent": "Mozilla/5.0"
        })
        with urllib.request.urlopen(req, context=ctx, timeout=15) as r:
            pc = json.loads(r.read())
        periods = (pc.get("Location") or {}).get("periods") or []
        for p in periods:
            idx = p.get("Index")
            typ = p.get("Triggers")
            if idx is not None:
                row = {
                    "date": today, "location_name": "bronx_10475_pollencom",
                    "lat": 40.8699, "lon": -73.8318,
                    "tree_upi": None, "grass_upi": None, "weed_upi": None,
                    "dominant_upi": idx,
                    "dominant_type": str(typ)[:100] if typ else None,
                    "source": "pollen_com"
                }
                try:
                    s = upsert([row])
                    print("    pollen.com today: " + str(idx) + "/12 HTTP " + str(s))
                except Exception as e:
                    print("    pollen.com ERR: " + str(e)[:60])
                break
    except Exception as e:
        print("    pollen.com fetch ERR: " + str(e)[:60])

    print("Daily poll complete.")

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "poll":
        run_daily_poller()
    else:
        run_daily_poller()
