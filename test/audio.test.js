import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSamples, estimateBpm, encodeWav16, mixToMono, stereoCorrelation } from '../public/audio-features.js';

const SR = 22050;

function clickTrack(bpm, seconds, { quietUntil = 0, loudAmp = 0.8, quietAmp = 0.15 } = {}) {
  const out = new Float32Array(SR * seconds);
  const period = (60 / bpm) * SR;
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let beat = 0; beat * period < out.length; beat++) {
    const start = Math.round(beat * period);
    const amp = start / SR < quietUntil ? quietAmp : loudAmp;
    for (let i = 0; i < SR * 0.03 && start + i < out.length; i++) out[start + i] = amp * rand() * Math.exp(-i / (SR * 0.008));
  }
  return out;
}

test('estimateBpm finds the tempo of a click track', () => {
  for (const bpm of [90, 120, 140, 174]) {
    const est = estimateBpm(clickTrack(bpm, 30), SR).bpm;
    assert.ok(Math.abs(est - bpm) <= 2, `expected ~${bpm}, got ${est}`);
  }
  assert.equal(estimateBpm(new Float32Array(SR * 2), SR).bpm, null);
  // A steady tone has no beat: must return quickly (this used to loop forever).
  const tone = new Float32Array(SR * 20).map((_, i) => Math.sin(i / 5) * 0.3);
  const r = estimateBpm(tone, SR);
  assert.ok(r.bpm === null || (r.bpm >= 70 && r.bpm <= 180));
});

test('analyzeSamples: quiet intro, drop and best snippet', () => {
  const f = analyzeSamples(clickTrack(120, 90, { quietUntil: 30 }), SR);
  assert.equal(f.durationSec, 90);
  assert.ok(Math.abs(f.bpm - 120) <= 2);
  assert.ok(f.introSec >= 29 && f.introSec <= 31, `intro ${f.introSec}`);
  assert.ok(f.dropAtSec >= 28 && f.dropAtSec <= 32, `drop ${f.dropAtSec}`);
  assert.ok(f.bestSnippet15.start >= 30, `snippet ${JSON.stringify(f.bestSnippet15)}`);
  assert.equal(f.bestSnippet15.end - f.bestSnippet15.start, 15);
  assert.equal(f.energyCurve.length, 90);
  assert.ok(f.energyCurve.every((v) => v >= 0 && v <= 100));
  assert.ok(f.peakDb <= 0 && f.rmsDb < f.peakDb);
});

test('long tracks keep the curve at 300 points max; silence is safe', () => {
  const long = analyzeSamples(new Float32Array(8000 * 700).map((_, i) => Math.sin(i / 3) * 0.5), 8000);
  assert.ok(long.energyCurve.length <= 300);
  assert.equal(long.curveStepSec, 3);
  const silent = analyzeSamples(new Float32Array(SR * 10), SR);
  assert.equal(silent.peakDb, -180);
  assert.equal(silent.dropAtSec, null);
  assert.equal(silent.introSec, null);
});

test('mono mix, stereo correlation and WAV encoding', () => {
  const l = new Float32Array([0.5, -0.5, 0.5]);
  assert.deepEqual([...mixToMono([l, l])], [0.5, -0.5, 0.5]);
  assert.equal(stereoCorrelation(l, l), 1);
  assert.equal(stereoCorrelation(l, l.map((x) => -x)), -1);
  const wav = encodeWav16(new Float32Array([0, 1, -1]), 16000);
  assert.equal(wav.length, 50);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getInt16(46, true), 32767);
  assert.equal(view.getInt16(48, true), -32768);
});
