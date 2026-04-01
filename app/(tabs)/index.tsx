import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Location from "expo-location";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as TaskManager from "expo-task-manager";
import { useKeepAwake } from "expo-keep-awake";
import MapView, { Polyline, Marker, PROVIDER_DEFAULT } from "react-native-maps";

const LOCATION_TASK = "towntrip-background-location";
const ALCOTT_TRAIL = { latitude: 40.8699, longitude: -73.8318 };
const LOG_FILE = FileSystem.documentDirectory + "towntrip_trail_points.jsonl";

type GpsPoint = {
  timestamp_ms: number;
  iso_time: string;
  latitude: number;
  longitude: number;
  altitude: number | null;
  accuracy: number | null;
  speed_mps: number | null;
  heading: number | null;
};

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }: any) => {
  if (error) { console.log("BG task error:", error); return; }
  const locations = data?.locations ?? [];
  if (!locations.length) return;
  const lines = locations.map((loc: any) => {
    const p: GpsPoint = {
      timestamp_ms: loc.timestamp ?? Date.now(),
      iso_time: new Date(loc.timestamp ?? Date.now()).toISOString(),
      latitude: loc.coords?.latitude,
      longitude: loc.coords?.longitude,
      altitude: loc.coords?.altitude ?? null,
      accuracy: loc.coords?.accuracy ?? null,
      speed_mps: loc.coords?.speed ?? null,
      heading: loc.coords?.heading ?? null,
    };
    return JSON.stringify(p);
  }).join("\n") + "\n";
  try {
    const info = await FileSystem.getInfoAsync(LOG_FILE);
    if (info.exists) {
      const prev = await FileSystem.readAsStringAsync(LOG_FILE);
      await FileSystem.writeAsStringAsync(LOG_FILE, prev + lines);
    } else {
      await FileSystem.writeAsStringAsync(LOG_FILE, lines);
    }
  } catch (e) { console.log("Write failed:", e); }
});

