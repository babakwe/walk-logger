#!/usr/bin/env python3
"""
load_bus_ridership.py
Loads MTA bus hourly ridership CSV into mta_bus_hourly_ridership table.
File: /Volumes/5TB1/TownTrip/mta_bus_ridership.csv
Run: python3 /Volumes/5TB1/TownTrip/load_bus_ridership.py
"""
import csv, json, ssl, urllib.request, sys, os

FILE = "/Volumes/5TB1/TownTrip/mta_bus_ridership.csv"
SK   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY2ODc1OCwiZXhwIjoyMDg4MjQ0NzU4fQ.jPRln_LQRrIGF5iA-H_DBsRW2FjPaf3ys5yBvy908eo"
BASE = "https://xyfyuvikqmxcazqgqoxb.supabase.co"
TABLE = "mta_bus_hourly_ridership"
BATCH = 500
ctx  = ssl.create_default_context()

if not os.path.exists(FILE):
    print(f"File not found: {FILE}"); sys.exit(1)

size_mb = os.path.getsize(FILE) / 1024 / 1024
print(f"File: {size_mb:.1f} MB")
if size_mb < 1:
    print("File too small - download may have failed. Check the file contents:")
    print(open(FILE).read()[:200])
    sys.exit(1)

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

print("Reading CSV headers...")
with open(FILE, "r", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    print("Headers:", reader.fieldnames)

total = 0; skipped = 0; errors = 0; batch = []
cutoff = "2024-01-01"

with open(FILE, "r", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    for i, row in enumerate(reader):
        if i % 100000 == 0 and i > 0:
            print(f"  {i:,} scanned | {total:,} loaded", flush=True)

        ts = (row.get("transit_timestamp","") or row.get("date","") or "").strip()
        if not ts or ts[:10] < cutoff:
            skipped += 1; continue

        try:
            rec = {
                "transit_timestamp": ts,
                "route_id": (row.get("route_id","") or row.get("Route","") or "").strip().upper() or None,
                "borough": (row.get("borough","") or row.get("Borough","") or "").strip() or None,
                "ridership": parse_float(row.get("ridership","") or row.get("Ridership","")),
                "fare_class": (row.get("fare_class_category","") or row.get("payment_method","") or "").strip() or None,
            }
            if not rec["route_id"]: skipped += 1; continue
            batch.append(rec)
        except Exception as e:
            errors += 1; continue

        if len(batch) >= BATCH:
            try:
                insert_batch(batch); total += len(batch)
            except Exception as e:
                errors += len(batch)
                print(f"  Batch ERR: {str(e)[:60]}")
            batch = []

if batch:
    try: insert_batch(batch); total += len(batch)
    except: errors += len(batch)

print(f"\nDone. Loaded: {total:,} | Skipped: {skipped:,} | Errors: {errors:,}")
