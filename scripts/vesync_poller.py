#!/usr/bin/env python3
"""
vesync_poller.py - TownTrip VeSync device poller
Levoit Core 300S PM2.5 + Etekcity EFS-A591S weight

Cron every 15 min:
  */15 * * * * python3 /Volumes/5TB1/TownTrip/vesync_poller.py >> /Volumes/5TB1/TownTrip/vesync_poll.log 2>&1
"""
import urllib.request, json, ssl, datetime, os, hashlib, time

VESYNC_EMAIL    = os.environ.get("VESYNC_EMAIL", "YOUR_VESYNC_EMAIL")
VESYNC_PASSWORD = os.environ.get("VESYNC_PASSWORD", "YOUR_VESYNC_PASSWORD")
VESYNC_TZ       = "America/New_York"
VESYNC_API      = "https://smartapi.vesync.com"
SK   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY2ODc1OCwiZXhwIjoyMDg4MjQ0NzU4fQ.jPRln_LQRrIGF5iA-H_DBsRW2FjPaf3ys5yBvy908eo"
BASE = "https://xyfyuvikqmxcazqgqoxb.supabase.co"
ctx  = ssl.create_default_context()

def post(url, body, token="", account_id=""):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type":"application/json","User-Agent":"VeSync 3.0.51",
                 "Accept":"application/json","Accept-Language":"en",
                 "tk":token,"accountid":account_id}
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=20) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"_error": str(e)[:80]}

def login():
    md5_pw = hashlib.md5(VESYNC_PASSWORD.encode()).hexdigest()
    resp = post(VESYNC_API + "/cloud/v1/user/login", {
        "timeZone":VESYNC_TZ,"acceptLanguage":"en","appVersion":"VeSync 3.0.51",
        "phoneBrand":"SM N9005","phoneOS":"Android","traceId":"towntrip",
        "userType":"1","method":"login","email":VESYNC_EMAIL,
        "password":md5_pw,"devToken":""
    })
    result = resp.get("result") or {}
    token = result.get("token","")
    account_id = str(result.get("accountID",""))
    if not token:
        print("Login failed:", resp.get("msg",""), resp.get("_error",""))
        return None, None
    print("Logged in. Account:", account_id, "| Token:", token[:10]+"...")
    return token, account_id

def get_devices(token, account_id):
    """Try multiple endpoints - VeSync uses different ones for different device types."""
    all_devices = []
    base_body = {
        "timeZone":VESYNC_TZ,"acceptLanguage":"en","appVersion":"VeSync 3.0.51",
        "phoneBrand":"SM N9005","phoneOS":"Android","traceId":"towntrip",
        "method":"devices","pageNo":1,"pageSize":100
    }

    # Try all known device list endpoints
    endpoints = [
        "/cloud/v2/deviceManaged/devices",
        "/cloud/v1/deviceManaged/devices",
        "/cloud/v2/device/device/getOwnDevices",
    ]
    for ep in endpoints:
        resp = post(VESYNC_API + ep, base_body, token, account_id)
        if resp.get("_error"):
            print("  " + ep + " -> ERROR:", resp["_error"])
            continue
        code = resp.get("code","?")
        result = resp.get("result") or {}
        devlist = result.get("list") or result.get("total_record") and result.get("list") or []
        if isinstance(result, list):
            devlist = result
        print(f"  {ep} -> code:{code} devices:{len(devlist)}")
        if devlist:
            all_devices.extend(devlist)
            break
        time.sleep(0.3)

    # Also try the energy/scale specific endpoint
    scale_resp = post(VESYNC_API + "/cloud/v1/deviceManaged/fatScale/getWeighData", {
        "timeZone":VESYNC_TZ,"acceptLanguage":"en","appVersion":"VeSync 3.0.51",
        "traceId":"towntrip","method":"getWeighData","pageNo":1,"pageSize":5
    }, token, account_id)
    print("  Scale direct:", "code:", scale_resp.get("code","?"), "| result keys:", list((scale_resp.get("result") or {}).keys()))
    scale_records = (scale_resp.get("result") or {}).get("list") or []
    if scale_records:
        print("  Scale records found:", len(scale_records))
        for rec in scale_records[:2]:
            w = rec.get("weight") or rec.get("bodyWeight")
            t = rec.get("measureTime") or rec.get("createdTime","")
            print("    weight:", w, "kg =", round(float(w)*2.20462,1) if w else "?", "lbs | time:", str(t)[:19])

    return all_devices

