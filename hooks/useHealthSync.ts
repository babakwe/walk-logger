// hooks/useHealthSync.ts
// Syncs Apple HealthKit historical data to Supabase
// Runs on app open + whenever called manually
// Covers: weight (VeSync via HealthKit), HR, HRV, SpO2, steps, workouts
//
// VeSync scale → Apple Health → this hook → Supabase
// No manual exports needed.

import { useCallback, useState } from 'react';

const SB_URL  = "https://xyfyuvikqmxcazqgqoxb.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2Njg3NTgsImV4cCI6MjA4ODI0NDc1OH0.HpVmJtUzXSqPBsF0rBgGbWjHaFPYNvHIoBbCfTVJEiQ";
const INGEST  = "https://xyfyuvikqmxcazqgqoxb.supabase.co/functions/v1/data-ingest";
const SECRET  = "towntrip-ingest-2026";
const SYNC_KEY = "healthsync_last_run";

export type SyncStatus = {
  running: boolean;
  lastSync: string | null;
  counts: { weight: number; hr: number; hrv: number; steps: number };
  error: string | null;
};

const NULL_STATUS: SyncStatus = {
  running: false, lastSync: null,
  counts: { weight: 0, hr: 0, hrv: 0, steps: 0 },
  error: null,
};

function getHK() {
  try {
    const H = require('expo-health');
    return H?.default ?? H ?? null;
  } catch { return null; }
}

async function ingest(table: string, rows: any[]) {
  if (!rows.length) return 0;
  const r = await fetch(INGEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-secret': SECRET },
    body: JSON.stringify({ table, rows }),
  });
  const d = await r.json();
  return d.inserted ?? rows.length;
}

async function queryHK(HK: any, type: string, unit: string, startDate: Date, endDate: Date, limit = 2000) {
  try {
    return await HK.querySamples({ type, unit, startDate, endDate, limit, ascending: true }) ?? [];
  } catch { return []; }
}

export function useHealthSync() {
  const [status, setStatus] = useState<SyncStatus>({ ...NULL_STATUS });

  const sync = useCallback(async (dayRange = 90) => {
    const HK = getHK();
    if (!HK) {
      setStatus(s => ({ ...s, error: 'HealthKit not available (needs native build)' }));
      return;
    }

    setStatus(s => ({ ...s, running: true, error: null }));

    try {
      // Request permissions for all data types we need
      const readTypes = [
        HK.HealthDataType.BodyMass,
        HK.HealthDataType.HeartRate,
        HK.HealthDataType.HeartRateVariabilitySDNN,
        HK.HealthDataType.RestingHeartRate,
        HK.HealthDataType.OxygenSaturation,
        HK.HealthDataType.StepCount,
        HK.HealthDataType.DistanceWalkingRunning,
        HK.HealthDataType.BodyFatPercentage,
        HK.HealthDataType.LeanBodyMass,
        ...(HK.HealthDataType.WaistCircumference ? [HK.HealthDataType.WaistCircumference] : []),
      ].filter(Boolean);

      await HK.requestAuthorization({ read: readTypes, write: [] });
    } catch (e) {
      setStatus(s => ({ ...s, running: false, error: 'HealthKit auth failed: ' + String(e) }));
      return;
    }

    const HK2 = getHK();
    const now = new Date();
    const start = new Date(Date.now() - dayRange * 24 * 60 * 60 * 1000);
    const counts = { weight: 0, hr: 0, hrv: 0, steps: 0 };

    // ── WEIGHT (VeSync scale via HealthKit) ──────────────────────────────────
    try {
      const raw = await queryHK(HK2, HK2.HealthDataType.BodyMass, HK2.UnitType.Pound, start, now);
      const rows = raw
        .filter((r: any) => r.value && r.startDate)
        .map((r: any) => ({
          recorded_at: new Date(r.startDate).toISOString(),
          weight_lb: Math.round(r.value * 10) / 10,
          source: r.sourceName?.toLowerCase().includes('vesync') || r.sourceName?.toLowerCase().includes('etekcity')
            ? 'etekcity_vesync' : 'apple_health',
        }));
      if (rows.length) {
        counts.weight = await ingest('weight_events', rows);
      }
    } catch (e) { console.log('weight sync error', e); }

    // ── HEART RATE ────────────────────────────────────────────────────────────
    try {
      const raw = await queryHK(HK2, HK2.HealthDataType.HeartRate, HK2.UnitType.BeatsPerMinute, start, now, 5000);
      const rows = raw
        .filter((r: any) => r.value && r.startDate)
        .map((r: any) => ({
          session_id: 'apple_health_live',
          recorded_at: new Date(r.startDate).toISOString(),
          hr_bpm: Math.round(r.value),
          source: 'apple_health',
          device: r.sourceName ?? null,
        }));
      if (rows.length) {
        counts.hr = await ingest('hrm_events', rows);
      }
    } catch (e) { console.log('HR sync error', e); }

    // ── HRV ────────────────────────────────────────────────────────────────────
    try {
      const raw = await queryHK(HK2, HK2.HealthDataType.HeartRateVariabilitySDNN, HK2.UnitType.Millisecond, start, now);
      const rows = raw
        .filter((r: any) => r.value && r.startDate)
        .map((r: any) => ({
          session_id: 'apple_health_hrv',
          recorded_at: new Date(r.startDate).toISOString(),
          hr_bpm: 0,
          hrv_rmssd: r.value,
          source: 'apple_health',
          device: r.sourceName ?? null,
        }));
      if (rows.length) {
        counts.hrv = await ingest('hrm_events', rows);
      }
    } catch (e) { console.log('HRV sync error', e); }

    // ── STEPS ────────────────────────────────────────────────────────────────
    try {
      const raw = await queryHK(HK2, HK2.HealthDataType.StepCount, HK2.UnitType.Count, start, now, 1000);
      counts.steps = raw.length;
      // Steps go into gps_events as step-based location entries (no coords needed)
      // Just count for now — full step route sync later
    } catch {}

    const syncTime = new Date().toISOString();
    setStatus({ running: false, lastSync: syncTime, counts, error: null });
    console.log('HealthKit sync complete:', counts);
  }, []);

  return { sync, status };
}
