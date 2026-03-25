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

const LOCATION_TASK = "towntrip-background-location";
const ALCOTT_TRAIL  = { latitude: 40.8699, longitude: -73.8318 };
const LOG_FILE      = FileSystem.documentDirectory + "towntrip_trail_points.jsonl";
const AUTOSAVE_FILE = FileSystem.documentDirectory + "towntrip_session_autosave.json";
const AUTOSAVE_MS   = 60_000;
const TRIP_TYPES    = ["walk","transit","run"] as const;
type TripType       = typeof TRIP_TYPES[number];
const WIND_DIRS     = ["N","NE","E","SE","S","SW","W","NW"];
function degToDir(deg: number) { return WIND_DIRS[Math.round(deg/45)%8]; }

type GpsPoint = {
  timestamp_ms:number; iso_time:string; latitude:number; longitude:number;
  altitude:number|null; accuracy:number|null; speed_mps:number|null; heading:number|null;
  heart_rate:number|null; wind_speed_mps:number|null;
  accel_x:number|null; accel_y:number|null; accel_z:number|null;
  gyro_x:number|null;  gyro_y:number|null;  gyro_z:number|null;
  mag_x:number|null;   mag_y:number|null;   mag_z:number|null;
  pitch:number|null; roll:number|null; yaw:number|null;
  user_accel_x:number|null; user_accel_y:number|null; user_accel_z:number|null;
  pressure_hpa:number|null; pressure_alt_m:number|null; cadence_spm:number|null;
  hk_hr:number|null; hk_hrv:number|null; hk_temp_c:number|null; hk_spo2:number|null; hk_cal:number|null;
};
type Weather = { temp_c:number; wind_kph:number; wind_dir_deg:number; gust_kph:number; fetched_at:number; };

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }: any) => {
  if (error) { console.log("BG task error:", error); return; }
  const locations = data?.locations ?? [];
  if (!locations.length) return;
  const lines = locations.map((loc: any) => JSON.stringify({
    timestamp_ms:loc.timestamp??Date.now(), iso_time:new Date(loc.timestamp??Date.now()).toISOString(),
    latitude:loc.coords?.latitude, longitude:loc.coords?.longitude,
    altitude:loc.coords?.altitude??null, accuracy:loc.coords?.accuracy??null,
    speed_mps:loc.coords?.speed??null, heading:loc.coords?.heading??null,
  })).join("\n")+"\n";
  try {
    const info = await FileSystem.getInfoAsync(LOG_FILE);
    const prev = info.exists ? await FileSystem.readAsStringAsync(LOG_FILE) : "";
    await FileSystem.writeAsStringAsync(LOG_FILE, prev+lines);
  } catch(e) { console.log("Write failed:",e); }
});

