import urllib.request, json, ssl, time, datetime, subprocess

SK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY2ODc1OCwiZXhwIjoyMDg4MjQ0NzU4fQ.jPRln_LQRrIGF5iA-H_DBsRW2FjPaf3ys5yBvy908eo"
BASE = "https://xyfyuvikqmxcazqgqoxb.supabase.co"
G_KEY = "AIzaSyCvX9TTFYBTSNT3G5A2X8bOEJOH24f2XFc"
T_KEY = "ySXzP8sbYZCJasBtAzaSFBaFR0K22bJiNJJLkp8I"
ctx = ssl.create_default_context()

LOCATIONS = [
    ("bronx_10475", 40.8699, -73.8318),
    ("bronx_10458", 40.8590, -73.8900),
    ("bronx_10463", 40.8815, -73.9146),
]

def sb_post(row):
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

def fetch_weather(lat, lon):
    try:
        url = ("https://api.tomorrow.io/v4/weather/realtime"
               + "?location=" + str(lat) + "," + str(lon)
               + "&fields=temperature,windSpeed,windDirection,humidity,precipitationProbability"
               + "&units=metric&apikey=" + T_KEY)
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, context=ctx, timeout=15) as r:
            d = json.loads(r.read())
        return d.get("data", {}).get("values", {})
    except Exception as e:
        print("    weather ERR: " + str(e)[:40])
        return {}

def fetch_pollencom():
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
            return (data.get("Location") or {}).get("periods") or []
    except Exception as e:
        print("    pollencom ERR: " + str(e)[:40])
    return []

def run_daily_poller():
    print("Running daily pollen poller - " + str(datetime.date.today()))
    today = str(datetime.date.today())
    ok = 0; skip = 0

    for name, lat, lon in LOCATIONS:
        print("  Fetching Google Pollen + weather: " + name)
        wx = fetch_weather(lat, lon)
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
                row = {"date": dt, "location_name": name,
                       "lat": lat, "lon": lon,
                       "tree_upi": gu("TREE"), "grass_upi": gu("GRASS"), "weed_upi": gu("WEED"),
                       "dominant_type": dom, "dominant_upi": domv or None,
                       "source": "google_pollen"}
                if dt == today and wx:
                    row["temp_c"] = wx.get("temperature")
                    row["wind_kph"] = wx.get("windSpeed")
                    row["wind_dir_deg"] = wx.get("windDirection")
                    row["humidity_pct"] = wx.get("humidity")
                    row["precip_prob"] = wx.get("precipitationProbability")
                status = sb_post(row)
                if status in (200, 201): ok += 1
                elif status == 409: skip += 1
                else: print("    row ERR " + dt + ": HTTP " + str(status))
            print("    done")
        except Exception as e:
            print("    fetch ERR: " + str(e)[:60])
        time.sleep(1)

    print("  Google: " + str(ok) + " new, " + str(skip) + " already existed")

    print("  Fetching pollen.com (curl)...")
    periods = fetch_pollencom()
    pc_ok = 0
    for p in periods:
        dt = p.get("Period", "")[:10]
        idx = p.get("Index")
        if dt and idx is not None:
            status = sb_post({"date": dt, "location_name": "bronx_10475_pollencom",
                              "lat": 40.8699, "lon": -73.8318,
                              "tree_upi": None, "grass_upi": None, "weed_upi": None,
                              "dominant_upi": idx, "dominant_type": None, "source": "pollen_com"})
            if status in (200, 201): pc_ok += 1
    print("  pollen.com: " + str(len(periods)) + " periods, " + str(pc_ok) + " new")
    print("Daily poll complete.")

if __name__ == "__main__":
    run_daily_poller()
