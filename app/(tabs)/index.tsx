import React, { useEffect, useRef, useState, useCallback } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import * as Location from "expo-location";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as TaskManager from "expo-task-manager";
import { useKeepAwake } from "expo-keep-awake";
import MapView, { Polyline, Marker, PROVIDER_DEFAULT } from "react-native-maps";
import { useMotionSensors } from "../../hooks/useMotionSensors";
import { useHealthKit } from "../../hooks/useHealthKit";
import { useHealthSync } from "../../hooks/useHealthSync";
import { useBLE } from "../../hooks/useBLE";

const LOCATION_TASK = "towntrip-background-location";
const ALCOTT_TRAIL = { latitude: 40.8699, longitude: -73.8318 };
const LOG_FILE = FileSystem.documentDirectory + "towntrip_trail_points.jsonl";
const SESSIONS_DIR = FileSystem.documentDirectory + "towntrip_sessions/";
const AUTOSAVE_FILE = FileSystem.documentDirectory + "towntrip_session_autosave.json";
const AUTOSAVE_MS = 60000;
const TRIP_TYPES = ["walk", "transit", "run"] as const;
type TripType = typeof TRIP_TYPES[number];
const WIND_DIRS = ["N","NE","E","SE","S","SW","W","NW"];
const SB_URL = "https://xyfyuvikqmxcazqgqoxb.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5Znl1dmlrcW14Y2F6cWdxb3hiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2Njg3NTgsImV4cCI6MjA4ODI0NDc1OH0.HpVmJtUzXSqPBsF0rBgGbWjHaFPYNvHIoBbCfTVJEiQ";
const POLLEN_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_POLLEN_KEY ?? "";

function degToDir(deg: number) { return WIND_DIRS[Math.round(deg / 45) % 8]; }
function pollenEmoji(upi: number | null): string { if (upi === null) return "🌿"; if (upi === 0) return "✅"; if (upi <= 1) return "🟢"; if (upi <= 2) return "🟡"; if (upi <= 3) return "🟠"; if (upi <= 4) return "🔴"; return "🟣"; }
function tempEmoji(c: number | null): string { if (c === null) return "🌡️"; if (c <= 0) return "🥶"; if (c <= 10) return "🧥"; if (c <= 18) return "🌤️"; if (c <= 25) return "\u2600\uFE0F"; if (c <= 32) return "🥵"; return "🔥"; }
function windEmoji(kph: number | null): string { if (kph === null) return "🌬️"; if (kph < 5) return "🍃"; if (kph < 20) return "💨"; if (kph < 40) return "🌬️"; return "🌪️"; }
function hrEmoji(bpm: number | null): string { if (bpm === null) return "💓"; if (bpm < 60) return "😴"; if (bpm < 90) return "🚶"; if (bpm < 120) return "🏃"; if (bpm < 150) return "\u26A1"; return "🔥"; }
function spo2Emoji(pct: number | null): string { if (pct === null) return "🩸"; if (pct >= 97) return "✅"; if (pct >= 94) return "🟡"; return "🔴"; }

function gradeColor(slope: number): string {
  const abs = Math.abs(slope);
  if (abs < 0.03) return "transparent";
  if (abs < 0.08) return "#FFD600";
  if (abs < 0.15) return "#FF6D00";
  return "#D50000";
}
function calcGrade(p1: GpsPoint, p2: GpsPoint): number {
  const dx = haversineM(p1.latitude, p1.longitude, p2.latitude, p2.longitude);
  if (dx < 1) return 0;
  return ((p2.altitude ?? 0) - (p1.altitude ?? 0)) / dx;
}
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const f1 = lat1 * Math.PI / 180, f2 = lat2 * Math.PI / 180;
  const df = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(df/2)**2 + Math.cos(f1)*Math.cos(f2)*Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

type GpsPoint = {
  timestamp_ms: number; iso_time: string; latitude: number; longitude: number;
  altitude: number|null; accuracy: number|null; speed_mps: number|null; heading: number|null;
  ble_hr: number|null; ble_rr: number[]|null; ble_battery: number|null;
  accel_x: number|null; accel_y: number|null; accel_z: number|null;
  gyro_x: number|null; gyro_y: number|null; gyro_z: number|null;
  mag_x: number|null; mag_y: number|null; mag_z: number|null;
  pitch: number|null; roll: number|null; yaw: number|null;
  user_accel_x: number|null; user_accel_y: number|null; user_accel_z: number|null;
  pressure_hpa: number|null; pressure_alt_m: number|null; cadence_spm: number|null;
  hk_hr: number|null; hk_hrv: number|null; hk_temp_c: number|null; hk_spo2: number|null; hk_cal: number|null;
  wind_speed_mps: number|null; temp_c: number|null;
  pollen_tree_upi: number|null; pollen_grass_upi: number|null; pollen_weed_upi: number|null;
};
type Weather = { temp_c: number; wind_kph: number; wind_dir_deg: number; gust_kph: number; fetched_at: number; };
type Pollen = { tree_upi: number|null; grass_upi: number|null; weed_upi: number|null; dominant: string|null; fetched_at: number; fordham_grains: number|null; };

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }: any) => {
  if (error) return;
  const locations = data?.locations ?? [];
  if (!locations.length) return;
  const lines = locations.map((loc: any) => JSON.stringify({ timestamp_ms: loc.timestamp ?? Date.now(), iso_time: new Date(loc.timestamp ?? Date.now()).toISOString(), latitude: loc.coords?.latitude, longitude: loc.coords?.longitude, altitude: loc.coords?.altitude ?? null, accuracy: loc.coords?.accuracy ?? null, speed_mps: loc.coords?.speed ?? null, heading: loc.coords?.heading ?? null })).join("\n") + "\n";
  try { const info = await FileSystem.getInfoAsync(LOG_FILE); const prev = info.exists ? await FileSystem.readAsStringAsync(LOG_FILE) : ""; await FileSystem.writeAsStringAsync(LOG_FILE, prev + lines); } catch {}
});

function PollenSurveyModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [saving, setSaving] = useState(false);
  const [todayPollen, setTodayPollen] = useState<{tree_upi?: number|null; fordham?: number|null} | null>(null);
  const [eyesSev, setEyesSev] = useState(0);
  const [eyesItchy, setEyesItchy] = useState(false);
  const [eyesWatery, setEyesWatery] = useState(false);
  const [eyesStrings, setEyesStrings] = useState(false);
  const [eyesTaps, setEyesTaps] = useState(0);
  const [noseSev, setNoseSev] = useState(0);
  const [noseRunny, setNoseRunny] = useState(false);
  const [noseStuffy, setNoseStuffy] = useState(false);
  const [noseSneezing, setNoseSneezing] = useState(false);
  const [sneezingBouts, setSneezingBouts] = useState(0);
  const [earItch, setEarItch] = useState(false);
  const [earSound, setEarSound] = useState(false);
  const [lungsT, setLungsT] = useState(false);
  const [lungsC, setLungsC] = useState(false);
  const [overall, setOverall] = useState(0);
  const [wentOut, setWentOut] = useState(true);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!visible) return;
    fetch(`${SB_URL}/rest/v1/pollen_symptom_log?date=eq.${today}&limit=1`, { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON } })
      .then(r => r.json()).then(rows => {
        if (rows?.length) {
          const r = rows[0];
          setEyesSev(r.eyes_severity ?? 0); setEyesItchy(!!r.eyes_itchy); setEyesWatery(!!r.eyes_watery);
          setEyesStrings(!!r.eyes_strings); setEyesTaps(r.eyes_tap_cleans ?? 0);
          setNoseSev(r.nose_severity ?? 0); setNoseRunny(!!r.nose_runny); setNoseStuffy(!!r.nose_stuffy);
          setNoseSneezing(!!r.nose_sneezing); setSneezingBouts(r.sneezing_bouts ?? 0);
          setEarItch(!!r.inner_ear_itch); setEarSound(!!r.ear_sound_made);
          setLungsT(!!r.lungs_tight); setLungsC(!!r.lungs_coughing);
          setOverall(r.overall_severity ?? 0); setWentOut(r.went_outside !== false); setNotes(r.notes ?? "");
        } else {
          setEyesSev(0); setEyesItchy(false); setEyesWatery(false); setEyesStrings(false); setEyesTaps(0);
          setNoseSev(0); setNoseRunny(false); setNoseStuffy(false); setNoseSneezing(false); setSneezingBouts(0);
          setEarItch(false); setEarSound(false); setLungsT(false); setLungsC(false);
          setOverall(0); setWentOut(true); setNotes("");
        }
      }).catch(() => {});
    Promise.all([
      fetch(`${SB_URL}/rest/v1/pollen_history?date=eq.${today}&location_name=eq.bronx_10475&source=eq.google_pollen&limit=1`, { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON } }).then(r => r.json()),
      fetch(`${SB_URL}/rest/v1/pollen_history?date=eq.${today}&location_name=eq.lincoln_center_nyc&limit=1`, { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON } }).then(r => r.json()),
    ]).then(([goog, ford]) => setTodayPollen({ tree_upi: goog?.[0]?.tree_upi ?? null, fordham: ford?.[0]?.tree_grains_m3 ?? null })).catch(() => {});
  }, [visible]);

  const save = async () => {
    setSaving(true);
    const row = { date: today, eyes_severity: eyesSev, eyes_itchy: eyesItchy, eyes_watery: eyesWatery, eyes_strings: eyesStrings, eyes_tap_cleans: eyesTaps, nose_severity: noseSev, nose_runny: noseRunny, nose_stuffy: noseStuffy, nose_sneezing: noseSneezing, sneezing_bouts: sneezingBouts, inner_ear_itch: earItch, ear_sound_made: earSound, lungs_tight: lungsT, lungs_coughing: lungsC, overall_severity: overall, went_outside: wentOut, notes, google_tree_upi: todayPollen?.tree_upi ?? null, fordham_grains_m3: todayPollen?.fordham ?? null, pollen_com_score: null };
    try {
      await fetch(`${SB_URL}/rest/v1/pollen_symptom_log`, { method: "POST", headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
      Alert.alert("Saved", "Today's symptoms logged ✓"); onClose();
    } catch { Alert.alert("Error", "Could not save."); }
    setSaving(false);
  };

  const SevRow = ({ label, val, setVal }: { label: string; val: number; setVal: (n: number) => void }) => (
    <View style={sv.sevRow}>
      <Text style={sv.sevLabel}>{label}</Text>
      <View style={sv.sevBtns}>{[0,1,2,3,4,5].map(n => (<Pressable key={n} style={[sv.sevBtn, val === n && sv.sevBtnA]} onPress={() => setVal(n)}><Text style={[sv.sevBtnT, val === n && sv.sevBtnTA]}>{n}</Text></Pressable>))}</View>
    </View>
  );
  const Toggle = ({ label, val, setVal }: { label: string; val: boolean; setVal: (b: boolean) => void }) => (
    <View style={sv.toggleRow}><Text style={sv.toggleLabel}>{label}</Text><Switch value={val} onValueChange={setVal} trackColor={{ false: "#333", true: "#00E5FF" }} thumbColor={val ? "#fff" : "#666"} /></View>
  );
  const Counter = ({ label, val, setVal }: { label: string; val: number; setVal: (n: number) => void }) => (
    <View style={sv.ctrRow}><Text style={sv.ctrLabel}>{label}</Text><View style={sv.ctrBtns}><Pressable style={sv.ctrBtn} onPress={() => setVal(Math.max(0, val-1))}><Text style={sv.ctrBtnT}>−</Text></Pressable><Text style={sv.ctrVal}>{val}</Text><Pressable style={sv.ctrBtn} onPress={() => setVal(val+1)}><Text style={sv.ctrBtnT}>+</Text></Pressable></View></View>
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={sv.container}>
        <View style={sv.header}>
          <Text style={sv.title}>🌿 Pollen Symptom Log</Text>
          <Text style={sv.date}>{today}</Text>
          {todayPollen && <Text style={sv.pollenInfo}>{todayPollen.tree_upi != null ? `Google Tree UPI: ${todayPollen.tree_upi}/5  ` : ""}{todayPollen.fordham != null ? `Fordham: ${todayPollen.fordham} g/m³` : ""}</Text>}
          <Pressable style={sv.closeBtn} onPress={onClose}><Text style={sv.closeBtnT}>✕</Text></Pressable>
        </View>
        <ScrollView style={sv.scroll} contentContainerStyle={{ paddingBottom: 40 }}>
          <Text style={sv.section}>👁 EYES</Text>
          <SevRow label="Severity (0-5)" val={eyesSev} setVal={setEyesSev} />
          <Toggle label="Itchy" val={eyesItchy} setVal={setEyesItchy} />
          <Toggle label="Watery" val={eyesWatery} setVal={setEyesWatery} />
          <Toggle label="Strings / mucus" val={eyesStrings} setVal={setEyesStrings} />
          <Counter label="Tap cleans (sink)" val={eyesTaps} setVal={setEyesTaps} />
          <Text style={sv.section}>👃 NOSE</Text>
          <SevRow label="Severity (0-5)" val={noseSev} setVal={setNoseSev} />
          <Toggle label="Runny" val={noseRunny} setVal={setNoseRunny} />
          <Toggle label="Stuffy / blocked" val={noseStuffy} setVal={setNoseStuffy} />
          <Toggle label="Sneezing" val={noseSneezing} setVal={setNoseSneezing} />
          <Counter label="Sneezing bouts" val={sneezingBouts} setVal={setSneezingBouts} />
          <Text style={sv.section}>👂 EARS</Text>
          <Toggle label="Inner ear itch" val={earItch} setVal={setEarItch} />
          <Toggle label="Made the sound to relieve" val={earSound} setVal={setEarSound} />
          <Text style={sv.section}>🫁 LUNGS</Text>
          <Toggle label="Tight / pressure" val={lungsT} setVal={setLungsT} />
          <Toggle label="Coughing" val={lungsC} setVal={setLungsC} />
          <Text style={sv.section}>📊 OVERALL</Text>
          <SevRow label="Overall severity (0-5)" val={overall} setVal={setOverall} />
          <Toggle label="Went outside today" val={wentOut} setVal={setWentOut} />
          <Text style={sv.section}>📝 NOTES</Text>
          <TextInput style={sv.notes} placeholder="Any extra detail..." placeholderTextColor="#555" value={notes} onChangeText={setNotes} multiline numberOfLines={3} />
          <Pressable style={[sv.saveBtn, saving && sv.saveBtnDis]} onPress={save} disabled={saving}>
            <Text style={sv.saveBtnT}>{saving ? "Saving..." : "SAVE TODAY"}</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}


const TRIP_MODES = ["walk","run","bus","subway","bike","other"];
const TRIP_LOG_FILE = FileSystem.documentDirectory + "towntrip_trip_log.jsonl";

function TripLogModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [mode, setMode] = useState("walk");
  const [route, setRoute] = useState("");
  const [origin, setOrigin] = useState("");
  const [dest, setDest] = useState("");
  const [dur, setDur] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState<any[]>([]);
  const [showRecent, setShowRecent] = useState(false);
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const info = await FileSystem.getInfoAsync(TRIP_LOG_FILE);
        if (!info.exists) return;
        const lines = (await FileSystem.readAsStringAsync(TRIP_LOG_FILE)).trim().split("\n").filter(Boolean);
        setRecent(lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse().slice(0,20));
      } catch {}
    })();
  }, [visible]);
  const MC: Record<string,string> = {walk:"#00E5FF",run:"#00C853",bus:"#FFA000",subway:"#9C27B0",bike:"#00BFA5",other:"#616161"};
  const save = async () => {
    setSaving(true);
    const entry = { id: Date.now().toString(), logged_at: new Date().toISOString(), mode, route: route.trim(), origin: origin.trim(), destination: dest.trim(), duration_min: dur ? parseFloat(dur) : null, notes: notes.trim() };
    try {
      const info = await FileSystem.getInfoAsync(TRIP_LOG_FILE);
      const prev = info.exists ? await FileSystem.readAsStringAsync(TRIP_LOG_FILE) : "";
      await FileSystem.writeAsStringAsync(TRIP_LOG_FILE, prev + JSON.stringify(entry) + "\n");
      Alert.alert("Saved", mode + " trip logged ✓");
      setMode("walk"); setRoute(""); setOrigin(""); setDest(""); setDur(""); setNotes("");
      onClose();
    } catch(e: any) { Alert.alert("Error", String(e)); }
    setSaving(false);
  };
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{flex:1,backgroundColor:"#090909"}}>
        <View style={{backgroundColor:"#111",paddingTop:20,paddingBottom:12,paddingHorizontal:20,borderBottomWidth:1,borderBottomColor:"#1E1E1E",flexDirection:"row",alignItems:"center"}}>
          <Text style={{color:"#00E5FF",fontSize:17,fontWeight:"700",flex:1}}>📍 Log Trip</Text>
          <Pressable onPress={() => setShowRecent(v => !v)} style={{paddingHorizontal:12,paddingVertical:4,backgroundColor:"#1A2A3A",borderRadius:6,marginRight:8}}>
            <Text style={{color:"#00E5FF",fontSize:12,fontWeight:"600"}}>{showRecent ? "New" : "History"}</Text>
          </Pressable>
          <Pressable onPress={onClose}><Text style={{color:"#555",fontSize:18}}>✕</Text></Pressable>
        </View>
        {showRecent ? (
          <ScrollView style={{flex:1}} contentContainerStyle={{paddingBottom:40,paddingHorizontal:20,paddingTop:12}}>
            {recent.length === 0 && <Text style={{color:"#444",marginTop:40,textAlign:"center"}}>No trips logged yet.</Text>}
            {recent.map((e,i) => (
              <View key={i} style={{flexDirection:"row",alignItems:"center",paddingVertical:12,borderBottomWidth:1,borderBottomColor:"#151515"}}>
                <View style={{paddingHorizontal:8,paddingVertical:3,borderRadius:5,backgroundColor:MC[e.mode]||"#444"}}><Text style={{color:"#000",fontSize:11,fontWeight:"700"}}>{e.mode}</Text></View>
                <View style={{flex:1,marginLeft:10}}>
                  <Text style={{color:"#ccc",fontSize:13,fontWeight:"600"}}>{e.route||e.destination||e.origin||"—"}</Text>
                  <Text style={{color:"#444",fontSize:11,marginTop:2}}>{(e.logged_at||"").slice(0,16).replace("T"," ")}{e.duration_min?" · "+e.duration_min+"min":""}</Text>
                  {e.notes ? <Text style={{color:"#555",fontSize:11,fontStyle:"italic"}} numberOfLines={1}>{e.notes}</Text> : null}
                </View>
              </View>
            ))}
          </ScrollView>
        ) : (
          <ScrollView style={{flex:1}} contentContainerStyle={{paddingBottom:40,paddingHorizontal:20,paddingTop:12}}>
            <Text style={{color:"#446688",fontSize:11,fontWeight:"700",letterSpacing:1,marginTop:14,marginBottom:8}}>MODE</Text>
            <View style={{flexDirection:"row",flexWrap:"wrap",gap:8,marginBottom:14}}>
              {TRIP_MODES.map(m => (
                <Pressable key={m} onPress={() => setMode(m)} style={{paddingHorizontal:14,paddingVertical:8,borderRadius:8,borderWidth:1,borderColor:mode===m?(MC[m]||"#00E5FF"):"#222",backgroundColor:mode===m?(MC[m]+"22"):"transparent"}}>
                  <Text style={{color:mode===m?(MC[m]||"#00E5FF"):"#555",fontSize:12,fontWeight:"600"}}>{m}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={{color:"#446688",fontSize:11,fontWeight:"700",letterSpacing:1,marginBottom:6}}>ROUTE / LINE</Text>
            <TextInput style={{backgroundColor:"#111",color:"#ccc",fontSize:14,padding:12,borderRadius:8,borderWidth:1,borderColor:"#1E1E1E",marginBottom:14}} placeholder="Bx12, 6 train, Walk to park..." placeholderTextColor="#333" value={route} onChangeText={setRoute} />
            <Text style={{color:"#446688",fontSize:11,fontWeight:"700",letterSpacing:1,marginBottom:6}}>FROM → TO</Text>
            <View style={{flexDirection:"row",gap:8,marginBottom:14}}>
              <TextInput style={{flex:1,backgroundColor:"#111",color:"#ccc",fontSize:14,padding:12,borderRadius:8,borderWidth:1,borderColor:"#1E1E1E"}} placeholder="Origin" placeholderTextColor="#333" value={origin} onChangeText={setOrigin} />
              <TextInput style={{flex:1,backgroundColor:"#111",color:"#ccc",fontSize:14,padding:12,borderRadius:8,borderWidth:1,borderColor:"#1E1E1E"}} placeholder="Destination" placeholderTextColor="#333" value={dest} onChangeText={setDest} />
            </View>
            <Text style={{color:"#446688",fontSize:11,fontWeight:"700",letterSpacing:1,marginBottom:6}}>DURATION (min)</Text>
            <TextInput style={{backgroundColor:"#111",color:"#ccc",fontSize:14,padding:12,borderRadius:8,borderWidth:1,borderColor:"#1E1E1E",marginBottom:14}} placeholder="23" placeholderTextColor="#333" value={dur} onChangeText={setDur} keyboardType="numeric" />
            <Text style={{color:"#446688",fontSize:11,fontWeight:"700",letterSpacing:1,marginBottom:6}}>NOTES</Text>
            <TextInput style={{backgroundColor:"#111",color:"#ccc",fontSize:14,padding:12,borderRadius:8,borderWidth:1,borderColor:"#1E1E1E",marginBottom:20,minHeight:70}} placeholder="Crowded, fast, knees hurt..." placeholderTextColor="#333" value={notes} onChangeText={setNotes} multiline />
            <Pressable style={{backgroundColor:"#003A5C",borderRadius:11,paddingVertical:15,alignItems:"center",borderWidth:1,borderColor:"#00517A",opacity:saving?0.4:1}} onPress={save} disabled={saving}>
              <Text style={{color:"#00E5FF",fontSize:14,fontWeight:"800",letterSpacing:1}}>{saving?"Saving...":"LOG TRIP"}</Text>
            </Pressable>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function SessionsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!visible) return;
    (async () => {
      setLoading(true);
      try {
        await FileSystem.makeDirectoryAsync(SESSIONS_DIR, { intermediates: true }).catch(() => {});
        const files = (await FileSystem.readDirectoryAsync(SESSIONS_DIR).catch(() => [] as string[])).filter(f => f.endsWith(".geojson") && !f.startsWith("._")).sort().reverse();
        const loaded: any[] = [];
        for (const f of files.slice(0,30)) {
          try {
            const raw = await FileSystem.readAsStringAsync(SESSIONS_DIR + f);
            const data = JSON.parse(raw);
            const props = data.properties || {};
            loaded.push({ name: f.replace(".geojson",""), path: SESSIONS_DIR+f, pts: props.points||0, date: (props.exported_at||"").slice(0,10), note: props.note||"" });
          } catch {}
        }
        setSessions(loaded);
      } catch {}
      setLoading(false);
    })();
  }, [visible]);
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{flex:1,backgroundColor:"#0A0A0A"}}>
        <View style={{backgroundColor:"#111",paddingTop:20,paddingBottom:12,paddingHorizontal:20,borderBottomWidth:1,borderBottomColor:"#1E1E1E",flexDirection:"row",alignItems:"center"}}>
          <Text style={{color:"#00E5FF",fontSize:17,fontWeight:"700",flex:1}}>🗂 Saved Walks</Text>
          <Pressable onPress={onClose}><Text style={{color:"#555",fontSize:18}}>✕</Text></Pressable>
        </View>
        <ScrollView style={{flex:1}} contentContainerStyle={{paddingBottom:40}}>
          {loading && <Text style={{color:"#333",textAlign:"center",marginTop:60}}>Loading...</Text>}
          {!loading && sessions.length===0 && <Text style={{color:"#333",fontSize:14,textAlign:"center",marginTop:60,lineHeight:24}}>{"No saved walks yet.\nFinish a walk and tap SAVE."}</Text>}
          {sessions.map((s,i) => (
            <Pressable key={i} onPress={() => Sharing.shareAsync(s.path).catch(()=>{})} style={{flexDirection:"row",alignItems:"center",paddingHorizontal:20,paddingVertical:14,borderBottomWidth:1,borderBottomColor:"#151515"}}>
              <View style={{flex:1}}>
                <Text style={{color:"#ccc",fontSize:13}}>{s.name}</Text>
                <Text style={{color:"#444",fontSize:11,marginTop:3}}>{s.pts} pts{s.date?" · "+s.date:""}</Text>
                {s.note?<Text style={{color:"#555",fontSize:11,marginTop:2,fontStyle:"italic"}} numberOfLines={1}>{s.note}</Text>:null}
              </View>
              <Text style={{color:"#00E5FF",fontSize:20,marginLeft:12}}>↑</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

export default function WalkLoggerScreen() {
  useKeepAwake();
  const mapRef = useRef<MapView>(null);
  const [running, setRunning] = useState(false);
  const [trail, setTrail] = useState<GpsPoint[]>([]);
  const [currentPos, setCurrentPos] = useState<GpsPoint|null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [pointCount, setPointCount] = useState(0);
  const [note, setNote] = useState("");
  const [tripType, setTripType] = useState<TripType>("walk");
  const [weather, setWeather] = useState<Weather|null>(null);
  const [pollen, setPollen] = useState<Pollen|null>(null);
  const [showInner, setShowInner] = useState(false);
  const [showSurvey, setShowSurvey] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showTripLog, setShowTripLog] = useState(false);
  const [sessionName] = useState("walk_" + new Date().toISOString().slice(0,16).replace("T","_").replace(":","h"));
  const { snapshot: motionSnapshot, available: sensorAvail } = useMotionSensors(running);
  const { getSnapshot: healthSnap, snapshot: hkData } = useHealthKit(running);
  const { sync: syncHealth, status: syncStatus } = useHealthSync();
  const { state: bleState, rescan: bleRescan } = useBLE(running);
  const fgWatchRef = useRef<Location.LocationSubscription|null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const autosaveRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const weatherPoll = useRef<ReturnType<typeof setInterval>|null>(null);
  const trailRef = useRef<GpsPoint[]>([]);
  const elapsedRef = useRef(0);
  const weatherRef = useRef<Weather|null>(null);
  const pollenRef = useRef<Pollen|null>(null);
  const bleRef = useRef(bleState);
  useEffect(() => { bleRef.current = bleState; }, [bleState]);

  const fetchWeather = useCallback(async (lat: number, lon: number) => {
    try {
      const data = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kmh&timezone=auto`).then(r => r.json());
      const c = data?.current; if (!c) return;
      const w: Weather = { temp_c: Math.round(c.temperature_2m ?? 0), wind_kph: Math.round(c.wind_speed_10m ?? 0), wind_dir_deg: c.wind_direction_10m ?? 0, gust_kph: Math.round(c.wind_gusts_10m ?? 0), fetched_at: Date.now() };
      setWeather(w); weatherRef.current = w;
    } catch {}
  }, []);

  const fetchPollen = useCallback(async (lat: number, lon: number) => {
    const today = new Date().toISOString().slice(0, 10);
    try {
      const dbr = await fetch(`${SB_URL}/rest/v1/pollen_history?date=eq.${today}&location_name=eq.bronx_10475&source=eq.google_pollen&limit=1`, { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON } }).then(r => r.json());
      if (dbr?.length) {
        const row = dbr[0];
        const fdr = await fetch(`${SB_URL}/rest/v1/pollen_history?date=eq.${today}&location_name=eq.lincoln_center_nyc&limit=1`, { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON } }).then(r => r.json());
        const pl: Pollen = { tree_upi: row.tree_upi, grass_upi: row.grass_upi, weed_upi: row.weed_upi, dominant: row.dominant_type, fetched_at: Date.now(), fordham_grains: fdr?.[0]?.tree_grains_m3 ?? null };
        setPollen(pl); pollenRef.current = pl; return;
      }
    } catch {}
    if (!POLLEN_API_KEY) return;
    try {
      const data = await fetch(`https://pollen.googleapis.com/v1/forecast:lookup?key=${POLLEN_API_KEY}&location.longitude=${lon}&location.latitude=${lat}&days=1`).then(r => r.json());
      const daily = data?.dailyInfo?.[0]; if (!daily) return;
      const getType = (code: string) => daily.pollenTypeInfo?.find((p: any) => p.code === code)?.indexInfo?.value ?? null;
      const pl: Pollen = { tree_upi: getType("TREE"), grass_upi: getType("GRASS"), weed_upi: getType("WEED"), dominant: daily.pollenTypeInfo?.reduce((best: any, p: any) => (p.indexInfo?.value ?? 0) > (best?.indexInfo?.value ?? 0) ? p : best, null)?.displayName ?? null, fetched_at: Date.now(), fordham_grains: null };
      setPollen(pl); pollenRef.current = pl;
    } catch {}
  }, []);

  useEffect(() => {
    (async () => {
      const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
      setRunning(started); if (started) startForegroundWatch();
      await FileSystem.makeDirectoryAsync(SESSIONS_DIR, { intermediates: true }).catch(() => {});
      await syncTrailFromFile();
      fetchWeather(ALCOTT_TRAIL.latitude, ALCOTT_TRAIL.longitude);
      syncHealth(30);
      fetchPollen(ALCOTT_TRAIL.latitude, ALCOTT_TRAIL.longitude);
    })();
    return () => cleanup();
  }, []);

  useEffect(() => { if (running) { timerRef.current = setInterval(() => { elapsedRef.current += 1; setElapsed(e => e + 1); }, 1000); } else { if (timerRef.current) clearInterval(timerRef.current); } return () => { if (timerRef.current) clearInterval(timerRef.current); }; }, [running]);
  const cleanup = () => { fgWatchRef.current?.remove(); [timerRef, autosaveRef, weatherPoll].forEach(r => { if (r.current) clearInterval(r.current); }); };
  const syncTrailFromFile = async () => { try { const info = await FileSystem.getInfoAsync(LOG_FILE); if (!info.exists) return; const points = (await FileSystem.readAsStringAsync(LOG_FILE)).trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l) as GpsPoint; } catch { return null; } }).filter(Boolean) as GpsPoint[]; trailRef.current = points; setTrail(points); setPointCount(points.length); if (points.length) setCurrentPos(points[points.length - 1]); } catch {} };
  const startAutosave = (n: string, tt: TripType) => { if (autosaveRef.current) clearInterval(autosaveRef.current); autosaveRef.current = setInterval(async () => { try { await FileSystem.writeAsStringAsync(AUTOSAVE_FILE, JSON.stringify({ session: sessionName, points: trailRef.current, note: n, trip_type: tt, elapsed: elapsedRef.current, autosaved_at: new Date().toLocaleTimeString() })); } catch {} }, AUTOSAVE_MS); };

  const startForegroundWatch = async () => {
    fgWatchRef.current?.remove();
    fgWatchRef.current = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 }, (loc) => {
      const w = weatherRef.current; const pl = pollenRef.current; const ms = motionSnapshot(); const hs = healthSnap(); const ble = bleRef.current;
      const p: GpsPoint = { timestamp_ms: loc.timestamp, iso_time: new Date(loc.timestamp).toISOString(), latitude: loc.coords.latitude, longitude: loc.coords.longitude, altitude: loc.coords.altitude ?? null, accuracy: loc.coords.accuracy ?? null, speed_mps: loc.coords.speed ?? null, heading: loc.coords.heading ?? null, ble_hr: ble.heartRate, ble_rr: ble.rr_intervals?.length ? ble.rr_intervals : null, ble_battery: ble.battery, accel_x: ms.accel_x, accel_y: ms.accel_y, accel_z: ms.accel_z, gyro_x: ms.gyro_x, gyro_y: ms.gyro_y, gyro_z: ms.gyro_z, mag_x: ms.mag_x, mag_y: ms.mag_y, mag_z: ms.mag_z, pitch: ms.pitch, roll: ms.roll, yaw: ms.yaw, user_accel_x: ms.user_accel_x, user_accel_y: ms.user_accel_y, user_accel_z: ms.user_accel_z, pressure_hpa: ms.pressure_hpa, pressure_alt_m: ms.pressure_alt_m, cadence_spm: ms.cadence_spm, hk_hr: hs.heart_rate, hk_hrv: hs.hrv, hk_temp_c: hs.wrist_temp_c, hk_spo2: hs.spo2, hk_cal: hs.calories_active, wind_speed_mps: w ? w.wind_kph / 3.6 : null, temp_c: w ? w.temp_c : null, pollen_tree_upi: pl?.tree_upi ?? null, pollen_grass_upi: pl?.grass_upi ?? null, pollen_weed_upi: pl?.weed_upi ?? null };
      setCurrentPos(p); setTrail(prev => { const next = [...prev, p]; trailRef.current = next; setPointCount(next.length); return next; });
      mapRef.current?.animateCamera({ center: { latitude: p.latitude, longitude: p.longitude }, zoom: 18 }, { duration: 500 });
    });
  };

  const handleStart = async () => { try { const fg = await Location.requestForegroundPermissionsAsync(); if (fg.status !== "granted") { Alert.alert("Permission needed", "Foreground location required."); return; } const bg = await Location.requestBackgroundPermissionsAsync(); if (bg.status !== "granted") { Alert.alert("Permission needed", "Settings > Privacy > Location Services > Walk Logger > Always."); return; } await FileSystem.deleteAsync(LOG_FILE, { idempotent: true }); trailRef.current = []; setTrail([]); setPointCount(0); setElapsed(0); elapsedRef.current = 0; await Location.startLocationUpdatesAsync(LOCATION_TASK, { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0, pausesUpdatesAutomatically: false, showsBackgroundLocationIndicator: true }); await startForegroundWatch(); startAutosave(note, tripType); if (currentPos) { fetchWeather(currentPos.latitude, currentPos.longitude); fetchPollen(currentPos.latitude, currentPos.longitude); weatherPoll.current = setInterval(() => { if (currentPos) { fetchWeather(currentPos.latitude, currentPos.longitude); fetchPollen(currentPos.latitude, currentPos.longitude); } }, 300000); } setRunning(true); } catch(e: any) { Alert.alert("Start failed", String(e)); } };
  const handleStop = async () => { try { await Location.stopLocationUpdatesAsync(LOCATION_TASK); fgWatchRef.current?.remove(); [autosaveRef, weatherPoll].forEach(r => { if (r.current) clearInterval(r.current); }); setRunning(false); await syncTrailFromFile(); } catch(e: any) { Alert.alert("Stop failed", String(e)); } };
  const exportGeoJSON = async (points: GpsPoint[], expNote: string, expType: string, expElapsed: number) => { if (!points.length) { Alert.alert("No data", "Record a walk first."); return; } const geojson = { type: "FeatureCollection", properties: { session: sessionName, points: points.length, duration_sec: expElapsed, exported_at: new Date().toISOString(), source: "towntrip-walk-logger", note: expNote.trim(), trip_type: expType, ble_device: bleState.deviceName, ble_battery: bleState.battery }, features: [{ type: "Feature", geometry: { type: "LineString", coordinates: points.map(p => [p.longitude, p.latitude, p.altitude ?? 0]) }, properties: { session: sessionName, start: points[0]?.iso_time, end: points[points.length-1]?.iso_time, points: points.length } }, ...points.map((p, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.longitude, p.latitude, p.altitude ?? 0] }, properties: { i, ...p } }))] }; const outPath = FileSystem.documentDirectory + sessionName + ".geojson"; await FileSystem.writeAsStringAsync(outPath, JSON.stringify(geojson, null, 2)); await Sharing.shareAsync(outPath); await FileSystem.deleteAsync(AUTOSAVE_FILE, { idempotent: true }); };
  const handleSave = async () => { try { await saveWalk(trail, note, tripType, elapsed, false); } catch(e: any) { Alert.alert("Save failed", String(e)); } };
  const handleExport = async () => { try { await exportGeoJSON(trail, note, tripType, elapsed); } catch(e: any) { Alert.alert("Export failed", String(e)); } };

  const fmt = (s: number) => Math.floor(s/60).toString().padStart(2,"0") + ":" + (s%60).toString().padStart(2,"0");
  const speedKmh = currentPos?.speed_mps != null ? (Math.max(0, currentPos.speed_mps) * 3.6).toFixed(1) : "--";
  const trailCoords = trail.map(p => ({ latitude: p.latitude, longitude: p.longitude }));
  const tempStr = weather ? `${weather.temp_c}°` : "--";
  const windDir = weather ? degToDir(weather.wind_dir_deg) : "";
  const windStr = weather ? `${weather.wind_kph}${windDir}` : "--";
  const gustStr = weather && weather.gust_kph > weather.wind_kph + 5 ? `G${weather.gust_kph}` : "";
  const baroStr = currentPos?.pressure_hpa ? `${currentPos.pressure_hpa.toFixed(0)}` : null;
  const altStr = currentPos?.pressure_alt_m ? `${currentPos.pressure_alt_m.toFixed(0)}m` : (currentPos?.altitude ? `${currentPos.altitude.toFixed(0)}m` : "--");
  const activeHR = bleState.heartRate ?? hkData.heart_rate;
  const hrSource = bleState.heartRate ? "CHEST" : hkData.heart_rate ? "WRIST" : null;
  const dominantUPI = Math.max(pollen?.tree_upi ?? 0, pollen?.grass_upi ?? 0, pollen?.weed_upi ?? 0);
  const hasInnerData = activeHR !== null || hkData.spo2 !== null || hkData.hrv !== null;
  const sensorDots = [{ label: "A", key: "accelerometer" }, { label: "G", key: "gyroscope" }, { label: "M", key: "magnetometer" }, { label: "D", key: "deviceMotion" }, { label: "B", key: "barometer" }] as const;
  const pollenLine = pollen ? `${pollenEmoji(dominantUPI > 0 ? dominantUPI : null)} ${pollen.dominant ?? "POLLEN"} ${dominantUPI}/5${pollen.fordham_grains ? ` \u00B7 ${pollen.fordham_grains}g` : ""}` : "--";

  const gradeSegments: { coords: { latitude: number; longitude: number }[]; color: string }[] = [];
  for (let i = 1; i < trail.length; i++) {
    const c = gradeColor(calcGrade(trail[i-1], trail[i]));
    if (c !== "transparent") gradeSegments.push({ coords: [{ latitude: trail[i-1].latitude, longitude: trail[i-1].longitude }, { latitude: trail[i].latitude, longitude: trail[i].longitude }], color: c });
  }

  return (
    <View style={st.container}>
      <PollenSurveyModal visible={showSurvey} onClose={() => setShowSurvey(false)} />
      <TripLogModal visible={showTripLog} onClose={() => setShowTripLog(false)} />
      <SessionsModal visible={showSessions} onClose={() => setShowSessions(false)} />
      <MapView ref={mapRef} style={st.map} provider={PROVIDER_DEFAULT} initialRegion={{ latitude: ALCOTT_TRAIL.latitude, longitude: ALCOTT_TRAIL.longitude, latitudeDelta: 0.004, longitudeDelta: 0.004 }} showsUserLocation showsTraffic showsCompass mapType="satellite">
        {gradeSegments.map((seg, i) => (<Polyline key={`g${i}`} coordinates={seg.coords} strokeColor={seg.color} strokeWidth={8} />))}
        {trailCoords.length > 1 && <Polyline coordinates={trailCoords} strokeColor="#00E5FF" strokeWidth={4} />}
        {currentPos && (<Marker coordinate={{ latitude: currentPos.latitude, longitude: currentPos.longitude }} anchor={{ x: 0.5, y: 0.5 }}><View style={st.dot} /></Marker>)}
      </MapView>
      <View style={st.outerBar}>
        <Text style={st.barLabel}>🌍 OUTER</Text>
        <Text style={st.wi}>{tempEmoji(weather?.temp_c ?? null)} {tempStr}</Text>
        <Text style={st.wi}>{windEmoji(weather?.wind_kph ?? null)} {windStr}{gustStr ? ` ${gustStr}` : ""}</Text>
        {baroStr && <Text style={st.wi}>🔵 {baroStr}hPa</Text>}
        <Text style={st.wi}>{pollenLine}</Text>
        <Pressable style={st.iconBtn} onPress={() => setShowSurvey(true)}><Text style={st.iconBtnT}>🌿</Text></Pressable>
        <Pressable style={st.iconBtn} onPress={() => setShowTripLog(true)}><Text style={st.iconBtnT}>📍</Text></Pressable>
        <Pressable style={st.iconBtn} onPress={() => setShowSessions(true)}><Text style={st.iconBtnT}>🗂</Text></Pressable>
        <Pressable style={st.iconBtn} onPress={() => setShowSessions(true)}><Text style={st.iconBtnT}>🗂</Text></Pressable>
        <View style={st.dots}>{sensorDots.map(({ label, key }) => (<View key={key} style={[st.sdot, { backgroundColor: running && (sensorAvail as any)[key] ? "#00E5FF" : "#2a2a2a" }]}><Text style={st.sdotL}>{label}</Text></View>))}</View>
      </View>
      <Pressable style={st.innerToggle} onPress={() => setShowInner(v => !v)}>
        <Text style={st.barLabel}>💙 INNER {!hasInnerData ? "(no device)" : ""} {showInner ? "▲" : "▼"}</Text>
        {!showInner && activeHR && <Text style={st.wi}>{hrEmoji(activeHR)} {activeHR} BPM {hrSource ? `(${hrSource})` : ""}</Text>}
        <View style={[st.bleDot, { backgroundColor: bleState.status === "connected" ? "#00C853" : bleState.status === "scanning" ? "#FFA000" : bleState.status === "connecting" ? "#0288D1" : "#333" }]} />
        <Text style={st.bleLabel}>{bleState.status === "connected" ? bleState.deviceName ?? "HRM" : bleState.status.toUpperCase()}</Text>
        {bleState.status === "disconnected" && <Pressable onPress={bleRescan} style={st.rescanBtn}><Text style={st.rescanT}>⟳</Text></Pressable>}
      </Pressable>
      {showInner && (<View style={st.innerBar}><View style={st.innerRow}><View style={st.innerStat}><Text style={st.isv}>{hrEmoji(activeHR)} {activeHR ?? "--"}</Text><Text style={st.isl}>BPM</Text></View><View style={st.innerStat}><Text style={st.isv}>{spo2Emoji(hkData.spo2)} {hkData.spo2 ? `${hkData.spo2}%` : "--"}</Text><Text style={st.isl}>SpO2</Text></View><View style={st.innerStat}><Text style={st.isv}>💗 {hkData.hrv ? `${Math.round(hkData.hrv)}ms` : "--"}</Text><Text style={st.isl}>HRV</Text></View><View style={st.innerStat}><Text style={st.isv}>🌡️ {hkData.wrist_temp_c ? `${hkData.wrist_temp_c.toFixed(1)}°` : "--"}</Text><Text style={st.isl}>WRIST</Text></View></View></View>)}
      <View style={st.statsBar}>
        <View style={st.stat}><Text style={st.sv}>{fmt(elapsed)}</Text><Text style={st.sl}>TIME</Text></View>
        <View style={st.stat}><Text style={st.sv}>{speedKmh}</Text><Text style={st.sl}>KM/H</Text></View>
        <View style={st.stat}><Text style={st.sv}>{currentPos?.cadence_spm ?? "--"}</Text><Text style={st.sl}>SPM</Text></View>
        <View style={st.stat}><Text style={st.sv}>{altStr}</Text><Text style={st.sl}>ALT</Text></View>
      </View>
      <View style={st.sessionBar}>
        <View style={[st.statusDot, { backgroundColor: running ? "#4CAF50" : "#555" }]} />
        <Text style={st.sessionText} numberOfLines={1}>{sessionName}</Text>
        <Text style={st.tripLabel}>{tripType}</Text>
        <Text style={st.ptCount}>{pointCount} pts</Text>
        {syncStatus.running && <Text style={{color:"#FFA000",fontSize:9,marginLeft:4}}>↑HK</Text>}
        {syncStatus.lastSync && !syncStatus.running && <Text style={{color:"#00C853",fontSize:9,marginLeft:4}}>✓HK</Text>}
      </View>
      {!running && (<View style={st.tripRow}>{TRIP_TYPES.map(t => (<Pressable key={t} style={[st.tripBtn, tripType === t && st.tripBtnA]} onPress={() => setTripType(t)}><Text style={[st.tripBtnT, tripType === t && st.tripBtnTA]}>{t}</Text></Pressable>))}</View>)}
      <TextInput style={st.noteInput} placeholder="Session note" placeholderTextColor="#444" value={note} onChangeText={setNote} multiline />
      <View style={st.controls}>
        {!running ? <Pressable style={[st.btn, st.btnStart]} onPress={handleStart}><Text style={st.btnT}>START</Text></Pressable> : <Pressable style={[st.btn, st.btnStop]} onPress={handleStop}><Text style={st.btnT}>STOP</Text></Pressable>}
        <Pressable style={[st.btn, st.btnSave, trail.length === 0 && st.btnDis]} onPress={handleSave} disabled={trail.length === 0}><Text style={st.btnT}>SAVE</Text></Pressable>
        <Pressable style={[st.btn, st.btnExport, trail.length === 0 && st.btnDis]} onPress={handleExport} disabled={trail.length === 0}><Text style={st.btnT}>SHARE</Text></Pressable>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A0A0A" },
  map: { flex: 1 },
  dot: { width: 16, height: 16, borderRadius: 8, backgroundColor: "#00E5FF", borderWidth: 3, borderColor: "#fff" },
  outerBar: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", backgroundColor: "#080F1A", paddingVertical: 6, paddingHorizontal: 10, borderTopWidth: 1, borderTopColor: "#1A2030" },
  barLabel: { color: "#445566", fontSize: 9, fontWeight: "700", letterSpacing: 1, marginRight: 6 },
  wi: { color: "#A0B8D0", fontSize: 11, fontWeight: "500", marginRight: 8 },
  surveyBtn: { marginLeft: 4, marginRight: 6, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: "#0D2010", borderRadius: 6, borderWidth: 1, borderColor: "#1A4020" },
  surveyBtnT: { fontSize: 14 },
  dots: { flexDirection: "row", gap: 3 },
  sdot: { width: 16, height: 16, borderRadius: 3, alignItems: "center", justifyContent: "center" },
  sdotL: { color: "#fff", fontSize: 8, fontWeight: "700" },
  innerToggle: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", backgroundColor: "#0A0A1A", paddingVertical: 6, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: "#1A1A30" },
  bleDot: { width: 8, height: 8, borderRadius: 4, marginLeft: 6 },
  bleLabel: { color: "#446688", fontSize: 9, marginLeft: 4 },
  rescanBtn: { marginLeft: 8, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: "#1A2030", borderRadius: 6 },
  rescanT: { color: "#00E5FF", fontSize: 14 },
  innerBar: { backgroundColor: "#080818", paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: "#1A1A30" },
  innerRow: { flexDirection: "row", justifyContent: "space-around" },
  innerStat: { alignItems: "center", flex: 1 },
  isv: { color: "#fff", fontSize: 14, fontWeight: "600" },
  isl: { color: "#446688", fontSize: 9, textAlign: "center", marginTop: 2, letterSpacing: 0.5 },
  statsBar: { flexDirection: "row", backgroundColor: "#0A0A0A", paddingVertical: 12, paddingHorizontal: 8, borderTopWidth: 1, borderTopColor: "#1E1E1E" },
  stat: { flex: 1, alignItems: "center" },
  sv: { color: "#FFF", fontSize: 22, fontWeight: "700" },
  sl: { color: "#666", fontSize: 10, marginTop: 2, letterSpacing: 1 },
  sessionBar: { flexDirection: "row", alignItems: "center", backgroundColor: "#111", paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  sessionText: { color: "#888", fontSize: 12, flex: 1, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  tripLabel: { color: "#00E5FF", fontSize: 11, fontWeight: "600", letterSpacing: 1 },
  ptCount: { color: "#444", fontSize: 11 },
  tripRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: "#0A0A0A" },
  tripBtn: { flex: 1, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: "#2a2a2a", alignItems: "center" },
  tripBtnA: { borderColor: "#00E5FF", backgroundColor: "#00E5FF18" },
  tripBtnT: { color: "#555", fontSize: 12, fontWeight: "600", letterSpacing: 0.5 },
  tripBtnTA: { color: "#00E5FF" },
  noteInput: { backgroundColor: "#111", color: "#ccc", fontSize: 12, paddingHorizontal: 16, paddingVertical: 10, minHeight: 40, borderTopWidth: 1, borderTopColor: "#1E1E1E" },
  controls: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingBottom: 36, paddingTop: 12, backgroundColor: "#0A0A0A" },
  btn: { flex: 1, paddingVertical: 16, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  btnStart: { backgroundColor: "#00C853" },
  btnStop: { backgroundColor: "#D50000" },
  btnSave: { backgroundColor: "#1A4A2A", borderWidth: 1, borderColor: "#2A7A3A" },
  btnExport: { backgroundColor: "#0D2A3A", borderWidth: 1, borderColor: "#1A4A6A" },
  btnDis: { opacity: 0.4 },
  btnT: { color: "#fff", fontSize: 15, fontWeight: "700", letterSpacing: 1 },
});

