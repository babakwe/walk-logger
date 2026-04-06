#!/usr/bin/env python3
"""
vesync_poller.py - TownTrip VeSync device poller
Pulls Levoit Core 300S PM2.5 and Etekcity EFS-A591S weight data.
Run: python3 vesync_poller.py
Cron every 15 min:
  */15 * * * * python3 /Volumes/5TB1/TownTrip/vesync_poller.py >> /Volumes/5TB1/TownTrip/vesync_poll.log 2>&1
"""
import urllib.request, json, ssl, datetime, os, hashlib

VESYNC_EMAIL    = os.environ.get("VESYNC_EMAIL", "YOUR_VESYNC_EMAIL")
VESYNC_PASSWORD = os.environ.get("VESYNC_PASSWORD", "YOUR_VESYNC_PASSWORD")
VESYNC_TZ       = "America/New_York"
VESYNC_API      = "https://smartapi.vesync.com"
SK   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY2ODc1OCwiZXhwIjoyMDg4MjQ0NzU4fQ.jPRln_LQRrIGF5iA-H_DBsRW2FjPaf3ys5yBvy908eo"
BASE = "https://xyfyuvikqmxcazqgqoxb.supabase.co"
ctx  = ssl.create_default_context()

def vesync_post(path, body, token="", account_id=""):
    req = urllib.request.Request(
        VESYNC_API + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type":"application/json","User-Agent":"VeSync 3.0.51",
                 "Accept":"application/json","Accept-Language":"en",
                 "tk":token,"accountid":account_id},
        method="POST"
    )
    with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
        return json.loads(r.read())

def login():
    md5_pw = hashlib.md5(VESYNC_PASSWORD.encode()).hexdigest()
    resp = vesync_post("/cloud/v1/user/login", {
        "timeZone":VESYNC_TZ,"acceptLanguage":"en","appVersion":"VeSync 3.0.51",
        "phoneBrand":"SM N9005","phoneOS":"Android","traceId":"towntrip",
        "userType":"1","method":"login","email":VESYNC_EMAIL,
        "password":md5_pw,"devToken":""
    })
    result = resp.get("result") or {}
    token = result.get("token","")
    account_id = str(result.get("accountID",""))
    if not token:
        print("  Login failed:", resp.get("msg","unknown"))
        return None, None
    print("  Logged in. Account:", account_id)
    return token, account_id

def get_devices(token, account_id):
    resp = vesync_post("/cloud/v2/deviceManaged/devices", {
        "timeZone":VESYNC_TZ,"acceptLanguage":"en","appVersion":"VeSync 3.0.51",
        "phoneBrand":"SM N9005","phoneOS":"Android","traceId":"towntrip",
        "method":"devices","pageNo":1,"pageSize":100
    }, token, account_id)
    devices = (resp.get("result") or {}).get("list") or []
    for d in devices:
        print("  Device:", d.get("deviceName"), "|", d.get("deviceType"), "|", d.get("subDeviceNo",""))
    return devices

def get_purifier_status(token, account_id, device):
    """Try multiple API paths used by different Levoit models."""
    uuid = device.get("uuid","")
    cid = device.get("cid","")
    config = device.get("configModule","")
    dtype = (device.get("deviceType") or "").lower()

    paths = [
        "/131airpurifier/v1/device/devicedetail",
        "/cloud/v2/deviceManaged/bypassV2",
    ]
    for path in paths:
        try:
            body = {
                "timeZone":VESYNC_TZ,"acceptLanguage":"en","appVersion":"VeSync 3.0.51",
                "traceId":"towntrip","method":"getPurifierStatus",
                "uuid":uuid,"cid":cid,"configModule":config,
                "payload":{"method":"getPurifierStatus","source":"APP","data":{}}
            }
            resp = vesync_post(path, body, token, account_id)
            result = resp.get("result") or {}
            inner = result.get("result") or result
            pm25 = inner.get("airQuality") or inner.get("pm25") or inner.get("AQLevel")
            if pm25 is not None:
                return {
                    "pm25": pm25,
                    "level": inner.get("airQualityIndex") or inner.get("airQuality"),
                    "filter_life": inner.get("filterLife"),
                    "fan_level": inner.get("fanSpeedLevel") or inner.get("level"),
                    "is_on": inner.get("deviceStatus","") == "on" or inner.get("powerSwitch") == 1,
                    "auto_mode": inner.get("mode","") == "auto",
                }
        except Exception as e:
            continue
    return {}

