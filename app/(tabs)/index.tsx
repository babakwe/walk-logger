import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  Alert, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from "react-native";
import * as Location from "expo-location";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as TaskManager from "expo-task-manager";
import { useKeepAwake } from "expo-keep-awake";
import MapView, { Polyline, Marker, PROVIDER_DEFAULT } from "react-native-maps";

const LOCATION_TASK = "towntrip-background-location";
const ALCOTT_TRAIL  = { latitude: 40.8699, longitude: -73.8318 };
const LOG_FILE      = FileSystem.documentDirectory + "towntrip_trail_points.jsonl";
const AUTOSAVE_FILE = FileSystem.documentDirectory + "towntrip_session_autosave.json";
const AUTOSAVE_MS   = 60_000;
const TRIP_TYPES    = ["walk", "transit", "run"] as const;
type TripType = typeof TRIP_TYPES[number];

const WIND_DIRS = ["N","NE","E","SE","S","SW","W","NW"];
function degToDir(deg: number) { return WIND_DIRS[Math.round(deg / 45) % 8]; }

type GpsPoint = {
  timestamp_ms: number; iso_time: string; latitude: number; longitude: number;
  altitude: number | null; accuracy: number | null; speed_mps: number | null;
  heading: number | null; heart_rate: number | null; wind_speed_mps: number | null;
};
type Weather = { temp_c: number; wind_kph: number; wind_dir_deg: number; gust_kph: number; fetched_at: number; };

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }: any) => {
  if (error) { console.log("BG task error:", error); return; }
  const locations = data?.locations ?? [];
  if (!locations.length) return;
  const lines = locations.map((loc: any) => {
    const p: GpsPoint = {
      timestamp_ms: loc.timestamp ?? Date.now(),
      iso_time:     new Date(loc.timestamp ?? Date.now()).toISOString(),
      latitude:     loc.coords?.latitude, longitude: loc.coords?.longitude,
      altitude:     loc.coords?.altitude ?? null, accuracy: loc.coords?.accuracy ?? null,
      speed_mps:    loc.coords?.speed ?? null, heading: loc.coords?.heading ?? null,
      heart_rate: null, wind_speed_mps: null,
    };
    return JSON.stringify(p);
  }).join("\n") + "\n";
  try {
    const info = await FileSystem.getInfoAsync(LOG_FILE);
    if (info.exists) {
      const prev = await FileSystem.readAsStringAsync(LOG_FILE);
      await FileSystem.writeAsStringAsync(LOG_FILE, prev + lines);
    } else { await FileSystem.writeAsStringAsync(LOG_FILE, lines); }
  } catch (e) { console.log("Write failed:", e); }
});

