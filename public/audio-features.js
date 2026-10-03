// Pure audio analysis used in the browser (and tested in Node).
// Works on raw PCM samples, so nothing is uploaded except the numbers.

const db = (x) => (x > 1e-9 ? Math.round(20 * Math.log10(x) * 10) / 10 : -180);

export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  return out;
}

// -1 = out of phase, 0 = very wide/unrelated, 1 = mono.
export function stereoCorrelation(left, right) {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  const step = Math.max(1, Math.floor(left.length / 2_000_000));
  for (let i = 0; i < left.length; i += step) {
    lr += left[i] * right[i];
    ll += left[i] * left[i];
    rr += right[i] * right[i];
  }
  return ll && rr ? Math.round((lr / Math.sqrt(ll * rr)) * 100) / 100 : null;
}

export function estimateBpm(mono, sampleRate, maxSeconds = 120) {
  const hop = Math.max(1, Math.round(sampleRate / 200)); // 5 ms frames
  const fps = sampleRate / hop;
  const frames = Math.min(Math.floor(mono.length / hop), Math.floor(maxSeconds * fps));
  if (frames < fps * 6) return { bpm: null, confidence: 0 };
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) sum += mono[i] * mono[i];
    energy[f] = Math.log1p(1000 * sum);
  }
  const onset = new Float32Array(frames);
  let mean = 0;
  for (let f = 1; f < frames; f++) {
    onset[f] = Math.max(0, energy[f] - energy[f - 1]);
    mean += onset[f];
  }
  mean /= frames;
  for (let f = 0; f < frames; f++) onset[f] -= mean;

  const minLag = Math.floor((fps * 60) / 200);
  const maxLag = Math.ceil((fps * 60) / 60);
  const ac = new Float64Array(maxLag + 2);
  let zero = 0;
  for (let f = 0; f < frames; f++) zero += onset[f] * onset[f];
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += onset[f] * onset[f - lag];
    ac[lag] = s;
  }
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (ac[lag] > ac[best]) best = lag;
  if (!(ac[best] > 0) || !(zero > 0)) return { bpm: null, confidence: 0 };
  // Parabolic interpolation for sub-frame accuracy.
  const a = ac[best - 1];
  const b = ac[best];
  const c = ac[best + 1];
  const denom = a - 2 * b + c;
  const offset = denom ? (0.5 * (a - c)) / denom : 0;
  const lag = best + (Number.isFinite(offset) ? Math.max(-0.5, Math.min(0.5, offset)) : 0);
  let bpm = (60 * fps) / lag;
  if (!Number.isFinite(bpm) || bpm <= 0) return { bpm: null, confidence: 0 };
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return { bpm: Math.round(bpm * 10) / 10, confidence: Math.round(Math.min(1, b / zero) * 100) / 100 };
}

function bestWindow(curve, step, seconds) {
  const w = Math.max(1, Math.round(seconds / step));
  if (curve.length < w) return null;
  let sum = 0;
  for (let i = 0; i < w; i++) sum += curve[i];
  let best = sum;
  let at = 0;
  for (let i = w; i < curve.length; i++) {
    sum += curve[i] - curve[i - w];
    if (sum > best + 1e-9) {
      best = sum;
      at = i - w + 1;
    }
  }
  return { start: Math.round(at * step), end: Math.round((at + w) * step), avgEnergy: Math.round(best / w) };
}

export function analyzeSamples(mono, sampleRate) {
  const duration = mono.length / sampleRate;
  let peak = 0;
  let sumSq = 0;
  let crossings = 0;
  for (let i = 0; i < mono.length; i++) {
    const x = mono[i];
    const ax = x < 0 ? -x : x;
    if (ax > peak) peak = ax;
    sumSq += x * x;
    if (i && (x >= 0) !== (mono[i - 1] >= 0)) crossings++;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, mono.length));

  // Energy curve: RMS per window, at most 300 points, normalized 0-100.
  const step = Math.max(1, Math.ceil(duration / 300));
  const win = Math.floor(step * sampleRate);
  const raw = [];
  for (let start = 0; start + win / 2 <= mono.length; start += win) {
    let s = 0;
    const end = Math.min(mono.length, start + win);
    for (let i = start; i < end; i++) s += mono[i] * mono[i];
    raw.push(Math.sqrt(s / (end - start)));
  }
  const maxRaw = Math.max(...raw, 1e-9);
  const curve = raw.map((r) => Math.round((r / maxRaw) * 100));

  const threshold = 5;
  const firstSound = curve.findIndex((v) => v > threshold);
  const lastSound = curve.length - 1 - [...curve].reverse().findIndex((v) => v > threshold);
  // Intro = time until energy first stays at >= 70% of the loudest part for 2 windows.
  let intro = null;
  for (let i = 0; i + 1 < curve.length; i++) {
    if (curve[i] >= 70 && curve[i + 1] >= 70) {
      intro = i * step;
      break;
    }
  }
  // Biggest rise between consecutive 2-window averages = the drop / chorus entry.
  let dropAt = null;
  let bestJump = 0;
  for (let i = 2; i + 1 < curve.length; i++) {
    const jump = (curve[i] + curve[i + 1]) / 2 - (curve[i - 2] + curve[i - 1]) / 2;
    if (jump > bestJump) {
      bestJump = jump;
      dropAt = i * step;
    }
  }

  const zcr = crossings / Math.max(duration, 1e-9);
  const { bpm, confidence } = estimateBpm(mono, sampleRate);
  return {
    durationSec: Math.round(duration * 10) / 10,
    bpm,
    bpmConfidence: confidence,
    peakDb: db(peak),
    rmsDb: db(rms),
    crestDb: Math.round((db(peak) - db(rms)) * 10) / 10,
    brightness: zcr > 3500 ? 'bright' : zcr > 1500 ? 'balanced' : 'dark/warm',
    silenceStartSec: firstSound > 0 ? firstSound * step : 0,
    silenceEndSec: firstSound === -1 ? 0 : Math.max(0, Math.round(duration - (lastSound + 1) * step)),
    introSec: intro,
    dropAtSec: bestJump >= 15 ? dropAt : null,
    dropStrength: Math.round(bestJump),
    bestSnippet15: bestWindow(curve, step, 15),
    bestSnippet30: bestWindow(curve, step, 30),
    curveStepSec: step,
    energyCurve: curve,
  };
}

export function encodeWav16(mono, sampleRate) {
  const buffer = new ArrayBuffer(44 + mono.length * 2);
  const v = new DataView(buffer);
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + mono.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}