def get_scale_weight(token, account_id, device):
    """Fetch latest weight measurement from scale."""
    try:
        body = {
            "timeZone":VESYNC_TZ,"acceptLanguage":"en","appVersion":"VeSync 3.0.51",
            "traceId":"towntrip","method":"getWeighData",
            "uuid":device.get("uuid",""),"cid":device.get("cid",""),
            "configModule":device.get("configModule",""),
            "pageNo":1,"pageSize":1
        }
        resp = vesync_post("/cloud/v1/deviceManaged/fatScale/getWeighData", body, token, account_id)
        records = (resp.get("result") or {}).get("list") or []
        if not records:
            # Try alternate endpoint
            resp2 = vesync_post("/cloud/v2/deviceManaged/fatScale/getWeighData", body, token, account_id)
            records = (resp2.get("result") or {}).get("list") or []
        if records:
            r = records[0]
            w_kg = r.get("weight") or r.get("bodyWeight")
            return {
                "weight_kg": w_kg,
                "weight_lbs": round(float(w_kg) * 2.20462, 1) if w_kg else None,
                "body_fat_pct": r.get("bodyFat") or r.get("fatRate"),
                "muscle_pct": r.get("muscle") or r.get("muscleRate"),
                "bmi": r.get("bmi"),
                "measured_at": r.get("measureTime") or r.get("createdTime"),
            }
    except Exception as e:
        print("  Scale error:", str(e)[:80])
    return {}

def sb_insert(table, row):
    req = urllib.request.Request(
        BASE + "/rest/v1/" + table,
        data=json.dumps(row).encode(), method="POST",
        headers={"apikey":SK,"Authorization":"Bearer "+SK,
                 "Content-Type":"application/json","Prefer":"return=minimal"}
    )
    with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
        return r.status

def run():
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    print("=== VeSync Poller", now_str, "===")
    token, account_id = login()
    if not token:
        return

    devices = get_devices(token, account_id)
    now_iso = datetime.datetime.now().isoformat()

    for device in devices:
        dtype = (device.get("deviceType") or "").lower()
        dname = device.get("deviceName") or dtype

        is_purifier = any(x in dtype for x in ["air","purifier","core","131","lv","lav"])
        is_scale    = any(x in dtype for x in ["scale","esf","efs","fat","weight","esm"])

        if is_purifier:
            print("Purifier:", dname, dtype)
            detail = get_purifier_status(token, account_id, device)
            if detail:
                s = sb_insert("indoor_air_quality", {
                    "recorded_at": now_iso,
                    "device_name": dname, "device_type": dtype,
                    "pm25_ugm3": detail.get("pm25"),
                    "air_quality_level": str(detail.get("level","")).strip() or None,
                    "filter_life_pct": detail.get("filter_life"),
                    "fan_level": detail.get("fan_level"),
                    "is_on": detail.get("is_on"),
                    "auto_mode": detail.get("auto_mode"),
                    "location": "home_bronx_10475"
                })
                print("  PM2.5:", detail.get("pm25"), "ug/m3 | HTTP", s)
            else:
                print("  No data returned (device may need different API path)")

        elif is_scale:
            print("Scale:", dname, dtype)
            data = get_scale_weight(token, account_id, device)
            if data and data.get("weight_lbs"):
                s = sb_insert("weight_events", {
                    "measured_at": data.get("measured_at") or now_iso,
                    "weight_kg": data.get("weight_kg"),
                    "weight_lbs": data.get("weight_lbs"),
                    "body_fat_pct": data.get("body_fat_pct"),
                    "muscle_pct": data.get("muscle_pct"),
                    "bmi": data.get("bmi"),
                    "source": "vesync_api",
                    "scale_model": "EFS-A591S"
                })
                print("  Weight:", data.get("weight_lbs"), "lbs | HTTP", s)
            else:
                print("  No weight data (step on scale to sync first)")

        else:
            print("Skipping:", dname, dtype)

    print("Done.")

if __name__ == "__main__":
    run()
