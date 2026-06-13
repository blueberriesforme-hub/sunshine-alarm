import { useEffect, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Notifications from "expo-notifications";
import { Audio } from "expo-av";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";

// Show notifications even when app is foregrounded
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const BRIGHTNESS_THRESHOLD = 180; // 0–255; bright outdoor light is typically 200+
const MIN_HOUR = 5; // alarm only valid at 5 am or later

type AlarmState = "idle" | "ringing";

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [alarmTime, setAlarmTime] = useState<string | null>(null);
  const [alarmState, setAlarmState] = useState<AlarmState>("idle");
  const [selfieOk, setSelfieOk] = useState(false);
  const [spotifyOk, setSpotifyOk] = useState(false);
  const [cameraVisible, setCameraVisible] = useState(false);
  const [hour, setHour] = useState(7);
  const [minute, setMinute] = useState(0);

  const cameraRef = useRef<CameraView>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const ringIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const checkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load saved alarm on mount
  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem("alarmTime");
      if (saved) setAlarmTime(saved);
      await requestNotificationPermission();
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
      });
    })();
  }, []);

  // Check every 30 seconds whether it's alarm time
  useEffect(() => {
    checkIntervalRef.current = setInterval(checkAlarmTrigger, 30_000);
    return () => {
      if (checkIntervalRef.current) clearInterval(checkIntervalRef.current);
    };
  }, [alarmTime, alarmState]);

  // When user returns from Spotify, prompt them to confirm a song is playing
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && alarmState === "ringing" && !spotifyOk) {
        checkSpotifyPlaying();
      }
    });
    return () => sub.remove();
  }, [alarmState, spotifyOk]);

  // Dismiss once both tasks are done
  useEffect(() => {
    if (selfieOk && spotifyOk && alarmState === "ringing") {
      dismissAlarm();
    }
  }, [selfieOk, spotifyOk, alarmState]);

  async function requestNotificationPermission() {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Notifications required",
        "Please enable notifications so the alarm can wake you."
      );
    }
  }

  function checkAlarmTrigger() {
    if (!alarmTime || alarmState === "ringing") return;
    const now = new Date();
    const [h, m] = alarmTime.split(":").map(Number);
    if (
      now.getHours() === h &&
      now.getMinutes() === m &&
      now.getHours() >= MIN_HOUR
    ) {
      startAlarm();
    }
  }

  async function startAlarm() {
    setAlarmState("ringing");
    setSelfieOk(false);
    setSpotifyOk(false);
    await activateKeepAwakeAsync();
    ringOnce();
    ringIntervalRef.current = setInterval(ringOnce, 60_000);
  }

  async function ringOnce() {
    try {
      const { sound } = await Audio.Sound.createAsync(
        require("./assets/alarm.wav"),
        { shouldPlay: true }
      );
      soundRef.current = sound;
      setTimeout(async () => {
        await sound.stopAsync();
        await sound.unloadAsync();
      }, 5_000);
    } catch {
      // If audio asset is missing, fall back to a notification
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "☀️ Sunshine Alarm",
          body: "Complete your tasks to dismiss: sun selfie + Spotify song",
          sound: true,
        },
        trigger: null,
      });
    }
  }

  function dismissAlarm() {
    if (ringIntervalRef.current) clearInterval(ringIntervalRef.current);
    soundRef.current?.stopAsync();
    deactivateKeepAwake();
    setAlarmState("idle");
    setCameraVisible(false);
    Alert.alert("🌞 Good morning!", "All done. Have a great day!");
  }

  async function takeSunSelfie() {
    if (!permission?.granted) {
      await requestPermission();
      return;
    }
    setCameraVisible(true);
  }

  async function captureAndCheck() {
    if (!cameraRef.current) return;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.1,
      });
      const brightness = measureBrightness(photo.base64 ?? "");
      const hourNow = new Date().getHours();
      if (brightness >= BRIGHTNESS_THRESHOLD && hourNow >= MIN_HOUR) {
        setSelfieOk(true);
        setCameraVisible(false);
      } else {
        Alert.alert(
          "Too dark!",
          `Step onto your balcony in the sun and try again.\n(Light level: ${brightness}/255, need ${BRIGHTNESS_THRESHOLD}+)`
        );
      }
    } catch {
      Alert.alert("Camera error", "Could not take photo. Please try again.");
    }
  }

  // Average the byte values of a small JPEG sample as a rough brightness proxy
  function measureBrightness(base64: string): number {
    if (!base64) return 0;
    const bytes = atob(base64.slice(0, 3000));
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) {
      sum += bytes.charCodeAt(i);
    }
    return Math.round(sum / bytes.length);
  }

  async function openSpotify() {
    const canOpen = await Linking.canOpenURL("spotify://");
    await Linking.openURL(
      canOpen
        ? "spotify://"
        : "https://apps.apple.com/app/spotify-music-and-podcasts/id324684580"
    );
  }

  function checkSpotifyPlaying() {
    Alert.alert(
      "Is Spotify playing?",
      "Confirm you started a song on Spotify.",
      [
        { text: "Not yet", style: "cancel" },
        { text: "Yes, song is playing ✓", onPress: () => setSpotifyOk(true) },
      ]
    );
  }

  async function saveAlarm() {
    if (hour < MIN_HOUR) {
      Alert.alert("Too early", "Alarm must be set to 5:00 AM or later.");
      return;
    }
    const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    setAlarmTime(timeStr);
    await AsyncStorage.setItem("alarmTime", timeStr);
    Alert.alert("Alarm set ✓", `Your alarm is set for ${timeStr}.`);
  }

  // ── Camera screen ──────────────────────────────────────────────────────────
  if (cameraVisible) {
    return (
      <View style={styles.container}>
        <CameraView ref={cameraRef} style={styles.camera} facing="front">
          <View style={styles.cameraOverlay}>
            <Text style={styles.cameraHint}>
              Step onto your balcony and face the sun ☀️
            </Text>
            <TouchableOpacity style={styles.snapButton} onPress={captureAndCheck}>
              <Text style={styles.snapText}>Take Selfie</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setCameraVisible(false)}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </CameraView>
      </View>
    );
  }

  // ── Main screen ────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <Text style={styles.title}>☀️ Sunshine Alarm</Text>

      {/* Time picker */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Set Alarm Time</Text>
        <View style={styles.timePicker}>
          <View style={styles.timeColumn}>
            <TouchableOpacity onPress={() => setHour((h) => Math.min(23, h + 1))}>
              <Text style={styles.arrow}>▲</Text>
            </TouchableOpacity>
            <Text style={styles.timeValue}>{String(hour).padStart(2, "0")}</Text>
            <TouchableOpacity onPress={() => setHour((h) => Math.max(MIN_HOUR, h - 1))}>
              <Text style={styles.arrow}>▼</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.colon}>:</Text>
          <View style={styles.timeColumn}>
            <TouchableOpacity onPress={() => setMinute((m) => (m + 5) % 60)}>
              <Text style={styles.arrow}>▲</Text>
            </TouchableOpacity>
            <Text style={styles.timeValue}>{String(minute).padStart(2, "0")}</Text>
            <TouchableOpacity onPress={() => setMinute((m) => (m - 5 + 60) % 60)}>
              <Text style={styles.arrow}>▼</Text>
            </TouchableOpacity>
          </View>
        </View>
        <TouchableOpacity style={styles.setButton} onPress={saveAlarm}>
          <Text style={styles.setButtonText}>
            {alarmTime ? `Update Alarm (${alarmTime})` : "Set Alarm"}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Alarm active — show tasks */}
      {alarmState === "ringing" && (
        <View style={styles.alarmCard}>
          <Text style={styles.alarmTitle}>🔔 Alarm Ringing!</Text>
          <Text style={styles.alarmSub}>
            Complete both tasks to dismiss. Rings every minute until done.
          </Text>

          <TouchableOpacity
            style={[styles.taskButton, selfieOk && styles.taskDone]}
            onPress={takeSunSelfie}
            disabled={selfieOk}
          >
            <Text style={styles.taskText}>
              {selfieOk ? "✅ Sun selfie done!" : "📸 Take sun selfie"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.taskButton, spotifyOk && styles.taskDone]}
            onPress={spotifyOk ? undefined : openSpotify}
            disabled={spotifyOk}
          >
            <Text style={styles.taskText}>
              {spotifyOk ? "✅ Spotify playing!" : "🎵 Open Spotify & play a song"}
            </Text>
          </TouchableOpacity>

          {!spotifyOk && (
            <TouchableOpacity
              style={styles.confirmSpotify}
              onPress={checkSpotifyPlaying}
            >
              <Text style={styles.confirmText}>I started a song ✓</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {alarmState === "idle" && alarmTime && (
        <Text style={styles.nextAlarm}>Next alarm: {alarmTime}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFF9F0", alignItems: "center", justifyContent: "center", padding: 24 },
  title: { fontSize: 28, fontWeight: "700", color: "#E67E00", marginBottom: 32 },
  card: { width: "100%", backgroundColor: "#fff", borderRadius: 16, padding: 20, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 8, elevation: 3, marginBottom: 24 },
  cardTitle: { fontSize: 16, fontWeight: "600", color: "#555", marginBottom: 16, textAlign: "center" },
  timePicker: { flexDirection: "row", justifyContent: "center", alignItems: "center", marginBottom: 16 },
  timeColumn: { alignItems: "center", width: 60 },
  arrow: { fontSize: 24, color: "#E67E00", paddingVertical: 4 },
  timeValue: { fontSize: 42, fontWeight: "700", color: "#222" },
  colon: { fontSize: 42, fontWeight: "700", color: "#222", marginHorizontal: 8, marginBottom: 8 },
  setButton: { backgroundColor: "#E67E00", borderRadius: 12, padding: 14, alignItems: "center" },
  setButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  alarmCard: { width: "100%", backgroundColor: "#FFF3CD", borderRadius: 16, padding: 20, borderWidth: 2, borderColor: "#E67E00" },
  alarmTitle: { fontSize: 22, fontWeight: "700", textAlign: "center", marginBottom: 8 },
  alarmSub: { fontSize: 13, color: "#666", textAlign: "center", marginBottom: 20 },
  taskButton: { backgroundColor: "#E67E00", borderRadius: 12, padding: 16, alignItems: "center", marginBottom: 12 },
  taskDone: { backgroundColor: "#4CAF50" },
  taskText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  confirmSpotify: { backgroundColor: "#1DB954", borderRadius: 12, padding: 12, alignItems: "center", marginTop: 4 },
  confirmText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  nextAlarm: { color: "#888", fontSize: 15, marginTop: 8 },
  camera: { flex: 1 },
  cameraOverlay: { flex: 1, justifyContent: "flex-end", padding: 32, gap: 12 },
  cameraHint: { color: "#fff", fontSize: 16, textAlign: "center", marginBottom: 8, textShadowColor: "#000", textShadowRadius: 4 },
  snapButton: { backgroundColor: "#E67E00", borderRadius: 14, padding: 18, alignItems: "center" },
  snapText: { color: "#fff", fontWeight: "700", fontSize: 17 },
  cancelButton: { backgroundColor: "rgba(0,0,0,0.5)", borderRadius: 14, padding: 14, alignItems: "center" },
  cancelText: { color: "#fff", fontSize: 15 },
});
