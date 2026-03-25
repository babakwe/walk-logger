// hooks/useBLE.ts
// Bluetooth Low Energy heart rate monitor support
// Connects to: Garmin HRM-600, Polar Verity Sense, any BLE HR strap
// Uses standard Bluetooth Heart Rate Service (UUID 0x180D)
// No native build required — uses expo-bluetooth / react-native-ble-plx
//
// BLE = Bluetooth Low Energy — the wireless protocol HR straps use.
// At 512Hz sample rate a chest strap sends HR readings every ~1 second.
// This hook connects, subscribes, and streams live BPM to the Walk Logger
// so every GPS point gets the actual chest strap HR, not wrist optical.
//
// REQUIRES: expo install react-native-ble-plx
// Add to app.json: { "plugins": [["react-native-ble-plx", { "isBackgroundEnabled": true, "modes": ["peripheral","central"] }]] }

import { useEffect, useRef, useState, useCallback } from 'react';

// Standard BLE Heart Rate Service and Characteristic UUIDs
const HR_SERVICE_UUID        = '0000180d-0000-1000-8000-00805f9b34fb';
const HR_MEASUREMENT_UUID    = '00002a37-0000-1000-8000-00805f9b34fb';
const BATTERY_SERVICE_UUID   = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_LEVEL_UUID     = '00002a19-0000-1000-8000-00805f9b34fb';

export type BLEStatus = 'unavailable' | 'off' | 'scanning' | 'connecting' | 'connected' | 'disconnected';

export type BLEState = {
  status:       BLEStatus;
  deviceName:   string | null;
  heartRate:    number | null;
  battery:      number | null;    // % if device supports it
  rr_intervals: number[];         // ms between beats — raw HRV data
  last_updated: number | null;
};

const NULL_STATE: BLEState = {
  status: 'unavailable', deviceName: null, heartRate: null,
  battery: null, rr_intervals: [], last_updated: null,
};

// Parse BLE Heart Rate Measurement characteristic value
// Format per Bluetooth spec: flags byte, HR value (1 or 2 bytes), RR intervals
function parseHRMeasurement(base64Value: string): { hr: number; rr: number[] } {
  try {
    // Decode base64 to bytes
    const binary = atob(base64Value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    
    const flags = bytes[0];
    const is16bit = (flags & 0x01) !== 0;      // bit 0: HR format
    const hasRR   = (flags & 0x10) !== 0;      // bit 4: RR interval present
    
    let hr: number;
    let offset: number;
    
    if (is16bit) {
      hr = bytes[1] | (bytes[2] << 8);
      offset = 3;
    } else {
      hr = bytes[1];
      offset = 2;
    }
    
    // Skip energy expended if present (bit 3)
    if (flags & 0x08) offset += 2;
    
    // Parse RR intervals (1/1024 second units → ms)
    const rr: number[] = [];
    if (hasRR) {
      while (offset + 1 < bytes.length) {
        const rrRaw = bytes[offset] | (bytes[offset+1] << 8);
        rr.push(Math.round(rrRaw * 1000 / 1024));
        offset += 2;
      }
    }
    
    return { hr, rr };
  } catch {
    return { hr: 0, rr: [] };
  }
}

export function useBLE(active: boolean) {
  const [state, setState]   = useState<BLEState>({ ...NULL_STATE });
  const stateRef            = useRef<BLEState>({ ...NULL_STATE });
  const managerRef          = useRef<any>(null);
  const deviceRef           = useRef<any>(null);
  const subscriptionRef     = useRef<any>(null);
  const scanTimeoutRef      = useRef<ReturnType<typeof setTimeout>|null>(null);

  const updateState = useCallback((patch: Partial<BLEState>) => {
    stateRef.current = { ...stateRef.current, ...patch };
    setState({ ...stateRef.current });
  }, []);

  const disconnect = useCallback(async () => {
    subscriptionRef.current?.remove?.();
    if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
    try { await deviceRef.current?.cancelConnection(); } catch {}
    deviceRef.current = null;
    updateState({ status: 'disconnected', heartRate: null, rr_intervals: [] });
  }, []);

  const connect = useCallback(async (device: any) => {
    try {
      updateState({ status: 'connecting', deviceName: device.name || device.id });
      const connected = await device.connect({ autoConnect: false, requestMTU: 512 });
      await connected.discoverAllServicesAndCharacteristics();
      deviceRef.current = connected;
      updateState({ status: 'connected', deviceName: connected.name || device.id });

      // Subscribe to HR measurements
      subscriptionRef.current = connected.monitorCharacteristicForService(
        HR_SERVICE_UUID, HR_MEASUREMENT_UUID,
        (error: any, characteristic: any) => {
          if (error) { updateState({ status: 'disconnected' }); return; }
          const { hr, rr } = parseHRMeasurement(characteristic.value);
          if (hr > 0) {
            updateState({ heartRate: hr, rr_intervals: rr, last_updated: Date.now() });
          }
        }
      );

      // Try to read battery level
      try {
        const bat = await connected.readCharacteristicForService(BATTERY_SERVICE_UUID, BATTERY_LEVEL_UUID);
        const batBytes = new Uint8Array(atob(bat.value).split('').map(c => c.charCodeAt(0)));
        updateState({ battery: batBytes[0] });
      } catch {}

    } catch (e) {
      console.log('BLE connect error:', e);
      updateState({ status: 'disconnected' });
    }
  }, []);

  const startScan = useCallback(() => {
    const BleManager = managerRef.current;
    if (!BleManager) return;

    updateState({ status: 'scanning', deviceName: null });
    
    // Scan for devices advertising the Heart Rate Service
    BleManager.startDeviceScan(
      [HR_SERVICE_UUID],
      { allowDuplicates: false },
      async (error: any, device: any) => {
        if (error) { updateState({ status: 'off' }); return; }
        if (device) {
          // Stop scanning and connect to first HR device found
          BleManager.stopDeviceScan();
          await connect(device);
        }
      }
    );

    // Stop scan after 30s if nothing found
    scanTimeoutRef.current = setTimeout(() => {
      BleManager.stopDeviceScan();
      if (stateRef.current.status === 'scanning') {
        updateState({ status: 'disconnected' });
      }
    }, 30000);
  }, [connect]);

  useEffect(() => {
    if (!active) {
      disconnect();
      return;
    }

    // Initialize BLE manager
    let mounted = true;
    (async () => {
      try {
        const { BleManager } = await import('react-native-ble-plx');
        if (!mounted) return;
        
        const manager = new BleManager();
        managerRef.current = manager;

        // Wait for Bluetooth to be ready
        const sub = manager.onStateChange((bleState: string) => {
          if (bleState === 'PoweredOn') {
            sub.remove();
            startScan();
          } else if (bleState === 'PoweredOff') {
            updateState({ status: 'off' });
          }
        }, true);

      } catch (e) {
        // react-native-ble-plx not installed — silent
        updateState({ status: 'unavailable' });
      }
    })();

    return () => {
      mounted = false;
      disconnect();
      managerRef.current?.destroy();
    };
  }, [active]);

  // Get current snapshot — call alongside motionSnapshot() and healthSnap()
  const getSnapshot = useCallback(() => ({ ...stateRef.current }), []);

  // Manual rescan trigger
  const rescan = useCallback(() => {
    if (managerRef.current) startScan();
  }, [startScan]);

  return { state, getSnapshot, rescan };
}
