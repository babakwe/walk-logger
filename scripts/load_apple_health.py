#!/usr/bin/env python3
"""
load_apple_health.py - Load Apple Health export.xml into Supabase
Run: python3 /Volumes/5TB1/TownTrip/load_apple_health.py /path/to/export.xml
"""
import xml.etree.ElementTree as ET, json, ssl, urllib.request, sys, os

FILE = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Downloads/export.xml")
SK   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY2ODc1OCwiZXhwIjoyMDg4MjQ0NzU4fQ.jPRln_LQRrIGF5iA-H_DBsRW2FjPaf3ys5yBvy908eo"
BASE = "https://xyfyuvikqmxcazqgqoxb.supabase.co"
ctx  = ssl.create_default_context()
BATCH = 500

def post(table, rows):
    body = json.dumps(rows).encode()
    req = urllib.request.Request(BASE + "/rest/v1/" + table, data=body, method="POST",
        headers={"apikey":SK,"Authorization":"Bearer "+SK,
                 "Content-Type":"application/json","Prefer":"resolution=merge-duplicates,return=minimal"})
    with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
        return r.status

def pf(v):
    try: return float(v) if v else None
    except: return None

def flush(table, batch, counter):
    if not batch: return
    try: post(table, batch); counter[0] += len(batch)
    except Exception as e: print(f"  {table} ERR: {str(e)[:60]}")
    batch.clear()

if not os.path.exists(FILE):
    print(f"File not found: {FILE}"); exit(1)

print(f"Parsing {FILE} ({os.path.getsize(FILE)//1024//1024}MB)...", flush=True)
tree = ET.parse(FILE)
root = tree.getroot()
print("Parsed. Loading...", flush=True)

hr=[]; hr_n=[0]
hrv=[]; hrv_n=[0]
spo2=[]; spo2_n=[0]
wt=[]; wt_n=[0]

for rec in root.iter('Record'):
    rtype = rec.get('type','')
    val   = rec.get('value','')
    start = rec.get('startDate','')
    src   = rec.get('sourceName','')

    if 'HeartRate' in rtype and 'Variability' not in rtype and 'Resting' not in rtype and 'Recovery' not in rtype and 'Walking' not in rtype and 'Average' not in rtype:
        bpm = pf(val)
        if bpm:
            hr.append({"session_id":"apple_health","recorded_at":start,"hr_bpm":bpm,"source":"apple_health","device":src})
            if len(hr) >= BATCH:
                flush("hrm_events", hr, hr_n)
                if hr_n[0] % 5000 == 0: print(f"  HR: {hr_n[0]:,}", flush=True)

    elif 'HeartRateVariabilitySDNN' in rtype:
        v = pf(val)
        if v:
            hrv.append({"session_id":"apple_health","recorded_at":start,"hrv_rmssd":v,"source":"apple_health","device":src})
            if len(hrv) >= BATCH: flush("hrm_events", hrv, hrv_n)

    elif 'OxygenSaturation' in rtype:
        v = pf(val)
        if v:
            spo2.append({"session_id":"apple_health_spo2","recorded_at":start,"hr_bpm":None,"source":"apple_health_spo2","device":src})
            if len(spo2) >= BATCH: flush("hrm_events", spo2, spo2_n)

    elif 'BodyMass' in rtype:
        v = pf(val)
        if v:
            wt.append({"measured_at":start,"weight_kg":v,"weight_lbs":round(v*2.20462,1),"source":"apple_health","scale_model":"Apple Watch"})
            if len(wt) >= BATCH: flush("weight_events", wt, wt_n)

flush("hrm_events", hr, hr_n)
flush("hrm_events", hrv, hrv_n)
flush("hrm_events", spo2, spo2_n)
flush("weight_events", wt, wt_n)

print(f"\nDone.")
print(f"  Heart rate:  {hr_n[0]:,}")
print(f"  HRV:         {hrv_n[0]:,}")
print(f"  SpO2:        {spo2_n[0]:,}")
print(f"  Weight:      {wt_n[0]:,}")