export default function TrailLoggerScreen() {
  useKeepAwake();
  const mapRef = useRef<MapView>(null);
  const [running, setRunning] = useState(false);
  const [trail, setTrail] = useState<GpsPoint[]>([]);
  const [currentPos, setCurrentPos] = useState<GpsPoint | null>(null);
  const [sessionName] = useState(
    "trail_" + new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "h")
  );
  const [elapsed, setElapsed] = useState(0);
  const [pointCount, setPointCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fgWatchRef = useRef<Location.LocationSubscription | null>(null);

  useEffect(() => {
    (async () => {
      const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
      setRunning(started);
      if (started) startForegroundWatch();
      await syncTrailFromFile();
    })();
    return () => cleanup();
  }, []);

  useEffect(() => {
    if (running) {
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [running]);

  const cleanup = () => {
    fgWatchRef.current?.remove();
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const syncTrailFromFile = async () => {
    try {
      const info = await FileSystem.getInfoAsync(LOG_FILE);
      if (!info.exists) return;
      const raw = await FileSystem.readAsStringAsync(LOG_FILE);
      const points = raw.trim().split("\n")
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l) as GpsPoint; } catch { return null; } })
        .filter(Boolean) as GpsPoint[];
      setTrail(points);
      setPointCount(points.length);
      if (points.length) setCurrentPos(points[points.length - 1]);
    } catch (e) { console.log("Sync trail error:", e); }
  };

  const startForegroundWatch = async () => {
    fgWatchRef.current?.remove();
    fgWatchRef.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
      (loc) => {
        const p: GpsPoint = {
          timestamp_ms: loc.timestamp,
          iso_time: new Date(loc.timestamp).toISOString(),
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          altitude: loc.coords.altitude ?? null,
          accuracy: loc.coords.accuracy ?? null,
          speed_mps: loc.coords.speed ?? null,
          heading: loc.coords.heading ?? null,
        };
        setCurrentPos(p);
        setTrail(prev => {
          const next = [...prev, p];
          setPointCount(next.length);
          return next;
        });
        mapRef.current?.animateCamera(
          { center: { latitude: p.latitude, longitude: p.longitude }, zoom: 18 },
          { duration: 500 }
        );
      }
    );
  };

  const handleStart = async () => {
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== "granted") {
        Alert.alert("Permission needed", "Foreground location permission is required.");
        return;
      }
      const bg = await Location.requestBackgroundPermissionsAsync();
      if (bg.status !== "granted") {
        Alert.alert("Permission needed", "Background location required.\n\nSettings → Privacy → Location Services → towntrip-trail-logger → Always.");
        return;
      }
      await FileSystem.deleteAsync(LOG_FILE, { idempotent: true });
      setTrail([]);
      setPointCount(0);
      setElapsed(0);
      await Location.startLocationUpdatesAsync(LOCATION_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1000,
        distanceInterval: 0,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
      });
      await startForegroundWatch();
      setRunning(true);
    } catch (e: any) {
      Alert.alert("Start failed", String(e));
    }
  };

  const handleStop = async () => {
    try {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
      fgWatchRef.current?.remove();
      setRunning(false);
      await syncTrailFromFile();
    } catch (e: any) {
      Alert.alert("Stop failed", String(e));
    }
  };

  const handleExport = async () => {
    try {
      if (trail.length === 0) {
        Alert.alert("No data", "Walk the trail first to collect points.");
        return;
      }
      const geojson = {
        type: "FeatureCollection",
        properties: {
          session: sessionName,
          points: trail.length,
          duration_sec: elapsed,
          exported_at: new Date().toISOString(),
          source: "towntrip-trail-logger",
        },
        features: [
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: trail.map(p => [p.longitude, p.latitude, p.altitude ?? 0]),
            },
            properties: { session: sessionName, start: trail[0]?.iso_time, end: trail[trail.length - 1]?.iso_time, points: trail.length },
          },
          ...trail.map((p, i) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [p.longitude, p.latitude, p.altitude ?? 0] },
            properties: { i, timestamp_ms: p.timestamp_ms, iso_time: p.iso_time, accuracy: p.accuracy, speed_mps: p.speed_mps, heading: p.heading },
          })),
        ],
      };
      const outPath = FileSystem.documentDirectory + sessionName + ".geojson";
      await FileSystem.writeAsStringAsync(outPath, JSON.stringify(geojson, null, 2));
      await Sharing.shareAsync(outPath);
    } catch (e: any) {
      Alert.alert("Export failed", String(e));
    }
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const sec = (s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  };

  const speedKmh = currentPos?.speed_mps != null ? (currentPos.speed_mps * 3.6).toFixed(1) : "--";
  const trailCoords = trail.map(p => ({ latitude: p.latitude, longitude: p.longitude }));

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_DEFAULT}
        initialRegion={{
          latitude: ALCOTT_TRAIL.latitude,
          longitude: ALCOTT_TRAIL.longitude,
          latitudeDelta: 0.004,
          longitudeDelta: 0.004,
        }}
        showsUserLocation
        showsTraffic
        showsCompass
        mapType="hybrid"
      >
        {trailCoords.length > 1 && (
          <Polyline coordinates={trailCoords} strokeColor="#00E5FF" strokeWidth={4} />
        )}
        {currentPos && (
          <Marker coordinate={{ latitude: currentPos.latitude, longitude: currentPos.longitude }} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={styles.dot} />
          </Marker>
        )}
      </MapView>

      <View style={styles.statsBar}>
        <View style={styles.stat}>
          <Text style={styles.statVal}>{formatTime(elapsed)}</Text>
          <Text style={styles.statLabel}>TIME</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statVal}>{pointCount}</Text>
          <Text style={styles.statLabel}>POINTS</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statVal}>{speedKmh}</Text>
          <Text style={styles.statLabel}>KM/H</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statVal}>{currentPos?.altitude != null ? currentPos.altitude.toFixed(0) + "m" : "--"}</Text>
          <Text style={styles.statLabel}>ALT</Text>
        </View>
      </View>

      <View style={styles.sessionBar}>
        <View style={[styles.statusDot, { backgroundColor: running ? "#4CAF50" : "#555" }]} />
        <Text style={styles.sessionText} numberOfLines={1}>{sessionName}</Text>
      </View>

      <View style={styles.controls}>
        {!running ? (
          <Pressable style={[styles.btn, styles.btnStart]} onPress={handleStart}>
            <Text style={styles.btnText}>▶  START</Text>
          </Pressable>
        ) : (
          <Pressable style={[styles.btn, styles.btnStop]} onPress={handleStop}>
            <Text style={styles.btnText}>■  STOP</Text>
          </Pressable>
        )}
        <Pressable style={[styles.btn, styles.btnExport, trail.length === 0 && styles.btnDisabled]} onPress={handleExport} disabled={trail.length === 0}>
          <Text style={styles.btnText}>↑  EXPORT</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A0A0A" },
  map: { flex: 1 },
  dot: { width: 16, height: 16, borderRadius: 8, backgroundColor: "#00E5FF", borderWidth: 3, borderColor: "#fff" },
  statsBar: { flexDirection: "row", backgroundColor: "#0A0A0A", paddingVertical: 12, paddingHorizontal: 8, borderTopWidth: 1, borderTopColor: "#1E1E1E" },
  stat: { flex: 1, alignItems: "center" },
  statVal: { color: "#FFFFFF", fontSize: 22, fontWeight: "700" },
  statLabel: { color: "#666", fontSize: 10, marginTop: 2, letterSpacing: 1 },
  sessionBar: { flexDirection: "row", alignItems: "center", backgroundColor: "#111", paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  sessionText: { color: "#888", fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  controls: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingBottom: 36, paddingTop: 12, backgroundColor: "#0A0A0A" },
  btn: { flex: 1, paddingVertical: 16, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  btnStart: { backgroundColor: "#00C853" },
  btnStop: { backgroundColor: "#D50000" },
  btnExport: { backgroundColor: "#0288D1" },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "700", letterSpacing: 0.5 },
});
