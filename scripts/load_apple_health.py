#!/usr/bin/env python3
"""load_apple_health.py - loads Apple Health export.xml into Supabase via Edge Function
Run: python3 load_apple_health.py /path/to/export.xml
"""
import xml.etree.ElementTree as ET, json, ssl, urllib.request, sys, os

FILE   = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Downloads/export.xml")
FUNC   = "https://xyfyuvikqmxcazqgqoxb.supabase.co/functions/v1/data-ingest"
SECRET = "towntrip-ingest-2026"
BATCH  = 400
ctx    = ssl.create_default_context()

if not os.path.exists(FILE):
    print(f"File not found: {FILE}"); sys.exit(1)
print(f"File: {FILE} ({os.path.getsize(FILE)//1024//1024}MB)")

def ingest(table, rows):
    body = json.dumps({"table": table, "rows": rows}).encode()
    req = urllib.request.Request(FUNC, data=body, method="POST",
        headers={"Content-Type":"application/json","x-ingest-secret":SECRET})
    with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
        return json.loads(r.read())

def pf(v):
    try: return float(v) if v else None
    except: return None

print("Parsing...", flush=True)
tree = ET.parse(FILE)
root = tree.getroot()
print("Parsed. Loading...", flush=True)

hr=[]; hr_n=0; hrv=[]; hrv_n=0; wt=[]; wt_n=0

def flush_batch(batch, table, counter):
    if not batch: return
    try:
        res = ingest(table, batch)
        counter[0] += res.get("inserted", len(batch))
    except Exception as e:
        print(f"  {table} ERR: {str(e)[:70]}")
    batch.clear()

hr_c=[0]; hrv_c=[0]; wt_c=[0]

for rec in root.iter('Record'):
    rtype = rec.get('type','')
    val   = rec.get('value','')
    start = rec.get('startDate','')
    src   = rec.get('sourceName','')

    if ('HeartRate' in rtype and 'Variability' not in rtype
            and 'Resting' not in rtype and 'Recovery' not in rtype
            and 'Walking' not in rtype and 'Average' not in rtype):
        bpm = pf(val)
        if bpm:
            hr.append({"session_id":"apple_health","recorded_at":start,"hr_bpm":bpm,"source":"apple_health","device":src})
            if len(hr) >= BATCH:
                flush_batch(hr, "hrm_events", hr_c)
                if hr_c[0] % 5000 == 0: print(f"  HR: {hr_c[0]:,}", flush=True)

    elif 'HeartRateVariabilitySDNN' in rtype:
        v = pf(val)
        if v:
            hrv.append({"session_id":"apple_health","recorded_at":start,"hrv_rmssd":v,"source":"apple_health","device":src})
            if len(hrv) >= BATCH: flush_batch(hrv, "hrm_events", hrv_c)

    elif 'BodyMass' in rtype:
        v = pf(val)
        if v:
            wt.append({"measured_at":start,"weight_kg":v,"weight_lbs":round(v*2.20462,1),"source":"apple_health","scale_model":"Apple Watch"})
            if len(wt) >= BATCH: flush_batch(wt, "weight_events", wt_c)

flush_batch(hr, "hrm_events", hr_c)
flush_batch(hrv, "hrm_events", hrv_c)
flush_batch(wt, "weight_events", wt_c)

print(f"\nDone.")
print(f"  Heart rate: {hr_c[0]:,}")
print(f"  HRV:        {hrv_c[0]:,}")
print(f"  Weight:     {wt_c[0]:,}")
