// hooks/useMotionSensors.ts
// All available phone sensors — no native build required
// Accelerometer, Gyroscope, Magnetometer, DeviceMotion (fused), Barometer
// Sample rates: Accel/Gyro/DeviceMotion=10Hz, Mag=5Hz, Baro=2Hz

import { useEffect, useRef, useState, useCallback } from 'react';
import { Accelerometer, Gyroscope, Magnetometer, DeviceMotion, Barometer } from 'expo-sensors';

export type MotionSnapshot = {
  accel_x: number|null; accel_y: number|null; accel_z: number|null;
  gyro_x: number|null;  gyro_y: number|null;  gyro_z: number|null;
  mag_x: number|null;   mag_y: number|null;   mag_z: number|null;
  pitch: number|null; roll: number|null; yaw: number|null;
  user_accel_x: number|null; user_accel_y: number|null; user_accel_z: number|null;
  pressure_hpa: number|null; pressure_alt_m: number|null;
  cadence_spm: number|null;
};

const SEA_LEVEL_HPA = 1013.25;
function pressureToAlt(hpa: number): number {
  return 44330 * (1 - Math.pow(hpa / SEA_LEVEL_HPA, 0.1903));
}

class StepDetector {
  private window: number[] = [];
  private windowSize = 30;
  private lastCrossing = 0;
  private stepIntervals: number[] = [];
  push(az: number, ts: number) {
    this.window.push(az);
    if (this.window.length > this.windowSize) this.window.shift();
    const mean = this.window.reduce((a,b)=>a+b,0)/this.window.length;
    const centered = az - mean;
    const prev = this.window.length > 1 ? this.window[this.window.length-2]-mean : 0;
    if (prev > 0.1 && centered < -0.1) {
      if (this.lastCrossing > 0) {
        const interval = ts - this.lastCrossing;
        if (interval > 300 && interval < 1500) {
          this.stepIntervals.push(interval);
          if (this.stepIntervals.length > 10) this.stepIntervals.shift();
        }
      }
      this.lastCrossing = ts;
    }
  }
  getCadenceSpm(): number|null {
    if (this.stepIntervals.length < 3) return null;
    const avg = this.stepIntervals.reduce((a,b)=>a+b,0)/this.stepIntervals.length;
    return Math.round(60000/avg);
  }
}

export function useMotionSensors(active: boolean) {
  const snapRef  = useRef<MotionSnapshot>({
    accel_x:null,accel_y:null,accel_z:null,
    gyro_x:null,gyro_y:null,gyro_z:null,
    mag_x:null,mag_y:null,mag_z:null,
    pitch:null,roll:null,yaw:null,
    user_accel_x:null,user_accel_y:null,user_accel_z:null,
    pressure_hpa:null,pressure_alt_m:null,cadence_spm:null,
  });
  const [available, setAvailable] = useState({
    accelerometer:false,gyroscope:false,magnetometer:false,deviceMotion:false,barometer:false
  });
  const stepDet = useRef(new StepDetector());
  const subs    = useRef<any[]>([]);

  const stopAll = useCallback(() => {
    subs.current.forEach(s=>s?.remove?.());
    subs.current = [];
  }, []);

  useEffect(() => {
    if (!active) { stopAll(); return; }
    let mounted = true;
    (async () => {
      const [aA,gA,mA,dA,bA] = await Promise.all([
        Accelerometer.isAvailableAsync(), Gyroscope.isAvailableAsync(),
        Magnetometer.isAvailableAsync(), DeviceMotion.isAvailableAsync(),
        Barometer.isAvailableAsync(),
      ]);
      if (!mounted) return;
      setAvailable({accelerometer:aA,gyroscope:gA,magnetometer:mA,deviceMotion:dA,barometer:bA});
      if (aA) {
        Accelerometer.setUpdateInterval(100);
        subs.current.push(Accelerometer.addListener(({x,y,z})=>{
          snapRef.current.accel_x=x; snapRef.current.accel_y=y; snapRef.current.accel_z=z;
          stepDet.current.push(z,Date.now());
          snapRef.current.cadence_spm=stepDet.current.getCadenceSpm();
        }));
      }
      if (gA) {
        Gyroscope.setUpdateInterval(100);
        subs.current.push(Gyroscope.addListener(({x,y,z})=>{
          snapRef.current.gyro_x=x; snapRef.current.gyro_y=y; snapRef.current.gyro_z=z;
        }));
      }
      if (mA) {
        Magnetometer.setUpdateInterval(200);
        subs.current.push(Magnetometer.addListener(({x,y,z})=>{
          snapRef.current.mag_x=x; snapRef.current.mag_y=y; snapRef.current.mag_z=z;
        }));
      }
      if (dA) {
        DeviceMotion.setUpdateInterval(100);
        subs.current.push(DeviceMotion.addListener((data)=>{
          snapRef.current.pitch=data.rotation?.beta??null;
          snapRef.current.roll=data.rotation?.gamma??null;
          snapRef.current.yaw=data.rotation?.alpha??null;
          snapRef.current.user_accel_x=data.acceleration?.x??null;
          snapRef.current.user_accel_y=data.acceleration?.y??null;
          snapRef.current.user_accel_z=data.acceleration?.z??null;
        }));
      }
      if (bA) {
        Barometer.setUpdateInterval(500);
        subs.current.push(Barometer.addListener(({pressure,relativeAltitude})=>{
          snapRef.current.pressure_hpa=pressure;
          snapRef.current.pressure_alt_m=relativeAltitude!=null?relativeAltitude:pressureToAlt(pressure);
        }));
      }
    })();
    return () => { mounted=false; stopAll(); };
  }, [active]);

  const snapshot = useCallback((): MotionSnapshot => ({ ...snapRef.current }), []);
  return { snapshot, available };
}
