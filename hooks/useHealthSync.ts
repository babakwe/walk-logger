// hooks/useHealthSync.ts
// Syncs Apple HealthKit data to Supabase via react-native-health
// VeSync scale → Apple Health → this hook → Supabase
// Runs on app open. Safe to import — silently skips if native build not present.

import { useCallback, useState } from 'react';

const INGEST  = "https://xyfyuvikqmxcazqgqoxb.supabase.co/functions/v1/data-ingest";
const SECRET  = "towntrip-ingest-2026";

export type SyncStatus = {
  running: boolean;
  lastSync: string | null;
  counts: { weight: number; hr: number; hrv: number };
  error: string | null;
};

function getAppleHealth() {
  try {
    const H = require('react-native-health');
    return H?.default ?? H ?? null;
  } catch { return null; }
}

async function ingest(table: string, rows: any[]): Promise<number> {
  if (!rows.length) return 0;
  try {
    const r = await fetch(INGEST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-secret': SECRET },
      body: JSON.stringify({ table, rows }),
    });
    const d = await r.json();
    return d.inserted ?? rows.length;
  } catch { return 0; }
}

export function useHealthSync() {
  const [status, setStatus] = useState<SyncStatus>({
    running: false, lastSync: null, counts: { weight: 0, hr: 0, hrv: 0 }, error: null
  });

  const sync = useCallback(async (dayRange = 90) => {
    const AH = getAppleHealth();
    if (!AH) {
      setStatus(s => ({ ...s, error: 'HealthKit not available' }));
      return;
    }
    setStatus(s => ({ ...s, running: true, error: null }));

    const { Permissions } = AH;
    await new Promise<void>(resolve => {
      AH.initHealthKit({
        permissions: {
          read: [
            Permissions.HeartRate, Permissions.HeartRateVariability,
            Permissions.RestingHeartRate, Permissions.OxygenSaturation,
            Permissions.Weight, Permissions.BodyFatPercentage,
            Permissions.Steps, Permissions.Workout,
          ].filter(Boolean),
          write: []
        }
      }, (err: any) => { if (err) console.log('HealthKit init:', err); resolve(); });
    });

    const start = new Date(Date.now() - dayRange * 24 * 60 * 60 * 1000);
    const opts = { startDate: start.toISOString(), endDate: new Date().toISOString(), ascending: true, limit: 5000 };
    const counts = { weight: 0, hr: 0, hrv: 0 };

    // Weight (from VeSync scale via Apple Health)
    await new Promise<void>(resolve => {
      AH.getWeightSamples({ ...opts, unit: 'pound' }, async (err: any, results: any[]) => {
        if (!err && results?.length) {
          const rows = results
            .filter((r: any) => r.value > 0)
            .map((r: any) => ({
              recorded_at: r.startDate,
              weight_lb: Math.round(r.value * 10) / 10,
              source: (r.sourceName ?? '').toLowerCase().includes('vesync') || (r.sourceName ?? '').toLowerCase().includes('etekcity') ? 'etekcity_vesync' : 'apple_health',
            }));
          counts.weight = await ingest('weight_events', rows);
        }
        resolve();
      });
    });

    // Heart Rate
    await new Promise<void>(resolve => {
      AH.getHeartRateSamples(opts, async (err: any, results: any[]) => {
        if (!err && results?.length) {
          const rows = results
            .filter((r: any) => r.value > 0)
            .map((r: any) => ({
              session_id: 'apple_health_live', recorded_at: r.startDate,
              hr_bpm: Math.round(r.value), source: 'apple_health', device: r.sourceName ?? null,
            }));
          counts.hr = await ingest('hrm_events', rows);
        }
        resolve();
      });
    });

    // HRV
    await new Promise<void>(resolve => {
      AH.getHeartRateVariabilitySamples(opts, async (err: any, results: any[]) => {
        if (!err && results?.length) {
          const rows = results
            .filter((r: any) => r.value)
            .map((r: any) => ({
              session_id: 'apple_health_hrv', recorded_at: r.startDate,
              hr_bpm: 0, hrv_rmssd: r.value, source: 'apple_health', device: r.sourceName ?? null,
            }));
          counts.hrv = await ingest('hrm_events', rows);
        }
        resolve();
      });
    });

    setStatus({ running: false, lastSync: new Date().toISOString(), counts, error: null });
  }, []);

  return { sync, status };
}
