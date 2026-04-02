import React, { useEffect, useRef, useState, useCallback } from "react";
import { Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as Location from "expo-location";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as TaskManager from "expo-task-manager";
import { useKeepAwake } from "expo-keep-awake";
import MapView, { Polyline, Marker, PROVIDER_DEFAULT } from "react-native-maps";
import { useMotionSensors } from "../../hooks/useMotionSensors";
import { useHealthKit } from "../../hooks/useHealthKit";
import { useBLE } from "../../hooks/useBLE";

const LOCATION_TASK = "towntrip-background-location";
const ALCOTT_TRAIL = { latitude: 40.8699, longitude: -73.8318 };
const LOG_FILE = FileSystem.documentDirectory + "towntrip_trail_points.jsonl";
const AUTOSAVE_FILE = FileSystem.documentDirectory + "towntrip_session_autosave.json";
const AUTOSAVE_MS = 60000;
const TRIP_TYPES = ["walk", "transit", "run"] as const;
type TripType = typeof TRIP_TYPES[number];
const WIND_DIRS = ["N","NE","E","SE","S","SW","W","NW"];
function degToDir(deg: number) { return WIND_DIRS[Math.round(deg / 45) % 8]; }
function pollenEmoji(upi: number | null): string { if (upi === null) return "🌿"; if (upi === 0) return "✅"; if (upi <= 1) return "🟢"; if (upi <= 2) return "🟡"; if (upi <= 3) return "🟠"; if (upi <= 4) return "🔴"; return "🟣"; }
function tempEmoji(c: number | null): string { if (c === null) return "🌡️"; if (c <= 0) return "🥶"; if (c <= 10) return "🧥"; if (c <= 18) return "🌤️"; if (c <= 25) return "☀️"; if (c <= 32) return "🥵"; return "🔥"; }
function windEmoji(kph: number | null): string { if (kph === null) return "🌬️"; if (kph < 5) return "🍃"; if (kph < 20) return "💨"; if (kph < 40) return "🌬️"; return "🌪️"; }
function hrEmoji(bpm: number | null): string { if (bpm === null) return "💓"; if (bpm < 60) return "😴"; if (bpm < 90) return "🚶"; if (bpm < 120) return "🏃"; if (bpm < 150) return "⚡"; return "🔥"; }
function spo2Emoji(pct: number | null): string { if (pct === null) return "🩸"; if (pct >= 97) return "✅"; if (pct >= 94) return "🟡"; return "🔴"; }

type GpsPoint = {
    timestamp_ms: number; iso_time: string; latitude: number; longitude: number;
    altitude: number|null; accuracy: number|null; speed_mps: number|null; heading: number|null;
    ble_hr: number|null; ble_rr: number[]|null; ble_battery: number|null;
    accel_x: number|null; accel_y: number|null; accel_z: number|null;
    gyro_x: number|null; gyro_y: number|null; gyro_z: number|null;
    mag_x: number|null; mag_y: number|null; mag_z: number|null;
    pitch: number|null; roll: number|null; yaw: number|null;
    user_accel_x: number|null; user_accel_y: number|null; user_accel_z: number|null;
    pressure_hpa: number|null; pressure_alt_m: number|null; cadence_spm: number|null;
    hk_hr: number|null; hk_hrv: number|null; hk_temp_c: number|null; hk_spo2: number|null; hk_cal: number|null;
    wind_speed_mps: number|null; temp_c: number|null;
    pollen_tree_upi: number|null; pollen_grass_upi: number|null; pollen_weed_upi: number|null;
};
type Weather = { temp_c: number; wind_kph: number; wind_dir_deg: number; gust_kph: number; fetched_at: number; };
type Pollen = { tree_upi: number|null; grass_upi: number|null; weed_upi: number|null; dominant: string|null; fetched_at: number; };
const POLLEN_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_POLLEN_KEY ?? "";

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }: any) => {
    if (error) return;
    const locations = data?.locations ?? [];
    if (!locations.length) return;
    const lines = locations.map((loc: any) => JSON.stringify({ timestamp_ms: loc.timestamp ?? Date.now(), iso_time: new Date(loc.timestamp ?? Date.now()).toISOString(), latitude: loc.coords?.latitude, longitude: loc.coords?.longitude, altitude: loc.coords?.altitude ?? null, accuracy: loc.coords?.accuracy ?? null, speed_mps: loc.coords?.speed ?? null, heading: loc.coords?.heading ?? null })).join("\n") + "\n";
    try { const info = await FileSystem.getInfoAsync(LOG_FILE); const prev = info.exists ? await FileSystem.readAsStringAsync(LOG_FILE) : ""; await FileSystem.writeAsStringAsync(LOG_FILE, prev + lines); } catch {}
});

