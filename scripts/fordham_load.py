import csv, json, ssl, urllib.request
from datetime import datetime

SK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY2ODc1OCwiZXhwIjoyMDg4MjQ0NzU4fQ.jPRln_LQRrIGF5iA-H_DBsRW2FjPaf3ys5yBvy908eo"
BASE = "https://xyfyuvikqmxcazqgqoxb.supabase.co"
ctx = ssl.create_default_context()
CSV = "/Volumes/5TB1/TownTrip/pollen_count_-_latest_update.csv"

def parse_pcm(v):
    v = str(v).strip().replace(" pcm","").replace("pcm","").replace(",","").strip()
    try:
        return float(v)
    except:
        return None

def parse_date(d):
    d = str(d).strip()
    for fmt in ["%m/%d/%Y", "%m/%d/%y"]:
        try:
            return datetime.strptime(d, fmt).strftime("%Y-%m-%d")
        except:
            pass
    return None

def upsert(rows):
    body = json.dumps(rows).encode()
    req = urllib.request.Request(
        BASE + "/rest/v1/pollen_history", data=body, method="POST",
        headers={"apikey": SK, "Authorization": "Bearer " + SK,
                 "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"})
    with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
        return r.status

with open(CSV, newline="", encoding="utf-8-sig", errors="replace") as f:
    raw = list(csv.reader(f))

calder_start = None
for i, r in enumerate(raw):
    if any("CALDER" in str(c).upper() for c in r):
        calder_start = i
        break

all_rows = []
for dates, vals, predoms, loc, lat, lon in [
    (raw[2], raw[3], raw[5], "lincoln_center_nyc", 40.7727, -73.9833),
    (raw[calder_start+1] if calder_start else [], raw[calder_start+2] if calder_start else [], raw[calder_start+4] if calder_start else [], "calder_center_armonk_ny", 41.1340, -73.7124),
]:
    for i, (d, v) in enumerate(zip(dates, vals)):
        dt = parse_date(d)
        pcm = parse_pcm(v)
        if dt and pcm is not None:
            p = predoms[i].strip() if i < len(predoms) else None
            if p in ("-", "", None):
                p = None
            src = "fordham_lincoln" if "lincoln" in loc else "fordham_calder"
            all_rows.append({"date": dt, "location_name": loc, "lat": lat, "lon": lon,
                             "tree_grains_m3": pcm, "dominant_type": p[:200] if p else None, "source": src})

print("Total: " + str(len(all_rows)))
ok = 0
for i in range(0, len(all_rows), 100):
    try:
        s = upsert(all_rows[i:i+100])
        ok += min(100, len(all_rows)-i)
        if i % 500 == 0:
            print("  " + str(ok) + " done, HTTP " + str(s))
    except Exception as e:
        print("  ERR: " + str(e)[:50])
print("Done. " + str(ok) + " inserted.")
