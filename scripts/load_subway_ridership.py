#!/usr/bin/env python3
"""
load_subway_ridership.py
Loads MTA subway hourly ridership CSV into subway_hourly_ridership table.
File: /Volumes/5TB1/TownTrip/mta_subway_ridership.csv
Expected columns: transit_timestamp, station_complex_id, station_complex,
                  borough, payment_method, fare_class_category, ridership, transfers, latitude, longitude
Run: python3 /Volumes/5TB1/TownTrip/load_subway_ridership.py
"""
import csv, json, ssl, urllib.request, datetime, sys, os

FILE = "/Volumes/5TB1/TownTrip/mta_subway_ridership.csv"
SK   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY2ODc1OCwiZXhwIjoyMDg4MjQ0NzU4fQ.jPRln_LQRrIGF5iA-H_DBsRW2FjPaf3ys5yBvy908eo"
BASE = "https://xyfyuvikqmxcazqgqoxb.supabase.co"
TABLE = "subway_hourly_ridership"
BATCH = 500
ctx  = ssl.create_default_context()

if not os.path.exists(FILE):
    print(f"File not found: {FILE}")
    sys.exit(1)

size_mb = os.path.getsize(FILE) / 1024 / 1024
print(f"File: {FILE} ({size_mb:.1f} MB)")

def insert_batch(rows):
    body = json.dumps(rows).encode()
    req = urllib.request.Request(
        BASE + "/rest/v1/" + TABLE, data=body, method="POST",
        headers={"apikey":SK,"Authorization":"Bearer "+SK,
                 "Content-Type":"application/json","Prefer":"resolution=merge-duplicates,return=minimal"})
    with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
        return r.status

def parse_float(v):
    try: return float(v) if v else None
    except: return None

def parse_int(v):
    try: return int(float(v)) if v else None
    except: return None

print("Reading CSV headers...")
with open(FILE, "r", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    headers = reader.fieldnames
    print("Headers:", headers[:8], "...")

print("Loading rows (Bronx + Manhattan only for now, ~last 2 years)...")
total = 0; skipped = 0; errors = 0
batch = []
cutoff = "2024-01-01"

with open(FILE, "r", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    for i, row in enumerate(reader):
        if i % 100000 == 0 and i > 0:
            print(f"  Scanned {i:,} rows | loaded {total:,} | errors {errors}", flush=True)

        ts = row.get("transit_timestamp","").strip()
        if not ts or ts[:10] < cutoff:
            skipped += 1
            continue

        borough = (row.get("borough","") or "").strip()
        if borough not in ("Bronx","Manhattan","Brooklyn","Queens","Staten Island"):
            skipped += 1
            continue

        try:
            rec = {
                "ts": ts,
                "transit_mode": "subway",
                "station_complex_id": row.get("station_complex_id","").strip() or None,
                "station_complex": row.get("station_complex","").strip() or None,
                "borough": borough or None,
                "payment_method": row.get("payment_method","").strip() or None,
                "fare_class": row.get("fare_class_category","").strip() or None,
                "ridership": parse_float(row.get("ridership","")),
                "transfers": parse_float(row.get("transfers","")),
                "lat": parse_float(row.get("latitude","")),
                "lon": parse_float(row.get("longitude","")),
            }
            batch.append(rec)
        except Exception as e:
            errors += 1
            continue

        if len(batch) >= BATCH:
            try:
                insert_batch(batch)
                total += len(batch)
            except Exception as e:
                errors += len(batch)
                print(f"  Batch ERR: {str(e)[:60]}")
            batch = []

if batch:
    try:
        insert_batch(batch)
        total += len(batch)
    except Exception as e:
        errors += len(batch)

print(f"\nDone. Loaded: {total:,} | Skipped: {skipped:,} | Errors: {errors:,}")