export default function WalkLoggerScreen() {
  useKeepAwake();
  const mapRef = useRef<MapView>(null);
  const [running, setRunning]       = useState(false);
  const [trail, setTrail]           = useState<GpsPoint[]>([]);
  const [currentPos, setCurrentPos] = useState<GpsPoint | null>(null);
  const [elapsed, setElapsed]       = useState(0);
  const [pointCount, setPointCount] = useState(0);
  const [note, setNote]             = useState("");
  const [tripType, setTripType]     = useState<TripType>("walk");
  const [weather, setWeather]       = useState<Weather | null>(null);
  const [heartRate, setHeartRate]   = useState<number | null>(null);
  const [lidarAlt, setLidarAlt]     = useState<number | null>(null);
  const [sessionName] = useState(
    "walk_" + new Date().toISOString().slice(0,16).replace("T","_").replace(":","h")
  );
  const fgWatchRef   = useRef<Location.LocationSubscription | null>(null);
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const autosaveRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const weatherPoll  = useRef<ReturnType<typeof setInterval> | null>(null);
  const trailRef     = useRef<GpsPoint[]>([]);
  const elapsedRef   = useRef(0);
  const weatherRef   = useRef<Weather | null>(null);
  const heartRateRef = useRef<number | null>(null);

  const fetchWeather = useCallback(async (lat: number, lon: number) => {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kmh&timezone=auto`;
      const data = await fetch(url).then(r => r.json());
      const c = data?.current;
      if (!c) return;
      const w: Weather = {
        temp_c: Math.round(c.temperature_2m ?? 0), wind_kph: Math.round(c.wind_speed_10m ?? 0),
        wind_dir_deg: c.wind_direction_10m ?? 0, gust_kph: Math.round(c.wind_gusts_10m ?? 0),
        fetched_at: Date.now(),
      };
      setWeather(w); weatherRef.current = w;
    } catch (e) { console.log("Weather:", e); }
  }, []);

  const tryLiDAR = useCallback(() => {
    try {
      const LiDAR = (global as any).WalkLoggerLiDAR;
      if (!LiDAR) return;
      LiDAR.startSession((alt: number) => setLidarAlt(alt));
    } catch (_) {}
  }, []);

  useEffect(() => {
    (async () => {
      const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
      setRunning(started);
      if (started) startForegroundWatch();
      await syncTrailFromFile();
      fetchWeather(ALCOTT_TRAIL.latitude, ALCOTT_TRAIL.longitude);
      tryLiDAR();
      try {
        const info = await FileSystem.getInfoAsync(AUTOSAVE_FILE);
        if (info.exists) {
          const saved = JSON.parse(await FileSystem.readAsStringAsync(AUTOSAVE_FILE));
          if (saved?.points?.length > 0) {
            Alert.alert("Unsaved walk found",
              `${saved.points.length} points from ${saved.autosaved_at}. Recover it?`,
              [{ text: "Recover & Export", onPress: async () => {
                  trailRef.current = saved.points; setTrail(saved.points); setPointCount(saved.points.length);
                  setNote(saved.note ?? ""); setTripType(saved.trip_type ?? "walk");
                  await exportGeoJSON(saved.points, saved.note ?? "", saved.trip_type ?? "walk", saved.elapsed ?? 0);
                  await FileSystem.deleteAsync(AUTOSAVE_FILE, { idempotent: true });
                }},
                { text: "Discard", style: "destructive", onPress: () => FileSystem.deleteAsync(AUTOSAVE_FILE, { idempotent: true }) }
              ]);
          }
        }
      } catch (_) {}
    })();
    return () => cleanup();
  }, []);

  useEffect(() => {
    if (running) {
      timerRef.current = setInterval(() => { elapsedRef.current += 1; setElapsed(e => e + 1); }, 1000);
    } else { if (timerRef.current) clearInterval(timerRef.current); }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [running]);

  const cleanup = () => {
    fgWatchRef.current?.remove();
    [timerRef, autosaveRef, weatherPoll].forEach(r => { if (r.current) clearInterval(r.current); });
  };

  const syncTrailFromFile = async () => {
    try {
      const info = await FileSystem.getInfoAsync(LOG_FILE);
      if (!info.exists) return;
      const raw = await FileSystem.readAsStringAsync(LOG_FILE);
      const points = raw.trim().split("\n").filter(Boolean)
        .map(l => { try { return JSON.parse(l) as GpsPoint; } catch { return null; } })
        .filter(Boolean) as GpsPoint[];
      trailRef.current = points; setTrail(points); setPointCount(points.length);
      if (points.length) setCurrentPos(points[points.length - 1]);
    } catch (e) { console.log("Sync error:", e); }
  };

  const startAutosave = (n: string, tt: TripType) => {
    if (autosaveRef.current) clearInterval(autosaveRef.current);
    autosaveRef.current = setInterval(async () => {
      try {
        await FileSystem.writeAsStringAsync(AUTOSAVE_FILE, JSON.stringify({
          session: sessionName, points: trailRef.current, note: n, trip_type: tt,
          elapsed: elapsedRef.current, autosaved_at: new Date().toLocaleTimeString(),
        }));
      } catch (_) {}
    }, AUTOSAVE_MS);
  };

  const startForegroundWatch = async () => {
    fgWatchRef.current?.remove();
    fgWatchRef.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
      (loc) => {
        const w = weatherRef.current;
        const p: GpsPoint = {
          timestamp_ms: loc.timestamp, iso_time: new Date(loc.timestamp).toISOString(),
          latitude: loc.coords.latitude, longitude: loc.coords.longitude,
          altitude: loc.coords.altitude ?? null, accuracy: loc.coords.accuracy ?? null,
          speed_mps: loc.coords.speed ?? null, heading: loc.coords.heading ?? null,
          heart_rate: heartRateRef.current,
          wind_speed_mps: w ? w.wind_kph / 3.6 : null,
        };
        setCurrentPos(p);
        setTrail(prev => { const next = [...prev, p]; trailRef.current = next; setPointCount(next.length); return next; });
        mapRef.current?.animateCamera({ center: { latitude: p.latitude, longitude: p.longitude }, zoom: 18 }, { duration: 500 });
      }
    );
  };

  const handleStart = async () => {
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== "granted") { Alert.alert("Permission needed", "Foreground location required."); return; }
      const bg = await Location.requestBackgroundPermissionsAsync();
      if (bg.status !== "granted") { Alert.alert("Permission needed", "Settings â Privacy â Location Services â Walk Logger â Always."); return; }
      await FileSystem.deleteAsync(LOG_FILE, { idempotent: true });
      trailRef.current = []; setTrail([]); setPointCount(0); setElapsed(0); elapsedRef.current = 0;
      await Location.startLocationUpdatesAsync(LOCATION_TASK, {
        accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0,
        pausesUpdatesAutomatically: false, showsBackgroundLocationIndicator: true,
      });
      await startForegroundWatch();
      startAutosave(note, tripType);
      if (currentPos) {
        fetchWeather(currentPos.latitude, currentPos.longitude);
        weatherPoll.current = setInterval(() => fetchWeather(currentPos.latitude, currentPos.longitude), 30*1000);
      }
      setRunning(true);
    } catch (e: any) { Alert.alert("Start failed", String(e)); }
  };

  const handleStop = async () => {
    try {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
      fgWatchRef.current?.remove();
      [autosaveRef, weatherPoll].forEach(r => { if (r.current) clearInterval(r.current); });
      setRunning(false);
      await syncTrailFromFile();
    } catch (e: any) { Alert.alert("Stop failed", String(e)); }
  };

  const exportGeoJSON = async (points: GpsPoint[], expNote: string, expType: string, expElapsed: number) => {
    if (!points.length) { Alert.alert("No data", "Record a walk first."); return; }
    const geojson = {
      type: "FeatureCollection",
      properties: { session: sessionName, points: points.length, duration_sec: expElapsed,
        exported_at: new Date().toISOString(), source: "towntrip-walk-logger",
        note: expNote.trim(), trip_type: expType },
      features: [
        { type: "Feature",
          geometry: { type: "LineString", coordinates: points.map(p => [p.longitude, p.latitude, p.altitude ?? 0]) },
          properties: { session: sessionName, start: points[0]?.iso_time, end: points[points.length-1]?.iso_time, points: points.length } },
        ...points.map((p, i) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [p.longitude, p.latitude, p.altitude ?? 0] },
          properties: { i, timestamp_ms: p.timestamp_ms, iso_time: p.iso_time, accuracy: p.accuracy,
            speed_mps: p.speed_mps, heading: p.heading, heart_rate: p.heart_rate,
            wind_speed_mps: p.wind_speed_mps, is_stopped: p.speed_mps !== null && p.speed_mps >= 0 && p.speed_mps < 0.3 },
        })),
      ],
    };
    const outPath = FileSystem.documentDirectory + sessionName + ".geojson";
    await FileSystem.writeAsStringAsync(outPath, JSON.stringify(geojson, null, 2));
    await Sharing.shareAsync(outPath);
    await FileSystem.deleteAsync(AUTOSAVE_FILE, { idempotent: true });
  };

  const handleExport = async () => {
    try { await exportGeoJSON(trail, note, tripType, elapsed); }
    catch (e: any) { Alert.alert("Export failed", String(e)); }
  };

  const formatTime = (s: number) => Math.floor(s/60).toString().padStart(2,"0") + ":" + (s%60).toString().padStart(2,"0");
  const speedKmh   = currentPos?.speed_mps != null ? (currentPos.speed_mps * 3.6).toFixed(1) : "--";
  const trailCoords = trail.map(p => ({ latitude: p.latitude, longitude: p.longitude }));
  const windLabel  = weather ? `${weather.wind_kph} km/h ${degToDir(weather.wind_dir_deg)}` : "--";
  const gustExtra  = weather && weather.gust_kph > weather.wind_kph + 5 ? ` â${weather.gust_kph}` : "";

  return (
    <View style={styles.container}>
      <MapView ref={mapRef} style={styles.map} provider={PROVIDER_DEFAULT}
        initialRegion={{ latitude: ALCOTT_TRAIL.latitude, longitude: ALCOTT_TRAIL.longitude, latitudeDelta: 0.004, longitudeDelta: 0.004 }}
        showsUserLocation showsTraffic showsCompass mapType="hybrid">
        {trailCoords.length > 1 && <Polyline coordinates={trailCoords} strokeColor="#00E5FF" strokeWidth={4} />}
        {currentPos && <Marker coordinate={{ latitude: currentPos.latitude, longitude: currentPos.longitude }} anchor={{ x: 0.5, y: 0.5 }}><View style={styles.dot} /></Marker>}
      </MapView>

      {weather && (
        <View style={styles.weatherBar}>
          <Text style={styles.weatherItem}>ð¡ {weather.temp_c}Â°C</Text>
          <Text style={styles.weatherItem}>ð¨ {windLabel}{gustExtra}</Text>
          {lidarAlt !== null && <Text style={styles.weatherItem}>â° {lidarAlt.toFixed(1)}m</Text>}
        </View>
      )}

      <View style={styles.statsBar}>
        <View style={styles.stat}><Text style={styles.statVal}>{formatTime(elapsed)}</Text><Text style={styles.statLabel}>TIME</Text></View>
        <View style={styles.stat}><Text style={styles.statVal}>{pointCount}</Text><Text style={styles.statLabel}>POINTS</Text></View>
        <View style={styles.stat}><Text style={styles.statVal}>{speedKmh}</Text><Text style={styles.statLabel}>KM/H</Text></View>
        <View style={styles.stat}>
          <Text style={styles.statVal}>{heartRate !== null ? heartRate : (currentPos?.altitude != null ? currentPos.altitude.toFixed(0)+"m" : "--")}</Text>
          <Text style={styles.statLabel}>{heartRate !== null ? "BPM" : "ALT"}</Text>
        </View>
      </View>

      <View style={styles.sessionBar}>
        <View style={[styles.statusDot, { backgroundColor: running ? "#4CAF50" : "#555" }]} />
        <Text style={styles.sessionText} numberOfLines={1}>{sessionName}</Text>
        <Text style={styles.tripLabel}>{tripType}</Text>
      </View>

      {!running && (
        <View style={styles.tripRow}>
          {TRIP_TYPES.map(t => (
            <Pressable key={t} style={[styles.tripBtn, tripType===t && styles.tripBtnActive]} onPress={() => setTripType(t)}>
              <Text style={[styles.tripBtnText, tripType===t && styles.tripBtnTextActive]}>{t}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <TextInput style={styles.noteInput} placeholder="Session note" placeholderTextColor="#444"
        value={note} onChangeText={setNote} multiline />

      <View style={styles.controls}>
        {!running
          ? <Pressable style={[styles.btn, styles.btnStart]} onPress={handleStart}><Text style={styles.btnText}>â¶  START</Text></Pressable>
          : <Pressable style={[styles.btn, styles.btnStop]}  onPress={handleStop}><Text style={styles.btnText}>â   STOP</Text></Pressable>
        }
        <Pressable style={[styles.btn, styles.btnExport, trail.length===0 && styles.btnDisabled]} onPress={handleExport} disabled={trail.length===0}>
          <Text style={styles.btnText}>â  EXPORT</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container:         { flex: 1, backgroundColor: "#0A0A0A" },
  map:               { flex: 1 },
  dot:               { width: 16, height: 16, borderRadius: 8, backgroundColor: "#00E5FF", borderWidth: 3, borderColor: "#fff" },
  weatherBar:        { flexDirection: "row", alignItems: "center", justifyContent: "space-around", backgroundColor: "#0D1117", paddingVertical: 6, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: "#1A2030" },
  weatherItem:       { color: "#A0B8D0", fontSize: 12, fontWeight: "500" },
  statsBar:          { flexDirection: "row", backgroundColor: "#0A0A0A", paddingVertical: 12, paddingHorizontal: 8, borderTopWidth: 1, borderTopColor: "#1E1E1E" },
  stat:              { flex: 1, alignItems: "center" },
  statVal:           { color: "#FFFFFF", fontSize: 22, fontWeight: "700" },
  statLabel:         { color: "#666", fontSize: 10, marginTop: 2, letterSpacing: 1 },
  sessionBar:        { flexDirection: "row", alignItems: "center", backgroundColor: "#111", paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  statusDot:         { width: 8, height: 8, borderRadius: 4 },
  sessionText:       { color: "#888", fontSize: 12, flex: 1, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  tripLabel:         { color: "#00E5FF", fontSize: 11, fontWeight: "600", letterSpacing: 1 },
  tripRow:           { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: "#0A0A0A" },
  tripBtn:           { flex: 1, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: "#2a2a2a", alignItems: "center" },
  tripBtnActive:     { borderColor: "#00E5FF", backgroundColor: "#00E5FF18" },
  tripBtnText:       { color: "#555", fontSize: 12, fontWeight: "600", letterSpacing: 0.5 },
  tripBtnTextActive: { color: "#00E5FF" },
  noteInput:         { backgroundColor: "#111", color: "#ccc", fontSize: 12, paddingHorizontal: 16, paddingVertical: 10, minHeight: 40, borderTopWidth: 1, borderTopColor: "#1E1E1E" },
  controls:          { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingBottom: 36, paddingTop: 12, backgroundColor: "#0A0A0A" },
  btn:               { flex: 1, paddingVertical: 16, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  btnStart:          { backgroundColor: "#00C853" },
  btnStop:           { backgroundColor: "#D50000" },
  btnExport:         { backgroundColor: "#0288D1" },
  btnDisabled:       { opacity: 0.4 },
  btnText:           { color: "#fff", fontSize: 15, fontWeight: "700", letterSpacing: 0.5 },
});
