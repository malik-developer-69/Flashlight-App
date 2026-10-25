import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, AppState, Platform, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import Slider from '@react-native-community/slider';

import { C } from './src/theme';
import { buildSos, sosAt, strobeAt } from './src/patterns';
import { analyse, pickBeats, estimateBpm, lastBeatIndex } from './src/beat';
import { Player } from './src/player';

/* ------------------------------------------------------------------ *
 * The phone's flashlight is the camera's LED. It only lights while a
 * camera view is mounted with enableTorch set, so a 1px hidden view
 * stays mounted and the engine flips its prop through this setter.
 * ------------------------------------------------------------------ */
let driveTorch = () => {};

function TorchDriver({ allowed }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    driveTorch = setOn;
    return () => { driveTorch = () => {}; setOn(false); };
  }, []);
  if (!allowed) return null;
  return <CameraView style={styles.hiddenCamera} facing="back" enableTorch={on} pointerEvents="none" />;
}

const MODES = [
  { id: 'torch', label: 'Torch' },
  { id: 'strobe', label: 'Strobe' },
  { id: 'sos', label: 'SOS' },
  { id: 'beat', label: 'Beat sync' },
];

const fmtTime = (t) => {
  const s = Math.max(0, Math.round(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  const [perm, requestPerm] = useCameraPermissions();
  const [mode, setMode] = useState('torch');
  const [running, setRunning] = useState(false);
  const [led, setLed] = useState(false);
  const [mark, setMark] = useState(-1);

  const [hz, setHz] = useState(4);
  const [unit, setUnit] = useState(160);

  const [band, setBand] = useState('bass');
  const [sens, setSens] = useState(0.6);
  const [flen, setFlen] = useState(140);
  const [nudge, setNudge] = useState(0);
  const [vol, setVol] = useState(0.8);
  const [track, setTrack] = useState(null); // { name, duration, peaks }
  const [beats, setBeats] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);

  const player = useRef(null);
  if (!player.current) player.current = new Player();
  const analysis = useRef(null);
  const litAnim = useRef(new Animated.Value(0)).current;

  const sosPattern = useMemo(() => buildSos(unit), [unit]);

  // everything the 60 fps loop needs, readable without re-subscribing
  const live = useRef({});
  const t0 = useRef(0);
  live.current = { mode, running, hz, sosPattern, beats, flen, nudge };

  /* ---- light engine ---- */
  useEffect(() => {
    let raf;
    let lastWant = false;
    let lastMark = -1;
    const tick = () => {
      const s = live.current;
      const now = Date.now();
      let want = false;
      let m = -1;
      if (s.mode === 'torch') want = s.running;
      else if (s.mode === 'strobe') want = s.running && strobeAt(s.hz, now - t0.current);
      else if (s.mode === 'sos') {
        if (s.running) { const r = sosAt(s.sosPattern, now - t0.current); want = r.on; m = r.mark; }
      } else if (s.mode === 'beat') {
        const p = player.current;
        if (p.playing && s.beats.length) {
          const t = p.position() + s.nudge / 1000;
          const idx = lastBeatIndex(s.beats, t);
          if (idx >= 0) want = (t - s.beats[idx]) * 1000 < s.flen;
        }
      }
      if (want !== lastWant) {
        lastWant = want;
        driveTorch(want);
        setLed(want);
        Animated.timing(litAnim, { toValue: want ? 1 : 0, duration: want ? 25 : 150, useNativeDriver: true }).start();
      }
      if (m !== lastMark) { lastMark = m; setMark(m); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); driveTorch(false); };
  }, [litAnim]);

  /* ---- keep the screen awake and switch everything off when the app is left ---- */
  const active = mode === 'beat' ? playing : running;
  useEffect(() => {
    if (active) activateKeepAwakeAsync('pulse-torch').catch(() => {});
    else deactivateKeepAwake('pulse-torch').catch(() => {});
  }, [active]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') { setRunning(false); player.current.pause(); setPlaying(false); }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    player.current.onEnd = () => setPlaying(false);
    return () => { player.current.stop(); };
  }, []);

  useEffect(() => {
    if (!playing) return undefined;
    const id = setInterval(() => setPos(player.current.position()), 80);
    return () => clearInterval(id);
  }, [playing]);

  /* ---- beats follow the band and sensitivity settings ---- */
  useEffect(() => {
    if (!analysis.current) return undefined;
    const id = setTimeout(() => {
      const a = analysis.current;
      if (a) setBeats(pickBeats(a.flux[band], a.hopSec, sens));
    }, 60);
    return () => clearTimeout(id);
  }, [band, sens, track]);

  const bpm = useMemo(() => estimateBpm(beats), [beats]);

  /* ---- actions ---- */
  const ensureCamera = useCallback(async () => {
    if (perm && perm.granted) return true;
    const r = await requestPerm();
    return !!(r && r.granted);
  }, [perm, requestPerm]);

  const selectMode = (m) => {
    if (m === mode) return;
    setRunning(false);
    player.current.pause();
    setPlaying(false);
    setMode(m);
  };

  const onPower = async () => {
    await ensureCamera();
    if (mode === 'beat') {
      if (!track) { setError('Choose a song or try the demo beat first.'); return; }
      if (player.current.playing) { player.current.pause(); setPlaying(false); }
      else { await player.current.play(); setPlaying(true); }
      return;
    }
    t0.current = Date.now();
    setRunning((r) => !r);
  };

  const loadTrack = async (name, loader) => {
    setError('');
    setBusy(true);
    setPlaying(false);
    try {
      await new Promise((r) => setTimeout(r, 30));
      const decoded = await loader();
      await new Promise((r) => setTimeout(r, 30)); // let the "Finding beats" state paint
      const a = analyse(decoded.channels, decoded.sampleRate);
      analysis.current = a;
      setPos(0);
      setTrack({ name, duration: decoded.duration, peaks: a.peaks, id: Date.now() });
    } catch (e) {
      analysis.current = null;
      setTrack(null);
      setBeats([]);
      setError('That file could not be read as audio. Try an MP3, WAV, M4A or OGG file.');
    } finally {
      setBusy(false);
    }
  };

  const pickSong = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true, multiple: false });
    if (res.canceled || !res.assets || !res.assets.length) return;
    const asset = res.assets[0];
    await loadTrack(asset.name.replace(/\.[^.]+$/, ''), () => player.current.loadUri(asset.uri));
  };

  const useDemo = () => loadTrack('Demo beat (124 bpm)', async () => player.current.loadDemo());

  const seekFraction = (f) => {
    if (!track) return;
    const t = Math.max(0, Math.min(1, f)) * track.duration;
    setPos(t);
    player.current.seek(t);
  };

  /* ---- display ---- */
  const status = mode === 'beat'
    ? (playing ? 'Playing, flashing on the beat' : (track ? 'Paused' : 'Choose a song to start'))
    : (running ? `${MODES.find((x) => x.id === mode).label} is on` : `${MODES.find((x) => x.id === mode).label} is off`);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar style="light" />
      <TorchDriver allowed={!!(perm && perm.granted)} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.brand}>Pulse<Text style={{ color: C.accent }}>Torch</Text></Text>
          <Text style={styles.tag}>LED flashlight</Text>
        </View>

        {/* lens */}
        <View style={styles.lensWrap}>
          <Animated.View style={[styles.halo, { width: 300, height: 300, borderRadius: 150, opacity: litAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.14] }) }]} />
          <Animated.View style={[styles.halo, { width: 244, height: 244, borderRadius: 122, opacity: litAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.26] }) }]} />
          <Pressable
            onPress={onPower}
            accessibilityRole="button"
            accessibilityLabel={mode === 'beat' ? (playing ? 'Pause song' : 'Play song') : (running ? 'Turn light off' : 'Turn light on')}
            style={({ pressed }) => [styles.lens, active && { borderColor: C.accent }, pressed && { transform: [{ scale: 0.97 }] }]}
          >
            <Animated.View style={[styles.core, { opacity: litAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) }]} />
            {mode === 'beat'
              ? <Text style={[styles.glyph, { color: led ? C.accentInk : (active ? C.accent : C.muted) }]}>{playing ? '❚❚' : '▶'}</Text>
              : <View style={[styles.powerBar, { backgroundColor: led ? C.accentInk : (active ? C.accent : C.muted) }]} />}
          </Pressable>
        </View>
        <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>

        {!(perm && perm.granted) && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              {perm && !perm.canAskAgain
                ? 'Camera access is off. The flashlight is part of the camera, so turn it on for Pulse Torch in your phone settings.'
                : 'The flashlight is part of the camera, so Pulse Torch needs camera access. It never takes photos.'}
            </Text>
            {(!perm || perm.canAskAgain) && (
              <Pressable style={styles.btnPrimary} onPress={requestPerm}><Text style={styles.btnPrimaryText}>Allow flashlight</Text></Pressable>
            )}
          </View>
        )}

        {/* mode tabs */}
        <View style={styles.tabs} accessibilityRole="tablist">
          {MODES.map((m) => (
            <Pressable key={m.id} onPress={() => selectMode(m.id)} accessibilityRole="tab" accessibilityState={{ selected: mode === m.id }}
              style={[styles.tab, mode === m.id && styles.tabOn]}>
              <Text style={[styles.tabText, mode === m.id && { color: C.accentInk }]} numberOfLines={1}>{m.label}</Text>
            </Pressable>
          ))}
        </View>

        {mode === 'torch' && (
          <Panel title="Torch">
            <Text style={styles.sub}>Steady light from the LED. Tap the lens to turn it on or off.</Text>
          </Panel>
        )}

        {mode === 'strobe' && (
          <Panel title="Strobe">
            <SliderRow label="Flash rate" value={`${hz} per second`} min={1} max={12} step={0.5} v={hz} onChange={setHz} />
            <Text style={styles.warn}>Flashing light can trigger seizures in people with photosensitive epilepsy.</Text>
          </Panel>
        )}

        {mode === 'sos' && (
          <Panel title="SOS signal">
            <Morse live={mark} />
            <Text style={styles.sub}>Three short, three long, three short, then a pause.</Text>
            <SliderRow label="Signal speed" value={unit < 110 ? 'Fast' : unit > 220 ? 'Slow' : 'Normal'} min={80} max={320} step={10} v={unit} onChange={(x) => { setUnit(x); t0.current = Date.now(); }} />
          </Panel>
        )}

        {mode === 'beat' && (
          <Panel title="Flash to your song">
            <Text style={styles.sub}>Pick a song from your phone. The LED flashes on each beat it finds.</Text>
            <Pressable onPress={pickSong} style={styles.drop} accessibilityRole="button" accessibilityLabel="Choose a song">
              <Text style={styles.dropTitle} numberOfLines={2}>{busy ? 'Finding beats…' : (track ? track.name : 'Choose a song')}</Text>
              <Text style={styles.dropMeta}>{track && !busy ? `${fmtTime(track.duration)} long. Tap to choose another.` : 'MP3, WAV, M4A or OGG'}</Text>
            </Pressable>
            <View style={styles.btnRow}>
              <Pressable style={styles.btn} onPress={useDemo}><Text style={styles.btnText}>Try a demo beat</Text></Pressable>
              <Pressable style={[styles.btnPrimary, !track && { opacity: 0.5 }]} onPress={onPower}><Text style={styles.btnPrimaryText}>{playing ? 'Pause' : 'Play'}</Text></Pressable>
            </View>
            {!!error && <Text style={styles.err}>{error}</Text>}

            <Waveform track={track} beats={beats} pos={pos} onSeek={seekFraction} />
            <View style={styles.times}><Text style={styles.timeText}>{fmtTime(pos)}</Text><Text style={styles.timeText}>{track ? fmtTime(track.duration) : '0:00'}</Text></View>

            <View style={styles.stats}>
              <Stat value={String(beats.length)} label="beats found" />
              <Stat value={bpm ? String(bpm) : '--'} label="tempo (bpm)" />
              <Stat value={led && playing ? 'ON' : '·'} label="LED" hot={led && playing} />
            </View>

            <Text style={styles.label}>Listen for</Text>
            <Seg value={band} onChange={setBand} options={[['bass', 'Bass'], ['all', 'Everything'], ['highs', 'Highs']]} />
            <SliderRow label="Sensitivity" value={`${Math.round(sens * 100)}%`} min={0} max={1} step={0.01} v={sens} onChange={setSens} />
            <SliderRow label="Flash length" value={`${flen} ms`} min={60} max={400} step={10} v={flen} onChange={setFlen} />
            <SliderRow label="Timing nudge" value={`${nudge > 0 ? '+' : ''}${nudge} ms`} min={-200} max={200} step={5} v={nudge} onChange={setNudge} />
            <Text style={styles.sub}>Bluetooth speakers play a little late. Raise the nudge until the flash lands on the beat.</Text>
            <SliderRow label="Volume" value={`${Math.round(vol * 100)}%`} min={0} max={1} step={0.01} v={vol} onChange={(x) => { setVol(x); player.current.setVolume(x); }} />
            <Text style={styles.warn}>Flashing light can trigger seizures in people with photosensitive epilepsy.</Text>
          </Panel>
        )}

        <Text style={styles.foot}>The LED is either on or off, so brightness is fixed by your phone. The glow around the lens mirrors the LED.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