def sb_insert(table, row):
    req = urllib.request.Request(
        BASE + "/rest/v1/" + table, data=json.dumps(row).encode(), method="POST",
        headers={"apikey":SK,"Authorization":"Bearer "+SK,
                 "Content-Type":"application/json","Prefer":"return=minimal"}
    )
    with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
        return r.status

def run():
    print("=== VeSync Poller", datetime.datetime.now().strftime("%Y-%m-%d %H:%M"), "===")
    if "YOUR_VESYNC" in VESYNC_EMAIL:
        print("ERROR: Set VESYNC_EMAIL and VESYNC_PASSWORD in the script first")
        return

    token, account_id = login()
    if not token:
        return

    devices = get_devices(token, account_id)

    if not devices:
        print("No devices via list API. Check scale direct endpoint above.")
        return

    now_iso = datetime.datetime.now().isoformat()
    for device in devices:
        dtype = (device.get("deviceType") or "").lower()
        dname = device.get("deviceName") or dtype
        print("Device:", dname, "|", dtype)

        is_purifier = any(x in dtype for x in ["air","purifier","core","131","lv","lav","600","300","400"])
        is_scale    = any(x in dtype for x in ["scale","esf","efs","fat","weight"])

        if is_purifier:
            # Try Core300S specific endpoint
            body = {"timeZone":VESYNC_TZ,"acceptLanguage":"en","appVersion":"VeSync 3.0.51",
                    "traceId":"towntrip","method":"getPurifierStatus",
                    "uuid":device.get("uuid",""),"cid":device.get("cid",""),
                    "configModule":device.get("configModule",""),
                    "payload":{"method":"getPurifierStatus","source":"APP","data":{}}}
            resp = post(VESYNC_API + "/131airpurifier/v1/device/devicedetail", body, token, account_id)
            inner = (resp.get("result") or {})
            pm25 = inner.get("airQuality") or inner.get("pm25")
            print("  PM2.5:", pm25, "| filter:", inner.get("filterLife"), "% | on:", inner.get("deviceStatus"))
            if pm25 is not None:
                s = sb_insert("indoor_air_quality", {
                    "recorded_at": now_iso, "device_name": dname, "device_type": dtype,
                    "pm25_ugm3": pm25, "filter_life_pct": inner.get("filterLife"),
                    "fan_level": inner.get("fanSpeedLevel"),
                    "is_on": inner.get("deviceStatus","") == "on",
                    "location": "home_bronx_10475"
                })
                print("  Saved to Supabase HTTP", s)

        elif is_scale:
            body = {"timeZone":VESYNC_TZ,"acceptLanguage":"en","appVersion":"VeSync 3.0.51",
                    "traceId":"towntrip","method":"getWeighData",
                    "uuid":device.get("uuid",""),"cid":device.get("cid",""),
                    "configModule":device.get("configModule",""),
                    "pageNo":1,"pageSize":1}
            resp = post(VESYNC_API + "/cloud/v1/deviceManaged/fatScale/getWeighData", body, token, account_id)
            records = (resp.get("result") or {}).get("list") or []
            if records:
                rec = records[0]
                w_kg = rec.get("weight") or rec.get("bodyWeight")
                w_lbs = round(float(w_kg)*2.20462,1) if w_kg else None
                print("  Weight:", w_lbs, "lbs |", rec.get("measureTime","")[:19])
                if w_lbs:
                    s = sb_insert("weight_events", {
                        "measured_at": rec.get("measureTime") or now_iso,
                        "weight_kg": w_kg, "weight_lbs": w_lbs,
                        "body_fat_pct": rec.get("bodyFat") or rec.get("fatRate"),
                        "muscle_pct": rec.get("muscle") or rec.get("muscleRate"),
                        "bmi": rec.get("bmi"), "source": "vesync_api",
                        "scale_model": "EFS-A591S"
                    })
                    print("  Saved to Supabase HTTP", s)

    print("Done.")

if __name__ == "__main__":
    run()
