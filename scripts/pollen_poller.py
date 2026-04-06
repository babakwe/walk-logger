import urllib.request, json, ssl, time, datetime, subprocess

SK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY2ODc1OCwiZXhwIjoyMDg4MjQ0NzU4fQ.jPRln_LQRrIGF5iA-H_DBsRW2FjPaf3ys5yBvy908eo"
BASE = "https://xyfyuvikqmxcazqgqoxb.supabase.co"
G_KEY = "AIzaSyCvX9TTFYBTSNT3G5A2X8bOEJOH24f2XFc"
VC_KEY = "H35YUX7UTVE47Z58Q22EYLLZ6"
ctx = ssl.create_default_context()

LOCATIONS = [
    ("bronx_10475", 40.8699, -73.8318),
    ("bronx_10458", 40.8590, -73.8900),
    ("bronx_10463", 40.8815, -73.9146),
]

def upsert_row(row):
    body = json.dumps(row).encode()
    req = urllib.request.Request(
        BASE + "/rest/v1/pollen_history", data=body, method="POST",
        headers={"apikey": SK, "Authorization": "Bearer " + SK,
                 "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code

def fetch_visual_crossing(lat, lon, date_str):
    """Fetch hourly weather from Visual Crossing for the given date.
    Returns dict with: precip_mm, precip_hours, solar_radiation, humidity,
    wind_kph, temp_c, conditions — all averaged/summed for the day."""
    try:
        url = (f"https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline"
               f"/{lat},{lon}/{date_str}/{date_str}"
               f"?unitGroup=metric&include=hours&key={VC_KEY}&contentType=json")
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, context=ctx, timeout=20) as r:
            data = json.loads(r.read())
        day = (data.get("days") or [{}])[0]
        hours = day.get("hours") or []
        # Rain decay model inputs
        precip_mm = day.get("precip") or 0
        precip_hours = sum(1 for h in hours if (h.get("precip") or 0) > 0)
        last_rain_hour = None
        for h in reversed(hours):
            if (h.get("precip") or 0) > 0:
                last_rain_hour = int(h.get("datetime","00:00:00")[:2])
                break
        # Pollen dispersion inputs
        solar_rad = day.get("solarradiation")  # W/m2
        humidity = day.get("humidity")
        wind_kph = day.get("windspeed")
        wind_dir = day.get("winddir")
        temp_c = day.get("temp")
        conditions = day.get("conditions","")
        return {
            "precip_mm": precip_mm,
            "precip_hours": precip_hours,
            "last_rain_hour": last_rain_hour,
            "solar_radiation": solar_rad,
            "humidity_pct": humidity,
            "wind_kph": wind_kph,
            "wind_dir_deg": wind_dir,
            "temp_c": temp_c,
            "conditions": conditions[:80] if conditions else None,
        }
    except Exception as e:
        print("    VC ERR: " + str(e)[:60])
        return {}

def run_daily_poller():
    print("Running daily pollen poller - " + str(datetime.date.today()))
    today = str(datetime.date.today())
    ok = 0; skip = 0

    # Fetch Visual Crossing weather once for primary location (10475)
    print("  Fetching Visual Crossing weather...")
    wx = fetch_visual_crossing(40.8699, -73.8318, today)
    if wx:
        precip = wx.get("precip_mm", 0) or 0
        solar = wx.get("solar_radiation")
        humidity = wx.get("humidity_pct")
        print(f"    Precip: {precip}mm | Solar: {solar} W/m2 | Humidity: {humidity}% | Wind: {wx.get('wind_kph')} km/h")
        print(f"    Conditions: {wx.get('conditions','?')}")
        # Store weather context in pollen_history weather columns
        wx_update = {
            "date": today, "location_name": "bronx_10475_weather",
            "lat": 40.8699, "lon": -73.8318,
            "tree_upi": None, "grass_upi": None, "weed_upi": None,
            "dominant_type": wx.get("conditions"),
            "source": "visual_crossing",
            "temp_c": wx.get("temp_c"),
            "wind_kph": wx.get("wind_kph"),
            "wind_dir_deg": wx.get("wind_dir_deg"),
            "humidity_pct": wx.get("humidity_pct"),
            "precip_prob": precip,
        }
        s = upsert_row(wx_update)
        print("    Saved weather row HTTP", s)

    for name, lat, lon in LOCATIONS:
        print("  Fetching Google Pollen: " + name)
        try:
            url = ("https://pollen.googleapis.com/v1/forecast:lookup"
                   + "?key=" + G_KEY
                   + "&location.latitude=" + str(lat)
                   + "&location.longitude=" + str(lon)
                   + "&days=5")
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
                d = json.loads(r.read())
            for day in (d.get("dailyInfo") or []):
                dt = (str(day["date"]["year"]) + "-"
                      + str(day["date"]["month"]).zfill(2) + "-"
                      + str(day["date"]["day"]).zfill(2))
                def gu(code, info=day):
                    for p in (info.get("pollenTypeInfo") or []):
                        if p.get("code") == code:
                            return (p.get("indexInfo") or {}).get("value")
                    return None
                dom = None; domv = 0
                for p in (day.get("pollenTypeInfo") or []):
                    v = (p.get("indexInfo") or {}).get("value") or 0
                    if v > domv:
                        domv = v; dom = p.get("displayName")
                row = {
                    "date": dt, "location_name": name,
                    "lat": lat, "lon": lon,
                    "tree_upi": gu("TREE"), "grass_upi": gu("GRASS"), "weed_upi": gu("WEED"),
                    "dominant_type": dom, "dominant_upi": domv or None,
                    "source": "google_pollen"
                }
                # Attach today's weather context to today's pollen row
                if dt == today and wx:
                    row["temp_c"] = wx.get("temp_c")
                    row["wind_kph"] = wx.get("wind_kph")
                    row["wind_dir_deg"] = wx.get("wind_dir_deg")
                    row["humidity_pct"] = wx.get("humidity_pct")
                    row["precip_prob"] = wx.get("precip_mm") or 0
                status = upsert_row(row)
                if status in (200, 201): ok += 1
                elif status == 409: skip += 1
                else: print("    row ERR " + dt + ": HTTP " + str(status))
            print("    done")
        except Exception as e:
            print("    fetch ERR: " + str(e)[:60])
        time.sleep(1)

    print("  Google: " + str(ok) + " new, " + str(skip) + " already existed")

    # pollen.com via curl
    print("  Fetching pollen.com (curl)...")
    try:
        cmd = ["curl", "-s",
               "-H", "Accept: application/json",
               "-H", "Referer: https://www.pollen.com/forecast/historic/pollen/10475",
               "-H", "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
               "-H", "X-Requested-With: XMLHttpRequest",
               "https://www.pollen.com/api/forecast/historic/pollen/10475"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode == 0 and result.stdout.strip():
            data = json.loads(result.stdout)
            periods = (data.get("Location") or {}).get("periods") or []
            pc_ok = 0
            for p in periods:
                dt = p.get("Period","")[:10]
                idx = p.get("Index")
                if dt and idx is not None:
                    s = upsert_row({"date": dt, "location_name": "bronx_10475_pollencom",
                                    "lat": 40.8699, "lon": -73.8318,
                                    "tree_upi": None, "grass_upi": None, "weed_upi": None,
                                    "dominant_upi": idx, "source": "pollen_com"})
                    if s in (200, 201): pc_ok += 1
            print("  pollen.com: " + str(len(periods)) + " periods, " + str(pc_ok) + " new")
    except Exception as e:
        print("  pollen.com ERR: " + str(e)[:60])

    print("Daily poll complete.")

if __name__ == "__main__":
    run_daily_poller()
