// hooks/useHealthSync.ts
// Health sync stub — HealthKit integration deferred to next native build
// Data is loaded via Apple Health XML export in the meantime

import { useCallback, useState } from 'react';

export type SyncStatus = {
  running: boolean;
  lastSync: string | null;
  counts: { weight: number; hr: number; hrv: number };
  error: string | null;
};

export function useHealthSync() {
  const [status, setStatus] = useState<SyncStatus>({
    running: false, lastSync: null,
    counts: { weight: 0, hr: 0, hrv: 0 }, error: null
  });

  const sync = useCallback(async (_dayRange = 90) => {
    // HealthKit sync requires react-native-health native module
    // Will be enabled in a future build with proper native setup
    console.log('HealthKit sync: deferred — use Apple Health XML export for now');
  }, []);

  return { sync, status };
}
