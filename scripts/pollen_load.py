import urllib.request, json, ssl, time

SK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY2ODc1OCwiZXhwIjoyMDg4MjQ0NzU4fQ.jPRln_LQRrIGF5iA-H_DBsRW2FjPaf3ys5yBvy908eo"
BASE = "https://xyfyuvikqmxcazqgqoxb.supabase.co"
GKEY = "AIzaSyCvX9TTFYBTSNT3G5A2X8bOEJOH24f2XFc"
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

def handle_error(e, rows):
    print("  insert error:", str(e)[:80])
    print("  trying one-by-one...")
    ok = 0
    for row in rows:
        try:
            upsert([row])
            ok += 1
        except:
            pass
    print("  inserted", ok, "of", len(rows))

LOCS = [("bronx_nyc",40.8699,-73.8318),("durham_nc",35.994,-78.8986),("raleigh_nc",35.7796,-78.6382),("banjul_alt",13.5,-16.0)]
rows = []

for name,lat,lon in LOCS:
    print("OpenMeteo:", name)
    try:
        url = ("https://air-quality-api.open-meteo.com/v1/air-quality?latitude="+str(lat)+"&longitude="+str(lon)+"&hourly=alder_pollen,birch_pollen,grass_pollen,ragweed_pollen&timezone=auto&past_days=92&forecast_days=7")
        d = get(url)
        ts = d["hourly"]["time"]
        al = d["hourly"].get("alder_pollen") or []
        bi = d["hourly"].get("birch_pollen") or []
        gr = d["hourly"].get("grass_pollen") or []
        rg = d["hourly"].get("ragweed_pollen") or []
        day = {}
        for i,t in enumerate(ts):
            dt = t[:10]
            if dt not in day: day[dt]={"al":[],"bi":[],"gr":[],"rg":[]}
            if i<len(al) and al[i] is not None: day[dt]["al"].append(al[i])
            if i<len(bi) and bi[i] is not None: day[dt]["bi"].append(bi[i])
            if i<len(gr) and gr[i] is not None: day[dt]["gr"].append(gr[i])
            if i<len(rg) and rg[i] is not None: day[dt]["rg"].append(rg[i])
        for dt,v in sorted(day.items()):
            mx = lambda lst: round(max(lst),2) if lst else None
            a,b,g2,r2 = mx(v["al"]),mx(v["bi"]),mx(v["gr"]),mx(v["rg"])
            tree = round((a or 0)+(b or 0),2) or None
            rows.append({"date":dt,"location_name":name,"lat":lat,"lon":lon,"tree_grains_m3":tree,"grass_grains_m3":g2,"weed_grains_m3":r2,"source":"openmeteo"})
        print(" ",len(day),"days")
    except Exception as e:
        print("  ERR:",e)
    time.sleep(1)

for name,lat,lon in LOCS:
    print("Google Pollen:", name)
    try:
        url = "https://pollen.googleapis.com/v1/forecast:lookup?key="+GKEY+"&location.latitude="+str(lat)+"&location.longitude="+str(lon)+"&days=5"
        d = get(url)
        days = d.get("dailyInfo") or []
        if not days:
            print("  no data:", d.get("error",{}).get("message",""))
            continue
        for day in days:
            dt = str(day["date"]["year"])+"-"+str(day["date"]["month"]).zfill(2)+"-"+str(day["date"]["day"]).zfill(2)
            def gu(code):
                for p in (day.get("pollenTypeInfo") or []):
                    if p.get("code")==code: return (p.get("indexInfo") or {}).get("value")
                return None
            t,g2,w = gu("TREE"),gu("GRASS"),gu("WEED")
            dom,domv = None,0
            for p in (day.get("pollenTypeInfo") or []):
                v2=(p.get("indexInfo") or {}).get("value") or 0
                if v2>domv: domv=v2; dom=p.get("displayName")
            rows.append({"date":dt,"location_name":name,"lat":lat,"lon":lon,"tree_upi":t,"grass_upi":g2,"weed_upi":w,"dominant_type":dom,"dominant_upi":domv or None,"source":"google_pollen"})
        print(" ",len(days),"days")
    except Exception as e:
        print("  ERR:",e)
    time.sleep(1)

print("\nInserting",len(rows),"rows...")
for i in range(0,len(rows),200):
    batch = rows[i:i+200]
    try:
        s = upsert(batch)
        print("  batch",i//200+1,"HTTP",s)
    except Exception as e:
        handle_error(e, batch)

print("\n--- BRONX NYC THRESHOLD ---")
bronx = {}
for r in rows:
    if r["location_name"]=="bronx_nyc":
        dt=r["date"]
        if dt not in bronx: bronx[dt]=r
        else:
            if r.get("tree_grains_m3") and not bronx[dt].get("tree_grains_m3"): bronx[dt]["tree_grains_m3"]=r["tree_grains_m3"]
            if r.get("tree_upi") and not bronx[dt].get("tree_upi"): bronx[dt]["tree_upi"]=r["tree_upi"]
KD=["2026-03-20","2026-03-21","2026-03-22","2026-03-23","2026-03-24","2026-03-25","2026-03-26","2026-03-27","2026-03-28","2026-03-29","2026-03-30","2026-03-31","2026-04-01","2026-04-02","2026-04-03","2026-04-04","2026-04-05","2026-04-06","2026-04-07"]
print("Date           Tree g/m3  UPI  Note")
print("-"*55)
for dt in KD:
    r=bronx.get(dt,{})
    note=""
    if dt=="2026-03-24": note="<-- THRESHOLD (first symptoms)"
    if dt=="2026-04-01": note="<-- pollen visible in room"
    if dt=="2026-04-02": note="<-- WORST DAY"
    print(dt,"  ",str(r.get("tree_grains_m3") or "--").rjust(8)," ",str(r.get("tree_upi") or "--").rjust(3),"  ",note)
print("\nDone.")
