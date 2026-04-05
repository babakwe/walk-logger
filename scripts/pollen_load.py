import urllib.request, json, ssl, time, datetime

SK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY2ODc1OCwiZXhwIjoyMDg4MjQ0NzU4fQ.jPRln_LQRrIGF5iA-H_DBsRW2FjPaf3ys5yBvy908eo"
BASE = "https://xyfyuvikqmxcazqgqoxb.supabase.co"
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
        headers={
            "apikey": SK, "Authorization": "Bearer " + SK,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal"
        })
    with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
        return r.status

LOCS = [
    ("bronx_nyc", 40.8699, -73.8318),
    ("durham_nc", 35.994, -78.8986),
    ("raleigh_nc", 35.7796, -78.6382),
]
rows = []

print("=== Google Pollen API (5-day forecast) ===")
for name, lat, lon in LOCS:
    print("Fetching " + name + "...")
    try:
        url = ("https://pollen.googleapis.com/v1/forecast:lookup"
               "?key=" + G_KEY +
               "&location.latitude=" + str(lat) +
               "&location.longitude=" + str(lon) +
               "&days=5")
        d = get(url)
        days = d.get("dailyInfo") or []
        if not days:
            print("  no data: " + str(d.get("error", {}).get("message", "")))
            continue
        for day in days:
            yr = str(day["date"]["year"])
            mo = str(day["date"]["month"]).zfill(2)
            dy = str(day["date"]["day"]).zfill(2)
            dt = yr + "-" + mo + "-" + dy
            def gu(code):
                for p in (day.get("pollenTypeInfo") or []):
                    if p.get("code") == code:
                        return (p.get("indexInfo") or {}).get("value")
                return None
            t = gu("TREE")
            g = gu("GRASS")
            w = gu("WEED")
            dom = None
            domv = 0
            for p in (day.get("pollenTypeInfo") or []):
                v2 = (p.get("indexInfo") or {}).get("value") or 0
                if v2 > domv:
                    domv = v2
                    dom = p.get("displayName")
            rows.append({
                "date": dt, "location_name": name,
                "lat": lat, "lon": lon,
                "tree_upi": t, "grass_upi": g, "weed_upi": w,
                "dominant_type": dom,
                "dominant_upi": domv or None,
                "source": "google_pollen"
            })
            print("  " + dt + " tree=" + str(t) + " grass=" + str(g) + " weed=" + str(w))
        print("  " + str(len(days)) + " days loaded")
    except Exception as e:
        print("  ERR: " + str(e)[:80])
    time.sleep(1)

print("")
print("=== OpenMeteo (92 days historical) ===")
for name, lat, lon in LOCS:
    print("Fetching " + name + "...")
    try:
        url = ("https://air-quality-api.open-meteo.com/v1/air-quality"
               "?latitude=" + str(lat) +
               "&longitude=" + str(lon) +
               "&hourly=alder_pollen,birch_pollen,grass_pollen,ragweed_pollen"
               "&timezone=auto&past_days=92&forecast_days=7")
        d = get(url)
        ts = d["hourly"]["time"]
        al = d["hourly"].get("alder_pollen") or []
        bi = d["hourly"].get("birch_pollen") or []
        gr = d["hourly"].get("grass_pollen") or []
        rg = d["hourly"].get("ragweed_pollen") or []
        daily = {}
        for i, t in enumerate(ts):
            dt = t[:10]
            if dt not in daily:
                daily[dt] = {"al": [], "bi": [], "gr": [], "rg": []}
            if i < len(al) and al[i] is not None:
                daily[dt]["al"].append(al[i])
            if i < len(bi) and bi[i] is not None:
                daily[dt]["bi"].append(bi[i])
            if i < len(gr) and gr[i] is not None:
                daily[dt]["gr"].append(gr[i])
            if i < len(rg) and rg[i] is not None:
                daily[dt]["rg"].append(rg[i])
        for dt, v in sorted(daily.items()):
            mx = lambda lst: round(max(lst), 2) if lst else None
            a = mx(v["al"])
            b = mx(v["bi"])
            g2 = mx(v["gr"])
            r2 = mx(v["rg"])
            tree = round((a or 0) + (b or 0), 2) or None
            rows.append({
                "date": dt, "location_name": name,
                "lat": lat, "lon": lon,
                "tree_grains_m3": tree,
                "grass_grains_m3": g2,
                "weed_grains_m3": r2,
                "source": "openmeteo"
            })
        print("  " + str(len(daily)) + " days")
    except Exception as e:
        print("  ERR: " + str(e)[:80])
    time.sleep(1)

print("")
print("Inserting " + str(len(rows)) + " rows...")
ok = 0
for i in range(0, len(rows), 200):
    batch = rows[i:i+200]
    try:
        s = upsert(batch)
        print("  batch " + str(i//200+1) + ": HTTP " + str(s))
        ok += len(batch)
    except Exception as e:
        print("  batch " + str(i//200+1) + " ERR: " + str(e)[:60])

print("")
print("=== BRONX POLLEN HISTORY (March-April 2026) ===")
KD = ["2026-03-10","2026-03-15","2026-03-18","2026-03-19","2026-03-20",
      "2026-03-21","2026-03-22","2026-03-23","2026-03-24","2026-03-25",
      "2026-03-26","2026-03-27","2026-03-28","2026-03-29","2026-03-30",
      "2026-03-31","2026-04-01","2026-04-02","2026-04-03","2026-04-04",
      "2026-04-05","2026-04-06","2026-04-07"]
bronx_om = {}
bronx_gp = {}
for r in rows:
    if r["location_name"] == "bronx_nyc":
        dt = r["date"]
        if r["source"] == "openmeteo":
            bronx_om[dt] = r
        elif r["source"] == "google_pollen":
            bronx_gp[dt] = r
print("Date        OpenMeteo tree g/m3   Google UPI   Note")
print("-" * 58)
for dt in KD:
    om = bronx_om.get(dt, {})
    gp = bronx_gp.get(dt, {})
    tg = str(om.get("tree_grains_m3") or "--")
    tu = str(gp.get("tree_upi") or "--")
    note = ""
    if dt == "2026-03-24": note = "~ threshold window"
    if dt == "2026-04-01": note = "pollen visible in room"
    if dt == "2026-04-02": note = "WORST DAY (eyes severe)"
    if dt == "2026-04-03": note = "eyes worse than nose"
    print(dt + "  " + tg.rjust(10) + "         " + tu.rjust(4) + "   " + note)

print("")
print("Done. " + str(ok) + " rows inserted.")