const sv = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#080F08" },
  header: { backgroundColor: "#0A1A0A", paddingTop: 20, paddingBottom: 12, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: "#1A3020" },
  title: { color: "#7CFC00", fontSize: 18, fontWeight: "700", letterSpacing: 0.5 },
  date: { color: "#446644", fontSize: 13, marginTop: 2 },
  pollenInfo: { color: "#5A8860", fontSize: 12, marginTop: 4 },
  closeBtn: { position: "absolute", right: 20, top: 20, padding: 6 },
  closeBtnT: { color: "#445", fontSize: 18 },
  scroll: { flex: 1 },
  section: { color: "#7CFC00", fontSize: 13, fontWeight: "700", letterSpacing: 1, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4 },
  sevRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#0F1F0F" },
  sevLabel: { color: "#7A9A7A", fontSize: 13, flex: 1 },
  sevBtns: { flexDirection: "row", gap: 6 },
  sevBtn: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: "#2A3A2A", alignItems: "center", justifyContent: "center" },
  sevBtnA: { backgroundColor: "#7CFC00", borderColor: "#7CFC00" },
  sevBtnT: { color: "#5A7A5A", fontSize: 13, fontWeight: "600" },
  sevBtnTA: { color: "#000" },
  toggleRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#0F1F0F" },
  toggleLabel: { color: "#7A9A7A", fontSize: 13, flex: 1 },
  ctrRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#0F1F0F" },
  ctrLabel: { color: "#7A9A7A", fontSize: 13, flex: 1 },
  ctrBtns: { flexDirection: "row", alignItems: "center", gap: 12 },
  ctrBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: "#1A2A1A", alignItems: "center", justifyContent: "center" },
  ctrBtnT: { color: "#7CFC00", fontSize: 20, fontWeight: "300" },
  ctrVal: { color: "#fff", fontSize: 18, fontWeight: "700", minWidth: 28, textAlign: "center" },
  notes: { backgroundColor: "#0D1F0D", color: "#ccc", fontSize: 13, marginHorizontal: 20, marginTop: 8, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: "#1A3020", minHeight: 70 },
  saveBtn: { marginHorizontal: 20, marginTop: 20, backgroundColor: "#7CFC00", borderRadius: 12, paddingVertical: 16, alignItems: "center" },
  saveBtnDis: { opacity: 0.5 },
  saveBtnT: { color: "#000", fontSize: 15, fontWeight: "800", letterSpacing: 1 },
});