// Beat detection with no native dependencies, so it can run (and be tested) anywhere.
// One pass over the samples builds a loudness curve for three frequency bands plus a
// waveform summary. Beats are then picked from the curves, which is quick enough to
// redo whenever the sensitivity or band changes.

export const HOP = 512;
const BANDS = ['bass', 'all', 'highs'];

/**
 * @param {Float32Array[]} channels decoded PCM, one array per channel
 * @param {number} sampleRate
 * @param {number} [peakBins] number of bars for the waveform summary
 */
export function analyse(channels, sampleRate, peakBins = 120) {
  const nCh = channels.length;
  const len = channels[0].length;
  const frames = Math.floor(len / HOP);
  const energy = { bass: new Float32Array(frames), all: new Float32Array(frames), highs: new Float32Array(frames) };
  const framePeak = new Float32Array(frames);

  const aBass = 1 - Math.exp((-2 * Math.PI * 150) / sampleRate);
  const aHigh = 1 - Math.exp((-2 * Math.PI * 3000) / sampleRate);
  let lpB = 0;
  let lpH = 0;

  for (let f = 0; f < frames; f++) {
    let sB = 0, sA = 0, sH = 0, pk = 0;
    const end = (f + 1) * HOP;
    for (let i = f * HOP; i < end; i++) {
      let x = channels[0][i];
      for (let c = 1; c < nCh; c++) x += channels[c][i];
      x /= nCh;
      lpB += aBass * (x - lpB);
      lpH += aHigh * (x - lpH);
      const h = x - lpH;
      sB += lpB * lpB;
      sA += x * x;
      sH += h * h;
      const ax = x < 0 ? -x : x;
      if (ax > pk) pk = ax;
    }
    energy.bass[f] = Math.log1p(Math.sqrt(sB / HOP) * 60);
    energy.all[f] = Math.log1p(Math.sqrt(sA / HOP) * 60);
    energy.highs[f] = Math.log1p(Math.sqrt(sH / HOP) * 60);
    framePeak[f] = pk;
  }

  const flux = {};
  for (const b of BANDS) {
    const e = energy[b];
    const out = new Float32Array(frames);
    for (let k = 1; k < frames; k++) out[k] = Math.max(0, e[k] - e[k - 1]);
    flux[b] = out;
  }

  // waveform summary: tallest sample in each bin, scaled so the loudest bin is 1
  const peaks = new Array(peakBins).fill(0);
  let top = 0;
  for (let b = 0; b < peakBins; b++) {
    const from = Math.floor((b / peakBins) * frames);
    const to = Math.max(from + 1, Math.floor(((b + 1) / peakBins) * frames));
    let m = 0;
    for (let k = from; k < to && k < frames; k++) if (framePeak[k] > m) m = framePeak[k];
    peaks[b] = m;
    if (m > top) top = m;
  }
  if (top > 0) for (let b = 0; b < peakBins; b++) peaks[b] /= top;

  return { hopSec: HOP / sampleRate, duration: len / sampleRate, flux, peaks };
}

/** Pick beat times (seconds) from a flux curve. sens runs 0..1, higher finds more beats. */
export function pickBeats(flux, hopSec, sens) {
  const n = flux.length;
  const w = Math.round(0.5 / hopSec);
  const mult = 2.4 - 1.7 * sens;
  let gmax = 0;
  for (let k = 0; k < n; k++) if (flux[k] > gmax) gmax = flux[k];
  const pre = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) pre[k + 1] = pre[k] + flux[k];
  const out = [];
  let last = -1;
  for (let k = 1; k < n - 1; k++) {
    const lo = Math.max(0, k - w);
    const hi = Math.min(n, k + w + 1);
    const mean = (pre[hi] - pre[lo]) / (hi - lo);
    if (flux[k] > mean * mult + gmax * 0.04 && flux[k] >= flux[k - 1] && flux[k] >= flux[k + 1]) {
      const t = k * hopSec;
      if (t - last >= 0.2) {
        out.push(t);
        last = t;
      }
    }
  }
  return out;
}

/** Most common tempo implied by the gaps between beats, folded into 70-160 bpm. */
export function estimateBpm(beats) {
  if (beats.length < 6) return null;
  const hist = {};
  for (let i = 1; i < beats.length; i++) {
    const dt = beats[i] - beats[i - 1];
    if (dt <= 0) continue;
    let bpm = 60 / dt;
    while (bpm < 70) bpm *= 2;
    while (bpm > 160) bpm /= 2;
    const r = Math.round(bpm);
    hist[r] = (hist[r] || 0) + 1;
  }
  let best = 0;
  let bestV = -1;
  for (const key of Object.keys(hist)) {
    const k = parseInt(key, 10);
    const v = hist[k] * 2 + (hist[k - 1] || 0) + (hist[k + 1] || 0);
    if (v > bestV) { bestV = v; best = k; }
  }
  return best || null;
}

/** Index of the last beat at or before time t, or -1. Beats must be sorted. */
export function lastBeatIndex(beats, t) {
  let lo = 0, hi = beats.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** A 24-second 124 bpm sample (kick, snare, hats) so the app can be tried without a song. */
export function makeDemoSamples(sampleRate = 44100, seconds = 24, bpm = 124) {
  const d = new Float32Array(sampleRate * seconds);
  const spb = 60 / bpm;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 2147483648 - 1; };
  for (let b = 0; b * spb < seconds - 0.4; b++) {
    const start = Math.floor(b * spb * sampleRate);
    for (let i = 0; i < sampleRate * 0.28 && start + i < d.length; i++) {
      const t = i / sampleRate;
      const ph = 2 * Math.PI * (50 * t + (100 * (1 - Math.exp(-t * 28))) / 28);
      d[start + i] += Math.sin(ph) * Math.exp(-t * 11) * 0.9;
    }
    if (b % 2 === 1) {
      for (let i = 0; i < sampleRate * 0.16 && start + i < d.length; i++) d[start + i] += rnd() * Math.exp(-(i / sampleRate) * 26) * 0.35;
    }
    const hs = start + Math.floor((spb * sampleRate) / 2);
    for (let i = 0; i < sampleRate * 0.05 && hs + i < d.length; i++) d[hs + i] += rnd() * Math.exp(-(i / sampleRate) * 90) * 0.18;
  }
  return d;
}