export default function WalkLoggerScreen() {
  useKeepAwake();
  const mapRef = useRef<MapView>(null);
  const [running,setRunning]       = useState(false);
  const [trail,setTrail]           = useState<GpsPoint[]>([]);
  const [currentPos,setCurrentPos] = useState<GpsPoint|null>(null);
  const [elapsed,setElapsed]       = useState(0);
  const [pointCount,setPointCount] = useState(0);
  const [note,setNote]             = useState("");
  const [tripType,setTripType]     = useState<TripType>("walk");
  const [weather,setWeather]       = useState<Weather|null>(null);
  const [heartRate,setHeartRate]   = useState<number|null>(null);
  const [lidarAlt,setLidarAlt]     = useState<number|null>(null);
  const [sessionName] = useState("walk_"+new Date().toISOString().slice(0,16).replace("T","_").replace(":","h"));

  const { snapshot:motionSnapshot, available:sensorAvail } = useMotionSensors(running);
  const { getSnapshot:healthSnap, snapshot:hkData } = useHealthKit(running);

  const fgWatchRef  = useRef<Location.LocationSubscription|null>(null);
  const timerRef    = useRef<ReturnType<typeof setInterval>|null>(null);
  const autosaveRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const weatherPoll = useRef<ReturnType<typeof setInterval>|null>(null);
  const trailRef    = useRef<GpsPoint[]>([]);
  const elapsedRef  = useRef(0);
  const weatherRef  = useRef<Weather|null>(null);
  const heartRateRef= useRef<number|null>(null);

  const fetchWeather = useCallback(async (lat:number,lon:number) => {
    try {
      const data = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kmh&timezone=auto`).then(r=>r.json());
      const c = data?.current; if(!c) return;
      const w:Weather = { temp_c:Math.round(c.temperature_2m??0), wind_kph:Math.round(c.wind_speed_10m??0), wind_dir_deg:c.wind_direction_10m??0, gust_kph:Math.round(c.wind_gusts_10m??0), fetched_at:Date.now() };
      setWeather(w); weatherRef.current=w;
    } catch(_) {}
  },[]);

  const tryLiDAR = useCallback(()=>{ try { const L=(global as any).WalkLoggerLiDAR; if(!L)return; L.startSession((a:number)=>setLidarAlt(a)); }catch(_){} },[]);

  useEffect(()=>{
    (async()=>{
      const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(()=>false);
      setRunning(started); if(started) startForegroundWatch();
      await syncTrailFromFile();
      fetchWeather(ALCOTT_TRAIL.latitude,ALCOTT_TRAIL.longitude);
      tryLiDAR();
      try {
        const info = await FileSystem.getInfoAsync(AUTOSAVE_FILE);
        if(info.exists){
          const saved = JSON.parse(await FileSystem.readAsStringAsync(AUTOSAVE_FILE));
          if(saved?.points?.length>0){
            Alert.alert("Unsaved walk found",`${saved.points.length} points from ${saved.autosaved_at}. Recover it?`,[
              {text:"Recover & Export",onPress:async()=>{ trailRef.current=saved.points; setTrail(saved.points); setPointCount(saved.points.length); setNote(saved.note??""); setTripType(saved.trip_type??"walk"); await exportGeoJSON(saved.points,saved.note??"",saved.trip_type??"walk",saved.elapsed??0); await FileSystem.deleteAsync(AUTOSAVE_FILE,{idempotent:true}); }},
              {text:"Discard",style:"destructive",onPress:()=>FileSystem.deleteAsync(AUTOSAVE_FILE,{idempotent:true})},
            ]);
          }
        }
      }catch(_){}
    })();
    return ()=>cleanup();
  },[]);

  useEffect(()=>{
    if(running){ timerRef.current=setInterval(()=>{elapsedRef.current+=1;setElapsed(e=>e+1);},1000); }
    else { if(timerRef.current) clearInterval(timerRef.current); }
    return ()=>{ if(timerRef.current) clearInterval(timerRef.current); };
  },[running]);

  const cleanup=()=>{ fgWatchRef.current?.remove(); [timerRef,autosaveRef,weatherPoll].forEach(r=>{if(r.current)clearInterval(r.current);}); };

  const syncTrailFromFile=async()=>{
    try{
      const info=await FileSystem.getInfoAsync(LOG_FILE); if(!info.exists)return;
      const points=( await FileSystem.readAsStringAsync(LOG_FILE)).trim().split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)as GpsPoint;}catch{return null;}}).filter(Boolean)as GpsPoint[];
      trailRef.current=points; setTrail(points); setPointCount(points.length);
      if(points.length) setCurrentPos(points[points.length-1]);
    }catch(e){console.log("Sync:",e);}
  };

  const startAutosave=(n:string,tt:TripType)=>{
    if(autosaveRef.current)clearInterval(autosaveRef.current);
    autosaveRef.current=setInterval(async()=>{
      try{ await FileSystem.writeAsStringAsync(AUTOSAVE_FILE,JSON.stringify({session:sessionName,points:trailRef.current,note:n,trip_type:tt,elapsed:elapsedRef.current,autosaved_at:new Date().toLocaleTimeString()})); }catch(_){}
    },AUTOSAVE_MS);
  };

  const startForegroundWatch=async()=>{
    fgWatchRef.current?.remove();
    fgWatchRef.current=await Location.watchPositionAsync(
      {accuracy:Location.Accuracy.BestForNavigation,timeInterval:1000,distanceInterval:0},
      (loc)=>{
        const w=weatherRef.current; const ms=motionSnapshot(); const hs=healthSnap();
        const p:GpsPoint={
          timestamp_ms:loc.timestamp, iso_time:new Date(loc.timestamp).toISOString(),
          latitude:loc.coords.latitude, longitude:loc.coords.longitude,
          altitude:loc.coords.altitude??null, accuracy:loc.coords.accuracy??null,
          speed_mps:loc.coords.speed??null, heading:loc.coords.heading??null,
          heart_rate:heartRateRef.current, wind_speed_mps:w?w.wind_kph/3.6:null,
          accel_x:ms.accel_x, accel_y:ms.accel_y, accel_z:ms.accel_z,
          gyro_x:ms.gyro_x, gyro_y:ms.gyro_y, gyro_z:ms.gyro_z,
          mag_x:ms.mag_x, mag_y:ms.mag_y, mag_z:ms.mag_z,
          pitch:ms.pitch, roll:ms.roll, yaw:ms.yaw,
          user_accel_x:ms.user_accel_x, user_accel_y:ms.user_accel_y, user_accel_z:ms.user_accel_z,
          pressure_hpa:ms.pressure_hpa, pressure_alt_m:ms.pressure_alt_m, cadence_spm:ms.cadence_spm,
          hk_hr:hs.heart_rate, hk_hrv:hs.hrv, hk_temp_c:hs.wrist_temp_c, hk_spo2:hs.spo2, hk_cal:hs.calories_active,
        };
        setCurrentPos(p);
        setTrail(prev=>{const next=[...prev,p];trailRef.current=next;setPointCount(next.length);return next;});
        mapRef.current?.animateCamera({center:{latitude:p.latitude,longitude:p.longitude},zoom:18},{duration:500});
      }
    );
  };

  const handleStart=async()=>{
    try{
      const fg=await Location.requestForegroundPermissionsAsync(); if(fg.status!=="granted"){Alert.alert("Permission needed","Foreground location required.");return;}
      const bg=await Location.requestBackgroundPermissionsAsync(); if(bg.status!=="granted"){Alert.alert("Permission needed","Settings â Privacy â Location Services â Walk Logger â Always.");return;}
      await FileSystem.deleteAsync(LOG_FILE,{idempotent:true});
      trailRef.current=[];setTrail([]);setPointCount(0);setElapsed(0);elapsedRef.current=0;
      await Location.startLocationUpdatesAsync(LOCATION_TASK,{accuracy:Location.Accuracy.BestForNavigation,timeInterval:1000,distanceInterval:0,pausesUpdatesAutomatically:false,showsBackgroundLocationIndicator:true});
      await startForegroundWatch(); startAutosave(note,tripType);
      if(currentPos){ fetchWeather(currentPos.latitude,currentPos.longitude); weatherPoll.current=setInterval(()=>fetchWeather(currentPos.latitude,currentPos.longitude),30_000); }
      setRunning(true);
    }catch(e:any){Alert.alert("Start failed",String(e));}
  };

  const handleStop=async()=>{
    try{
      await Location.stopLocationUpdatesAsync(LOCATION_TASK); fgWatchRef.current?.remove();
      [autosaveRef,weatherPoll].forEach(r=>{if(r.current)clearInterval(r.current);}); setRunning(false); await syncTrailFromFile();
    }catch(e:any){Alert.alert("Stop failed",String(e));}
  };

  const exportGeoJSON=async(points:GpsPoint[],expNote:string,expType:string,expElapsed:number)=>{
    if(!points.length){Alert.alert("No data","Record a walk first.");return;}
    const geojson={
      type:"FeatureCollection",
      properties:{session:sessionName,points:points.length,duration_sec:expElapsed,exported_at:new Date().toISOString(),source:"towntrip-walk-logger",note:expNote.trim(),trip_type:expType,sensors_active:Object.entries(sensorAvail).filter(([,v])=>v).map(([k])=>k)},
      features:[
        {type:"Feature",geometry:{type:"LineString",coordinates:points.map(p=>[p.longitude,p.latitude,p.altitude??0])},properties:{session:sessionName,start:points[0]?.iso_time,end:points[points.length-1]?.iso_time,points:points.length}},
        ...points.map((p,i)=>({type:"Feature",geometry:{type:"Point",coordinates:[p.longitude,p.latitude,p.altitude??0]},properties:{
          i,timestamp_ms:p.timestamp_ms,iso_time:p.iso_time,speed_mps:p.speed_mps,heading:p.heading,accuracy:p.accuracy,
          heart_rate:p.heart_rate,wind_speed_mps:p.wind_speed_mps,
          accel_x:p.accel_x,accel_y:p.accel_y,accel_z:p.accel_z,
          gyro_x:p.gyro_x,gyro_y:p.gyro_y,gyro_z:p.gyro_z,
          mag_x:p.mag_x,mag_y:p.mag_y,mag_z:p.mag_z,
          pitch:p.pitch,roll:p.roll,yaw:p.yaw,
          user_accel_x:p.user_accel_x,user_accel_y:p.user_accel_y,user_accel_z:p.user_accel_z,
          pressure_hpa:p.pressure_hpa,pressure_alt_m:p.pressure_alt_m,cadence_spm:p.cadence_spm,
            hk_hr:p.hk_hr,hk_hrv:p.hk_hrv,hk_temp_c:p.hk_temp_c,hk_spo2:p.hk_spo2,hk_cal:p.hk_cal,
          is_stopped:p.speed_mps!==null&&p.speed_mps>=0&&p.speed_mps<0.3,
        }})),
      ],
    };
    const outPath=FileSystem.documentDirectory+sessionName+".geojson";
    await FileSystem.writeAsStringAsync(outPath,JSON.stringify(geojson,null,2));
    await Sharing.shareAsync(outPath);
    await FileSystem.deleteAsync(AUTOSAVE_FILE,{idempotent:true});
  };

  const handleExport=async()=>{ try{await exportGeoJSON(trail,note,tripType,elapsed);}catch(e:any){Alert.alert("Export failed",String(e));} };
  const formatTime=(s:number)=>Math.floor(s/60).toString().padStart(2,"0")+":"+( s%60).toString().padStart(2,"0");
  const speedKmh=currentPos?.speed_mps!=null?(currentPos.speed_mps*3.6).toFixed(1):"--";
  const trailCoords=trail.map(p=>({latitude:p.latitude,longitude:p.longitude}));
  const windLabel=weather?`${weather.wind_kph} km/h ${degToDir(weather.wind_dir_deg)}`:"--";
  const gustExtra=weather&&weather.gust_kph>weather.wind_kph+5?` â${weather.gust_kph}`:"";
  const sensorDots=[{label:"A",key:"accelerometer"},{label:"G",key:"gyroscope"},{label:"M",key:"magnetometer"},{label:"D",key:"deviceMotion"},{label:"B",key:"barometer"}] as const;

  return (
    <View style={s.container}>
      <MapView ref={mapRef} style={s.map} provider={PROVIDER_DEFAULT}
        initialRegion={{latitude:ALCOTT_TRAIL.latitude,longitude:ALCOTT_TRAIL.longitude,latitudeDelta:0.004,longitudeDelta:0.004}}
        showsUserLocation showsTraffic showsCompass mapType="hybrid">
        {trailCoords.length>1&&<Polyline coordinates={trailCoords} strokeColor="#00E5FF" strokeWidth={4}/>}
        {currentPos&&<Marker coordinate={{latitude:currentPos.latitude,longitude:currentPos.longitude}} anchor={{x:0.5,y:0.5}}><View style={s.dot}/></Marker>}
      </MapView>

      <View style={s.weatherBar}>
        <Text style={s.wi}>TEMP {weather?`${weather.temp_c}C`:"--"}</Text>
        <Text style={s.wi}>WIND {windLabel}{gustExtra}</Text>
        {currentPos?.pressure_hpa&&<Text style={s.wi}>BARO {currentPos.pressure_hpa.toFixed(0)}hPa</Text>}
        {lidarAlt!==null&&<Text style={s.wi}>ALT {lidarAlt.toFixed(1)}m</Text>}
        <View style={s.dots}>
          {sensorDots.map(({label,key})=>(
            <View key={key} style={[s.sdot,{backgroundColor:running&&(sensorAvail as any)[key]?"#00E5FF":"#2a2a2a"}]}>
              <Text style={s.sdotL}>{label}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={s.statsBar}>
        <View style={s.stat}><Text style={s.sv}>{formatTime(elapsed)}</Text><Text style={s.sl}>TIME</Text></View>
        <View style={s.stat}><Text style={s.sv}>{speedKmh}</Text><Text style={s.sl}>KM/H</Text></View>
        <View style={s.stat}><Text style={s.sv}>{currentPos?.cadence_spm??("--")}</Text><Text style={s.sl}>SPM</Text></View>
        <View style={s.stat}>
          <Text style={s.sv}>{hkData.heart_rate!==null?hkData.heart_rate:(currentPos?.altitude!=null?currentPos.altitude.toFixed(0)+"m":"--")}</Text>
          <Text style={s.sl}>{hkData.heart_rate!==null?"BPM♥":"ALT"}</Text>
        </View>
      </View>

      <View style={s.sessionBar}>
        <View style={[s.statusDot,{backgroundColor:running?"#4CAF50":"#555"}]}/>
        <Text style={s.sessionText} numberOfLines={1}>{sessionName}</Text>
        <Text style={s.tripLabel}>{tripType}</Text>
        <Text style={s.ptCount}>{pointCount}</Text>
      </View>

      {!running&&(
        <View style={s.tripRow}>
          {TRIP_TYPES.map(t=>(
            <Pressable key={t} style={[s.tripBtn,tripType===t&&s.tripBtnA]} onPress={()=>setTripType(t)}>
              <Text style={[s.tripBtnT,tripType===t&&s.tripBtnTA]}>{t}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <TextInput style={s.noteInput} placeholder="Session note" placeholderTextColor="#444" value={note} onChangeText={setNote} multiline/>

      <View style={s.controls}>
        {!running
          ?<Pressable style={[s.btn,s.btnStart]} onPress={handleStart}><Text style={s.btnT}>▶ START</Text></Pressable>
          :<Pressable style={[s.btn,s.btnStop]}  onPress={handleStop}><Text style={s.btnT}>■ STOP</Text></Pressable>
        }
        <Pressable style={[s.btn,s.btnExport,trail.length===0&&s.btnDis]} onPress={handleExport} disabled={trail.length===0}>
          <Text style={s.btnT}>↑ EXPORT</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container:{flex:1,backgroundColor:"#0A0A0A"}, map:{flex:1},
  dot:{width:16,height:16,borderRadius:8,backgroundColor:"#00E5FF",borderWidth:3,borderColor:"#fff"},
  weatherBar:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",backgroundColor:"#0D1117",paddingVertical:5,paddingHorizontal:12,borderTopWidth:1,borderTopColor:"#1A2030"},
  wi:{color:"#A0B8D0",fontSize:11,fontWeight:"500"},
  dots:{flexDirection:"row",gap:3},
  sdot:{width:16,height:16,borderRadius:3,alignItems:"center",justifyContent:"center"},
  sdotL:{color:"#fff",fontSize:8,fontWeight:"700"},
  statsBar:{flexDirection:"row",backgroundColor:"#0A0A0A",paddingVertical:12,paddingHorizontal:8,borderTopWidth:1,borderTopColor:"#1E1E1E"},
  stat:{flex:1,alignItems:"center"}, sv:{color:"#FFF",fontSize:22,fontWeight:"700"}, sl:{color:"#666",fontSize:10,marginTop:2,letterSpacing:1},
  sessionBar:{flexDirection:"row",alignItems:"center",backgroundColor:"#111",paddingHorizontal:16,paddingVertical:8,gap:8},
  statusDot:{width:8,height:8,borderRadius:4},
  sessionText:{color:"#888",fontSize:12,flex:1,fontFamily:Platform.OS==="ios"?"Menlo":"monospace"},
  tripLabel:{color:"#00E5FF",fontSize:11,fontWeight:"600",letterSpacing:1},
  ptCount:{color:"#444",fontSize:11},
  tripRow:{flexDirection:"row",gap:8,paddingHorizontal:16,paddingVertical:8,backgroundColor:"#0A0A0A"},
  tripBtn:{flex:1,paddingVertical:7,borderRadius:8,borderWidth:1,borderColor:"#2a2a2a",alignItems:"center"},
  tripBtnA:{borderColor:"#00E5FF",backgroundColor:"#00E5FF18"},
  tripBtnT:{color:"#555",fontSize:12,fontWeight:"600",letterSpacing:0.5},
  tripBtnTA:{color:"#00E5FF"},
  noteInput:{backgroundColor:"#111",color:"#ccc",fontSize:12,paddingHorizontal:16,paddingVertical:10,minHeight:40,borderTopWidth:1,borderTopColor:"#1E1E1E"},
  controls:{flexDirection:"row",gap:12,paddingHorizontal:16,paddingBottom:36,paddingTop:12,backgroundColor:"#0A0A0A"},
  btn:{flex:1,paddingVertical:16,borderRadius:12,alignItems:"center",justifyContent:"center"},
  btnStart:{backgroundColor:"#00C853"}, btnStop:{backgroundColor:"#D50000"}, btnExport:{backgroundColor:"#0288D1"},
  btnDis:{opacity:0.4}, btnT:{color:"#fff",fontSize:15,fontWeight:"700",letterSpacing:0.5},
});
