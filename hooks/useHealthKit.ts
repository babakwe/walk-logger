// hooks/useHealthKit.ts
// Apple Watch → HealthKit → Walk Logger bridge
// Streams HR, HRV, wrist temperature, SpO2, calories live during a session.
//
// REQUIRES NATIVE BUILD:
//   1. expo install expo-health
//   2. Add to app.json plugins: ["expo-health", { "healthSharePermission": "TownTrip reads health data to improve walk predictions" }]
//   3. EAS build --platform ios
//
// This hook is safe to import in all builds — it checks for native module
// availability at runtime and silently returns nulls if not available.
// No crash, no error — just no data until the native build is installed.

import { useEffect, useRef, useState, useCallback } from 'react';

export type HealthSnapshot = {
  heart_rate:       number | null;   // BPM — most recent reading
  hrv:              number | null;   // ms — heart rate variability (SDNN)
  wrist_temp_c:     number | null;   // °C — wrist skin temperature
  spo2:             number | null;   // % — blood oxygen saturation
  calories_active:  number | null;   // kcal — active energy burned this session
  respiration_rate: number | null;   // breaths/min
  vo2_max:          number | null;   // mL/kg/min — fitness baseline
  last_updated:     number | null;   // timestamp_ms of most recent reading
};

const NULL_SNAPSHOT: HealthSnapshot = {
  heart_rate: null, hrv: null, wrist_temp_c: null, spo2: null,
  calories_active: null, respiration_rate: null, vo2_max: null, last_updated: null,
};

// Poll interval for HealthKit queries during active session
const POLL_MS = 5000; // every 5 seconds — HealthKit is not a stream, it's a query

export function useHealthKit(active: boolean) {
  const [snapshot, setSnapshot]     = useState<HealthSnapshot>({ ...NULL_SNAPSHOT });
  const [available, setAvailable]   = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const snapRef   = useRef<HealthSnapshot>({ ...NULL_SNAPSHOT });
  const pollRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTime = useRef<Date>(new Date());

  // Get the HealthKit module safely — returns null if native build not present
  const getHK = useCallback(() => {
    try {
      // expo-health exports default as Health
      const Health = require('expo-health');
      return Health?.default ?? Health ?? null;
    } catch {
      return null;
    }
  }, []);

  // Request HealthKit authorization for the data types we need
  const authorize = useCallback(async (): Promise<boolean> => {
    const HK = getHK();
    if (!HK) return false;
    try {
      const readTypes = [
        HK.HealthDataType.HeartRate,
        HK.HealthDataType.HeartRateVariabilitySDNN,
        HK.HealthDataType.OxygenSaturation,
        HK.HealthDataType.ActiveEnergyBurned,
        HK.HealthDataType.RespiratoryRate,
        HK.HealthDataType.VO2Max,
        // Wrist temperature — available Series 8+ via WristTemperature
        ...(HK.HealthDataType.WristTemperature ? [HK.HealthDataType.WristTemperature] : []),
      ];
      await HK.requestAuthorization({ read: readTypes, write: [] });
      return true;
    } catch (e) {
      console.log('HealthKit auth error:', e);
      return false;
    }
  }, []);

  // Query the most recent value for a given HealthKit type
  const queryLatest = useCallback(async (HK: any, type: string, unit: string): Promise<number | null> => {
    try {
      const results = await HK.querySamples({
        type,
        unit,
        startDate: new Date(Date.now() - 5 * 60 * 1000), // last 5 minutes
        endDate: new Date(),
        limit: 1,
        ascending: false,
      });
      if (results?.length > 0) return results[0].value ?? null;
      return null;
    } catch { return null; }
  }, []);

  // Query active energy burned since session start
  const queryActiveCalories = useCallback(async (HK: any): Promise<number | null> => {
    try {
      const results = await HK.querySamples({
        type: HK.HealthDataType.ActiveEnergyBurned,
        unit: HK.UnitType.Kilocalorie,
        startDate: startTime.current,
        endDate: new Date(),
        limit: 1000,
        ascending: true,
      });
      if (!results?.length) return null;
      return results.reduce((sum: number, r: any) => sum + (r.value ?? 0), 0);
    } catch { return null; }
  }, []);

  // Main poll — runs every 5 seconds while session is active
  const poll = useCallback(async () => {
    const HK = getHK();
    if (!HK) return;

    const [hr, hrv, spo2, rr, vo2, cals] = await Promise.all([
      queryLatest(HK, HK.HealthDataType.HeartRate,                  HK.UnitType.BeatsPerMinute),
      queryLatest(HK, HK.HealthDataType.HeartRateVariabilitySDNN,   HK.UnitType.Millisecond),
      queryLatest(HK, HK.HealthDataType.OxygenSaturation,           HK.UnitType.Percent),
      queryLatest(HK, HK.HealthDataType.RespiratoryRate,            'count/min'),
      queryLatest(HK, HK.HealthDataType.VO2Max,                     'ml/kg/min'),
      queryActiveCalories(HK),
    ]);

    // Wrist temperature — Series 8+, only available as sleep data in HealthKit
    // Apple exposes nightly temperature deviation, not real-time during workouts.
    // We query it anyway — if data exists from last night it gives us a baseline.
    let wristTemp: number | null = null;
    try {
      if (HK.HealthDataType.WristTemperature) {
        const tempResults = await HK.querySamples({
          type: HK.HealthDataType.WristTemperature,
          unit: HK.UnitType.DegreeCelsius,
          startDate: new Date(Date.now() - 24 * 60 * 60 * 1000), // last 24h
          endDate: new Date(),
          limit: 1,
          ascending: false,
        });
        if (tempResults?.length > 0) wristTemp = tempResults[0].value ?? null;
      }
    } catch {}

    const updated: HealthSnapshot = {
      heart_rate:       hr,
      hrv:              hrv,
      wrist_temp_c:     wristTemp,
      spo2:             spo2 ? Math.round(spo2 * 100) : null, // convert 0-1 to %
      calories_active:  cals ? Math.round(cals) : null,
      respiration_rate: rr,
      vo2_max:          vo2,
      last_updated:     Date.now(),
    };

    snapRef.current = updated;
    setSnapshot(updated);
  }, []);

  useEffect(() => {
    if (!active) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    let mounted = true;

    (async () => {
      const HK = getHK();
      if (!HK) {
        // Native module not present — silent, no error
        setAvailable(false);
        return;
      }
      setAvailable(true);
      startTime.current = new Date();

      const auth = await authorize();
      if (!mounted) return;
      setAuthorized(auth);
      if (!auth) return;

      // First poll immediately, then every 5s
      await poll();
      if (!mounted) return;
      pollRef.current = setInterval(poll, POLL_MS);
    })();

    return () => {
      mounted = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [active]);

  // Returns the latest health snapshot — call this alongside motionSnapshot()
  // when building each GPS point
  const getSnapshot = useCallback((): HealthSnapshot => ({ ...snapRef.current }), []);

  return { snapshot, getSnapshot, available, authorized };
}