/* ------------------------------ pieces ------------------------------ */

function Panel({ title, children }) {
  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>{title}</Text>
      {children}
    </View>
  );
}

function SliderRow({ label, value, min, max, step, v, onChange }) {
  return (
    <View style={styles.sliderRow}>
      <View style={styles.sliderHead}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.value}>{value}</Text>
      </View>
      <Slider
        style={{ height: 36 }} minimumValue={min} maximumValue={max} step={step} value={v} onValueChange={onChange}
        minimumTrackTintColor={C.accent} maximumTrackTintColor={C.line} thumbTintColor={C.accent}
        accessibilityLabel={label}
      />
    </View>
  );
}

function Seg({ value, onChange, options }) {
  return (
    <View style={styles.seg}>
      {options.map(([id, label]) => (
        <Pressable key={id} onPress={() => onChange(id)} accessibilityRole="button" accessibilityState={{ selected: value === id }}
          style={[styles.segBtn, value === id && styles.segOn]}>
          <Text style={[styles.segText, value === id && { color: C.fg }]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Morse({ live }) {
  // S, O, S: three dots, three dashes, three dots
  const kinds = ['dot', 'dot', 'dot', 'dash', 'dash', 'dash', 'dot', 'dot', 'dot'];
  return (
    <View style={styles.morse} accessibilityLabel="Morse pattern: three short, three long, three short">
      {kinds.map((k, i) => (
        <View key={i} style={{ flexDirection: 'row' }}>
          {(i === 3 || i === 6) && <View style={{ width: 10 }} />}
          <View style={[styles.mark, { width: k === 'dash' ? 38 : 14 }, live === i && styles.markLive]} />
        </View>
      ))}
    </View>
  );
}

function Stat({ value, label, hot }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, hot && { color: C.accent }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const WAVE_H = 96;
function Waveform({ track, beats, pos, onSeek }) {
  const [w, setW] = useState(0);
  const bars = useMemo(() => {
    if (!track) return null;
    return track.peaks.map((p, i) => (
      <View key={i} style={[styles.bar, { height: Math.max(3, p * (WAVE_H - 20)) }]} />
    ));
  }, [track]);
  const ticks = useMemo(() => {
    if (!track) return null;
    const step = Math.max(1, Math.ceil(beats.length / 300));
    const out = [];
    for (let i = 0; i < beats.length; i += step) {
      out.push(<View key={i} style={[styles.tick, { left: `${(beats[i] / track.duration) * 100}%` }]} />);
    }
    return out;
  }, [track, beats]);

  const touch = (e) => { if (w > 0) onSeek(e.nativeEvent.locationX / w); };
  return (
    <View
      style={styles.wave}
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => !!track}
      onMoveShouldSetResponder={() => !!track}
      onResponderGrant={touch}
      onResponderMove={touch}
      accessibilityRole="adjustable"
      accessibilityLabel="Song position"
    >
      {track ? (
        <>
          <View style={styles.bars} pointerEvents="none">{bars}</View>
          <View style={StyleSheet.absoluteFill} pointerEvents="none">{ticks}</View>
          <View pointerEvents="none" style={[styles.playhead, { left: `${(pos / track.duration) * 100}%` }]} />
        </>
      ) : (
        <Text style={styles.waveEmpty}>Waveform and detected beats appear here</Text>
      )}
    </View>
  );
}

/* ------------------------------- styles ------------------------------ */

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 16, paddingBottom: 40, gap: 14 },
  hiddenCamera: { position: 'absolute', width: 1, height: 1, top: 0, left: 0, opacity: 0.01 },

  header: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  brand: { color: C.fg, fontSize: 28, fontWeight: '800', letterSpacing: -0.6 },
  tag: { color: C.muted, fontSize: 13 },

  lensWrap: { height: 310, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', backgroundColor: C.accent },
  lens: {
    width: 190, height: 190, borderRadius: 95, backgroundColor: C.surface,
    borderWidth: 4, borderColor: C.line, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  core: { ...StyleSheet.absoluteFillObject, backgroundColor: C.accent },
  powerBar: { width: 8, height: 56, borderRadius: 4 },
  glyph: { fontSize: 46 },
  status: { color: C.fg, fontSize: 16, fontWeight: '600', textAlign: 'center', marginTop: -4 },

  banner: { backgroundColor: C.surface2, borderRadius: 16, padding: 14, gap: 10, borderWidth: 1, borderColor: C.line },
  bannerText: { color: C.fg, fontSize: 14, lineHeight: 20 },

  tabs: { flexDirection: 'row', backgroundColor: C.surface, borderRadius: 18, padding: 4, gap: 4, borderWidth: 1, borderColor: C.line },
  tab: { flex: 1, paddingVertical: 12, borderRadius: 14, alignItems: 'center' },
  tabOn: { backgroundColor: C.accent },
  tabText: { color: C.muted, fontSize: 13.5, fontWeight: '700' },

  panel: { backgroundColor: C.surface, borderRadius: 22, padding: 16, gap: 14, borderWidth: 1, borderColor: C.line },
  panelTitle: { color: C.fg, fontSize: 18, fontWeight: '700', letterSpacing: -0.2 },
  sub: { color: C.muted, fontSize: 13.5, lineHeight: 19 },
  warn: { color: C.muted, fontSize: 12.5, lineHeight: 18 },
  err: { color: C.danger, fontSize: 13.5 },
  label: { color: C.fg, fontSize: 14, fontWeight: '600' },
  value: { color: C.muted, fontSize: 14, fontVariant: ['tabular-nums'] },

  sliderRow: { gap: 2 },
  sliderHead: { flexDirection: 'row', justifyContent: 'space-between' },

  seg: { flexDirection: 'row', backgroundColor: C.surface2, borderRadius: 12, padding: 3, gap: 3 },
  segBtn: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
  segOn: { backgroundColor: C.line },
  segText: { color: C.muted, fontSize: 13.5, fontWeight: '600' },

  morse: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: C.surface2, borderRadius: 16, paddingVertical: 20, paddingHorizontal: 8 },
  mark: { height: 14, borderRadius: 7, backgroundColor: C.line },
  markLive: { backgroundColor: C.accent },

  drop: { backgroundColor: C.surface2, borderRadius: 16, padding: 14, borderWidth: 1.5, borderStyle: 'dashed', borderColor: C.line, gap: 2 },
  dropTitle: { color: C.fg, fontSize: 16, fontWeight: '700' },
  dropMeta: { color: C.muted, fontSize: 13 },
  btnRow: { flexDirection: 'row', gap: 8 },
  btn: { flex: 1, backgroundColor: C.surface2, borderRadius: 14, paddingVertical: 13, alignItems: 'center', borderWidth: 1, borderColor: C.line },
  btnText: { color: C.fg, fontWeight: '700' },
  btnPrimary: { flex: 1, backgroundColor: C.accent, borderRadius: 14, paddingVertical: 13, alignItems: 'center' },
  btnPrimaryText: { color: C.accentInk, fontWeight: '800' },

  wave: { height: WAVE_H, borderRadius: 14, backgroundColor: C.surface2, overflow: 'hidden', justifyContent: 'center' },
  bars: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, height: '100%' },
  bar: { flex: 1, marginHorizontal: 0.5, borderRadius: 2, backgroundColor: '#46526A' },
  tick: { position: 'absolute', top: 0, width: 1.5, height: 8, backgroundColor: C.accent },
  playhead: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: C.fg },
  waveEmpty: { color: C.muted, textAlign: 'center', fontSize: 13 },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -6 },
  timeText: { color: C.muted, fontSize: 13, fontFamily: mono },

  stats: { flexDirection: 'row', gap: 8 },
  stat: { flex: 1, backgroundColor: C.surface2, borderRadius: 14, padding: 12 },
  statValue: { color: C.fg, fontSize: 22, fontWeight: '800' },
  statLabel: { color: C.muted, fontSize: 12.5 },

  foot: { color: C.muted, fontSize: 12.5, lineHeight: 18, paddingHorizontal: 4 },
});
