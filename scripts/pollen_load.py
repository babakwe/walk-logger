import urllib.request, json, ssl, time, datetime

SK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY2ODc1OCwiZXhwIjoyMDg4MjQ0NzU4fQ.jPRln_LQRrIGF5iA-H_DBsRW2FjPaf3ys5yBvy908eo"
BASE = "https://xyfyuvikqmxcazqgqoxb.supabase.co"
T_KEY = "ySXzP8sbYZCJasBtAzaSQovtv0QJDH8F"
G_KEY = "AIzaSyCvX9TTFYBTSNT3G5A2X8bOEJOH24f2XFc"
ctx = ssl.create_default_context()

def get(url):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
        return json.loads(r.read())

def upsert(rows):
    body = json.dumps(rows).encode()
    req = urllib.request.Request(
        BASE + "/rest/v1/pollen_history", data=body, method="POST",
        headers={"apikey": SK, "Authorization": "Bearer " + SK,
                 "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"})
    with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
        return r.status

LOCS = [
    ("bronx_nyc", 40.8699, -73.8318),
    ("durham_nc", 35.994, -78.8986),
    ("raleigh_nc", 35.7796, -78.6382),
    ("banjul_gambia", 13.4549, -16.5790),
]

rows = []
today = datetime.date.today()
start = today - datetime.timedelta(days=92)

print("=== Tomorrow.io (92 days historical) ===")
for name, lat, lon in LOCS:
    print("Fetching:", name)
    try:
        url = ("https://api.tomorrow.io/v4/timelines"
               "?location=" + str(lat) + "," + str(lon) +
               "&fields=treeIndex,grassIndex,weedIndex,pollenIndex"
               "&units=metric&timesteps=1d"
               "&startTime=" + start.isoformat() + "T00:00:00Z"
               "&endTime=" + today.isoformat() + "T23:59:59Z"
               "&apikey=" + T_KEY)
        d = get(url)
        intervals = (d.get("data") or {}).get("timelines", [{}])[0].get("intervals") or []
        for iv in intervals:
            dt = iv["startTime"][:10]
            v = iv.get("values") or {}
            rows.append({
                "date": dt, "location_name": name, "lat": lat, "lon": lon,
                "tree_upi": v.get("treeIndex"),
                "grass_upi": v.get("grassIndex"),
                "weed_upi": v.get("weedIndex"),
                "dominant_upi": v.get("pollenIndex"),
                "source": "tomorrow_io"
            })
        print(" ", len(intervals), "days")
    except Exception as e:
        print("  ERR:", str(e)[:80])
    time.sleep(2)

print()
print("=== Google Pollen (5-day forecast) ===")
for name, lat, lon in LOCS:
    print("Fetching:", name)
    try:
        url = ("https://pollen.googleapis.com/v1/forecast:lookup"
               "?key=" + G_KEY +
               "&location.latitude=" + str(lat) +
               "&location.longitude=" + str(lon) + "&days=5")
        d = get(url)
        days = d.get("dailyInfo") or []
        if not days:
            print("  no data:", d.get("error", {}).get("message", ""))
            continue
        for day in days:
            dt = str(day["date"]["year"]) + "-" + str(day["date"]["month"]).zfill(2) + "-" + str(day["date"]["day"]).zfill(2)
            def gu(code):
                for p in (day.get("pollenTypeInfo") or []):
                    if p.get("code") == code:
                        return (p.get("indexInfo") or {}).get("value")
                return None
            t, g, w = gu("TREE"), gu("GRASS"), gu("WEED")
            dom, domv = None, 0
            for p in (day.get("pollenTypeInfo") or []):
                v2 = (p.get("indexInfo") or {}).get("value") or 0
                if v2 > domv: domv = v2; dom = p.get("displayName")
            rows.append({"date": dt, "location_name": name, "lat": lat, "lon": lon,
                         "tree_upi": t, "grass_upi": g, "weed_upi": w,
                         "dominant_type": dom, "dominant_upi": domv or None,
                         "source": "google_pollen"})
        print(" ", len(days), "days")
    except Exception as e:
        print("  ERR:", str(e)[:80])
    time.sleep(1)

print()
print("Inserting", len(rows), "total rows...")
for i in range(0, len(rows), 200):
    try:
        s = upsert(rows[i:i+200])
        print("  batch", i//200+1, "HTTP", s)
    except Exception as e:
        print("  batch", i//200+1, "ERR:", str(e)[:60])

print()
print("=== KWASI THRESHOLD TABLE (Bronx NYC) ===")
KD = ["2026-03-15","2026-03-16","2026-03-17","2026-03-18","2026-03-19","2026-03-20",
      "2026-03-21","2026-03-22","2026-03-23","2026-03-24","2026-03-25","2026-03-26",
      "2026-03-27","2026-03-28","2026-03-29","2026-03-30","2026-03-31",
      "2026-04-01","2026-04-02","2026-04-03","2026-04-04","2026-04-05","2026-04-06","2026-04-07"]
bronx = {}
for r in rows:
    if r["location_name"] == "bronx_nyc":
        dt = r["date"]
        if dt not in bronx:
            bronx[dt] = {}
        for k in ("tree_upi","grass_upi","weed_upi","dominant_upi","tree_grains_m3"):
            if r.get(k) is not None and bronx[dt].get(k) is None:
                bronx[dt][k] = r[k]

print("Date           Tomorrow tree  Google tree  Note")
print("-" * 60)
for dt in KD:
    b = bronx.get(dt, {})
    tu = str(b.get("tree_upi") or "--")
    note = ""
    if dt == "2026-03-24": note = "<-- THRESHOLD (first symptoms)"
    if dt == "2026-04-01": note = "<-- pollen visible in room"
    if dt == "2026-04-02": note = "<-- WORST DAY"
    if dt >= "2026-04-03": note = "<-- forecast"
    print(dt + "    " + tu.rjust(4) + "                    " + note)
print()
print("Done.")