export default function WalkLoggerScreen() {
    useKeepAwake();
    const mapRef = useRef<MapView>(null);
    const [running, setRunning] = useState(false);
    const [trail, setTrail] = useState<GpsPoint[]>([]);
    const [currentPos, setCurrentPos] = useState<GpsPoint|null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [pointCount, setPointCount] = useState(0);
    const [note, setNote] = useState("");
    const [tripType, setTripType] = useState<TripType>("walk");
    const [weather, setWeather] = useState<Weather|null>(null);
    const [pollen, setPollen] = useState<Pollen|null>(null);
    const [showInner, setShowInner] = useState(false);
    const [sessionName] = useState("walk_" + new Date().toISOString().slice(0,16).replace("T","_").replace(":","h"));
    const { snapshot: motionSnapshot, available: sensorAvail } = useMotionSensors(running);
    const { getSnapshot: healthSnap, snapshot: hkData } = useHealthKit(running);
    const { state: bleState, rescan: bleRescan } = useBLE(running);
    const fgWatchRef = useRef<Location.LocationSubscription|null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval>|null>(null);
    const autosaveRef = useRef<ReturnType<typeof setInterval>|null>(null);
    const weatherPoll = useRef<ReturnType<typeof setInterval>|null>(null);
    const trailRef = useRef<GpsPoint[]>([]);
    const elapsedRef = useRef(0);
    const weatherRef = useRef<Weather|null>(null);
    const pollenRef = useRef<Pollen|null>(null);
    const bleRef = useRef(bleState);
    useEffect(() => { bleRef.current = bleState; }, [bleState]);

  const fetchWeather = useCallback(async (lat: number, lon: number) => {
        try {
                const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kmh&timezone=auto`;
                const data = await fetch(url).then(r => r.json());
                const c = data?.current; if (!c) return;
                const w: Weather = { temp_c: Math.round(c.temperature_2m ?? 0), wind_kph: Math.round(c.wind_speed_10m ?? 0), wind_dir_deg: c.wind_direction_10m ?? 0, gust_kph: Math.round(c.wind_gusts_10m ?? 0), fetched_at: Date.now() };
                setWeather(w); weatherRef.current = w;
        } catch {}
  }, []);

  const fetchPollen = useCallback(async (lat: number, lon: number) => {
        if (!POLLEN_API_KEY) return;
        try {
                const url = `https://pollen.googleapis.com/v1/forecast:lookup?key=${POLLEN_API_KEY}&location.longitude=${lon}&location.latitude=${lat}&days=1`;
                const data = await fetch(url).then(r => r.json());
                const daily = data?.dailyInfo?.[0]; if (!daily) return;
                const getType = (code: string) => daily.pollenTypeInfo?.find((p: any) => p.code === code)?.indexInfo?.value ?? null;
                const pl: Pollen = { tree_upi: getType("TREE"), grass_upi: getType("GRASS"), weed_upi: getType("WEED"), dominant: daily.pollenTypeInfo?.reduce((best: any, p: any) => (p.indexInfo?.value ?? 0) > (best?.indexInfo?.value ?? 0) ? p : best, null)?.displayName ?? null, fetched_at: Date.now() };
                setPollen(pl); pollenRef.current = pl;
        } catch {}
  }, []);

  useEffect(() => {
        (async () => {
                const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
                setRunning(started); if (started) startForegroundWatch();
                await syncTrailFromFile();
                fetchWeather(ALCOTT_TRAIL.latitude, ALCOTT_TRAIL.longitude);
                fetchPollen(ALCOTT_TRAIL.latitude, ALCOTT_TRAIL.longitude);
        })();
        return () => cleanup();
  }, []);

  useEffect(() => { if (running) { timerRef.current = setInterval(() => { elapsedRef.current += 1; setElapsed(e => e + 1); }, 1000); } else { if (timerRef.current) clearInterval(timerRef.current); } return () => { if (timerRef.current) clearInterval(timerRef.current); }; }, [running]);
    const cleanup = () => { fgWatchRef.current?.remove(); [timerRef, autosaveRef, weatherPoll].forEach(r => { if (r.current) clearInterval(r.current); }); };
    const syncTrailFromFile = async () => { try { const info = await FileSystem.getInfoAsync(LOG_FILE); if (!info.exists) return; const points = (await FileSystem.readAsStringAsync(LOG_FILE)).trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l) as GpsPoint; } catch { return null; } }).filter(Boolean) as GpsPoint[]; trailRef.current = points; setTrail(points); setPointCount(points.length); if (points.length) setCurrentPos(points[points.length - 1]); } catch {} };
    const startAutosave = (n: string, tt: TripType) => { if (autosaveRef.current) clearInterval(autosaveRef.current); autosaveRef.current = setInterval(async () => { try { await FileSystem.writeAsStringAsync(AUTOSAVE_FILE, JSON.stringify({ session: sessionName, points: trailRef.current, note: n, trip_type: tt, elapsed: elapsedRef.current, autosaved_at: new Date().toLocaleTimeString() })); } catch {} }, AUTOSAVE_MS); };

  const startForegroundWatch = async () => {
        fgWatchRef.current?.remove();
        fgWatchRef.current = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 }, (loc) => {
                const w = weatherRef.current; const pl = pollenRef.current; const ms = motionSnapshot(); const hs = healthSnap(); const ble = bleRef.current;
                const p: GpsPoint = { timestamp_ms: loc.timestamp, iso_time: new Date(loc.timestamp).toISOString(), latitude: loc.coords.latitude, longitude: loc.coords.longitude, altitude: loc.coords.altitude ?? null, accuracy: loc.coords.accuracy ?? null, speed_mps: loc.coords.speed ?? null, heading: loc.coords.heading ?? null, ble_hr: ble.heartRate, ble_rr: ble.rr_intervals?.length ? ble.rr_intervals : null, ble_battery: ble.battery, accel_x: ms.accel_x, accel_y: ms.accel_y, accel_z: ms.accel_z, gyro_x: ms.gyro_x, gyro_y: ms.gyro_y, gyro_z: ms.gyro_z, mag_x: ms.mag_x, mag_y: ms.mag_y, mag_z: ms.mag_z, pitch: ms.pitch, roll: ms.roll, yaw: ms.yaw, user_accel_x: ms.user_accel_x, user_accel_y: ms.user_accel_y, user_accel_z: ms.user_accel_z, pressure_hpa: ms.pressure_hpa, pressure_alt_m: ms.pressure_alt_m, cadence_spm: ms.cadence_spm, hk_hr: hs.heart_rate, hk_hrv: hs.hrv, hk_temp_c: hs.wrist_temp_c, hk_spo2: hs.spo2, hk_cal: hs.calories_active, wind_speed_mps: w ? w.wind_kph / 3.6 : null, temp_c: w ? w.temp_c : null, pollen_tree_upi: pl?.tree_upi ?? null, pollen_grass_upi: pl?.grass_upi ?? null, pollen_weed_upi: pl?.weed_upi ?? null };
                setCurrentPos(p); setTrail(prev => { const next = [...prev, p]; trailRef.current = next; setPointCount(next.length); return next; });
                mapRef.current?.animateCamera({ center: { latitude: p.latitude, longitude: p.longitude }, zoom: 18 }, { duration: 500 });
        });
  };

  const handleStart = async () => { try { const fg = await Location.requestForegroundPermissionsAsync(); if (fg.status !== "granted") { Alert.alert("Permission needed", "Foreground location required."); return; } const bg = await Location.requestBackgroundPermissionsAsync(); if (bg.status !== "granted") { Alert.alert("Permission needed", "Settings > Privacy > Location Services > Walk Logger > Always."); return; } await FileSystem.deleteAsync(LOG_FILE, { idempotent: true }); trailRef.current = []; setTrail([]); setPointCount(0); setElapsed(0); elapsedRef.current = 0; await Location.startLocationUpdatesAsync(LOCATION_TASK, { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0, pausesUpdatesAutomatically: false, showsBackgroundLocationIndicator: true }); await startForegroundWatch(); startAutosave(note, tripType); if (currentPos) { fetchWeather(currentPos.latitude, currentPos.longitude); fetchPollen(currentPos.latitude, currentPos.longitude); weatherPoll.current = setInterval(() => { if (currentPos) { fetchWeather(currentPos.latitude, currentPos.longitude); fetchPollen(currentPos.latitude, currentPos.longitude); } }, 300000); } setRunning(true); } catch(e: any) { Alert.alert("Start failed", String(e)); } };
    const handleStop = async () => { try { await Location.stopLocationUpdatesAsync(LOCATION_TASK); fgWatchRef.current?.remove(); [autosaveRef, weatherPoll].forEach(r => { if (r.current) clearInterval(r.current); }); setRunning(false); await syncTrailFromFile(); } catch(e: any) { Alert.alert("Stop failed", String(e)); } };
    const exportGeoJSON = async (points: GpsPoint[], expNote: string, expType: string, expElapsed: number) => { if (!points.length) { Alert.alert("No data", "Record a walk first."); return; } const geojson = { type: "FeatureCollection", properties: { session: sessionName, points: points.length, duration_sec: expElapsed, exported_at: new Date().toISOString(), source: "towntrip-walk-logger", note: expNote.trim(), trip_type: expType, ble_device: bleState.deviceName, ble_battery: bleState.battery }, features: [{ type: "Feature", geometry: { type: "LineString", coordinates: points.map(p => [p.longitude, p.latitude, p.altitude ?? 0]) }, properties: { session: sessionName, start: points[0]?.iso_time, end: points[points.length-1]?.iso_time, points: points.length } }, ...points.map((p, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.longitude, p.latitude, p.altitude ?? 0] }, properties: { i, ...p } }))] }; const outPath = FileSystem.documentDirectory + sessionName + ".geojson"; await FileSystem.writeAsStringAsync(outPath, JSON.stringify(geojson, null, 2)); await Sharing.shareAsync(outPath); await FileSystem.deleteAsync(AUTOSAVE_FILE, { idempotent: true }); };
    const handleExport = async () => { try { await exportGeoJSON(trail, note, tripType, elapsed); } catch(e: any) { Alert.alert("Export failed", String(e)); } };

  const fmt = (s: number) => Math.floor(s/60).toString().padStart(2,"0") + ":" + (s%60).toString().padStart(2,"0");
    const speedKmh = currentPos?.speed_mps != null ? (Math.max(0, currentPos.speed_mps) * 3.6).toFixed(1) : "--";
    const trailCoords = trail.map(p => ({ latitude: p.latitude, longitude: p.longitude }));
    const tempStr = weather ? `${weather.temp_c}°` : "--";
    const windDir = weather ? degToDir(weather.wind_dir_deg) : "";
    const windStr = weather ? `${weather.wind_kph}${windDir}` : "--";
    const gustStr = weather && weather.gust_kph > weather.wind_kph + 5 ? `G${weather.gust_kph}` : "";
    const baroStr = currentPos?.pressure_hpa ? `${currentPos.pressure_hpa.toFixed(0)}` : null;
    const altStr = currentPos?.pressure_alt_m ? `${currentPos.pressure_alt_m.toFixed(0)}m` : (currentPos?.altitude ? `${currentPos.altitude.toFixed(0)}m` : "--");
    const activeHR = bleState.heartRate ?? hkData.heart_rate;
    const hrSource = bleState.heartRate ? "CHEST" : hkData.heart_rate ? "WRIST" : null;
    const dominantUPI = Math.max(pollen?.tree_upi ?? 0, pollen?.grass_upi ?? 0, pollen?.weed_upi ?? 0);
    const hasInnerData = activeHR !== null || hkData.sp
