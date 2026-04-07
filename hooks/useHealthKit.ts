// hooks/useHealthKit.ts
// Live Apple Watch health data during active walk sessions
// Uses react-native-health — safe to import, silently returns nulls if unavailable

import { useEffect, useRef, useState, useCallback } from 'react';

export type HealthSnapshot = {
  heart_rate:       number | null;
  hrv:              number | null;
  wrist_temp_c:     number | null;
  spo2:             number | null;
  calories_active:  number | null;
  respiration_rate: number | null;
  vo2_max:          number | null;
  last_updated:     number | null;
};

const NULL_SNAPSHOT: HealthSnapshot = {
  heart_rate: null, hrv: null, wrist_temp_c: null, spo2: null,
  calories_active: null, respiration_rate: null, vo2_max: null, last_updated: null,
};

const POLL_MS = 5000;

export function useHealthKit(active: boolean) {
  const [snapshot, setSnapshot]     = useState<HealthSnapshot>({ ...NULL_SNAPSHOT });
  const [available, setAvailable]   = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const snapRef   = useRef<HealthSnapshot>({ ...NULL_SNAPSHOT });
  const pollRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTime = useRef<Date>(new Date());

  const getAH = useCallback(() => {
    try {
      const H = require('react-native-health');
      return H?.default ?? H ?? null;
    } catch { return null; }
  }, []);

  const poll = useCallback(async () => {
    const AH = getAH();
    if (!AH) return;
    const now = new Date();
    const fiveAgo = new Date(Date.now() - 5 * 60 * 1000);
    const opts = { startDate: fiveAgo.toISOString(), endDate: now.toISOString(), ascending: false, limit: 1 };

    const q = (fn: string, extra = {}) => new Promise<number | null>(resolve => {
      try {
        AH[fn]({ ...opts, ...extra }, (err: any, results: any[]) => {
          resolve(!err && results?.length ? results[0].value ?? null : null);
        });
      } catch { resolve(null); }
    });

    const hr    = await q('getHeartRateSamples');
    const hrv   = await q('getHeartRateVariabilitySamples');
    const spo2  = await q('getOxygenSaturationSamples');
    const rr    = await q('getRespiratoryRateSamples');
    const vo2   = await q('getVo2MaxSamples');

    // Calories since session start
    const cals = await new Promise<number | null>(resolve => {
      try {
        AH.getActiveEnergyBurned({
          startDate: startTime.current.toISOString(),
          endDate: now.toISOString(), limit: 1000
        }, (err: any, results: any[]) => {
          if (err || !results?.length) return resolve(null);
          resolve(results.reduce((s: number, r: any) => s + (r.value ?? 0), 0));
        });
      } catch { resolve(null); }
    });

    const updated: HealthSnapshot = {
      heart_rate: hr ? Math.round(hr) : null,
      hrv, wrist_temp_c: null,
      spo2: spo2 ? Math.round(spo2 * 100) : null,
      calories_active: cals ? Math.round(cals) : null,
      respiration_rate: rr, vo2_max: vo2,
      last_updated: Date.now(),
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
      const AH = getAH();
      if (!AH) { setAvailable(false); return; }
      setAvailable(true);
      startTime.current = new Date();
      const { Permissions } = AH;
      await new Promise<void>(resolve => {
        AH.initHealthKit({
          permissions: { read: [Permissions.HeartRate, Permissions.HeartRateVariability, Permissions.OxygenSaturation, Permissions.ActiveEnergyBurned, Permissions.RespiratoryRate, Permissions.Vo2Max].filter(Boolean), write: [] }
        }, (err: any) => { resolve(); });
      });
      if (!mounted) return;
      setAuthorized(true);
      await poll();
      if (!mounted) return;
      pollRef.current = setInterval(poll, POLL_MS);
    })();
    return () => {
      mounted = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [active]);

  const getSnapshot = useCallback((): HealthSnapshot => ({ ...snapRef.current }), []);
  return { snapshot, getSnapshot, available, authorized };
}
