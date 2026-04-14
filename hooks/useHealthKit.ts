// hooks/useHealthKit.ts
// HealthKit live session stub — safe to import, returns nulls

import { useCallback, useState } from 'react';

export type HealthSnapshot = {
  heart_rate: number | null;
  hrv: number | null;
  wrist_temp_c: number | null;
  spo2: number | null;
  calories_active: number | null;
  respiration_rate: number | null;
  vo2_max: number | null;
  last_updated: number | null;
};

const NULL_SNAP: HealthSnapshot = {
  heart_rate: null, hrv: null, wrist_temp_c: null, spo2: null,
  calories_active: null, respiration_rate: null, vo2_max: null, last_updated: null,
};

export function useHealthKit(_active: boolean) {
  const [snapshot] = useState<HealthSnapshot>({ ...NULL_SNAP });
  const getSnapshot = useCallback((): HealthSnapshot => ({ ...NULL_SNAP }), []);
  return { snapshot, getSnapshot, available: false, authorized: false };
}
