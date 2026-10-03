import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, mockProvider } from './helpers.js';
import { readFeatures, mmss, MUSIC_CRITERIA_KEYS } from '../src/assistants/music.js';
import { analyzeSamples } from '../public/audio-features.js';

const features = {
  durationSec: 180, bpm: 140, bpmConfidence: 0.4, peakDb: -0.3, rmsDb: -9.5, crestDb: 9.2, brightness: 'bright', stereoCorrelation: 0.6,
  silenceStartSec: 0, silenceEndSec: 1, introSec: 32, dropAtSec: 45, dropStrength: 40,
  bestSnippet15: { start: 45, end: 60, avgEnergy: 95 }, bestSnippet30: { start: 40, end: 70, avgEnergy: 90 },
  curveStepSec: 1, energyCurve: Array.from({ length: 180 }, (_, i) => (i > 45 ? 90 : 30)),
};

const reply = {
  criteria: { catchiness: 80, production: 70, mixQuality: 60, originality: 50, lyrics: 70, replayValue: 90, viralSnippet: 85, genreTrendFit: 75 },
  criteriaReasons: Object.fromEntries(MUSIC_CRITERIA_KEYS.map((k) => [k, `r ${k}`])),
  trendingPotential: 72,
  platformPotential: { tiktok: { potential: 88, reason: 'drop' }, spotify: { potential: 150, reason: 'x' } },
  confidence: 'MEDIUM',
  confidenceNote: 'Cannot hear vocals',
  verdict: 'Strong drop.',
  peakMoment: { start: 45, end: 400, why: 'beat switch' },
  snippets: [{ start: 45, end: 60, useFor: 'TikTok 15s', why: 'drop' }, { start: 70, end: 60, useFor: 'bad', why: 'end before start' }],
  timeline: { timeToPeak: '2-3 weeks', peakWeek: 9, trendLifespanWeeks: 10, momentumByWeek: [20, 60, 85, 70, 50, 40, 30, 20, 15, 10, 8, 5, 4, 3, 2, 1, 1, 1], bestReleaseTiming: 'Friday', phases: [{ phase: 'Teasers', when: 'Week -2', focus: 'f', actions: ['a'] }] },
  strengths: [{ point: 'Hard drop', impact: 'high' }],
  weaknesses: ['Long intro'],
  improvements: [{ action: 'Cut intro to 8s', criterion: 'viralSnippet', estimatedGain: 10, why: 'w' }],
  trendMatches: [],
};

test('readFeatures validates and sanitizes', () => {
  assert.equal(readFeatures(undefined), null);
  assert.throws(() => readFeatures({}), /track length/);
  assert.throws(() => readFeatures([1]), /must be an object/);
  const f = readFeatures({ ...features, bpm: 9999, brightness: '<script>', energyCurve: [50, 'x', 500], bestSnippet15: { start: 170, end: 999 } });
  assert.equal(f.bpm, null);
  assert.equal(f.brightness, null);
  assert.deepEqual(f.energyCurve, [50, 0, 0]);
  assert.equal(f.bestSnippet15, null);
  assert.equal(mmss(75), '1:15');
  // The browser analyzer's output passes validation unchanged in shape.
  const real = analyzeSamples(new Float32Array(22050 * 20).map((_, i) => Math.sin(i / 5) * 0.3), 22050);
  assert.equal(readFeatures(real).durationSec, 20);
});

test('music: end-to-end rating, peak moment and timeline', async () => {
  const provider = mockProvider(reply);
  const app = await startApp({ provider });
  try {
    const r = await app.post('/api/assist/music', {
      features,
      track: { title: 'Midnight', genre: 'phonk', releaseDate: '2026-11-20' },
      lyrics: 'drive all night',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = r.body.result;
    assert.equal(m.strength, 70);
    assert.equal(m.overall, 71);
    assert.equal(m.grade, 'B');
    assert.equal(m.confidence, 'medium');
    assert.deepEqual(m.peakMoment, { start: 45, end: 180, label: '0:45–3:00', why: 'beat switch' });
    assert.equal(m.snippets.length, 1);
    assert.equal(m.timeline.momentumByWeek.length, 16);
    assert.equal(m.timeline.peakWeek, 3, 'peak week follows the momentum curve');
    assert.equal(m.timeline.releaseDate, '2026-11-20');
    assert.equal(m.platformPotential.length, 6);
    assert.equal(m.platformPotential.find((p) => p.platform === 'spotify').potential, 100);
    assert.equal(m.measured.dropAt, '0:45');
    const text = provider.calls[0].text;
    assert.match(text, /Estimated tempo: 140 BPM/);
    assert.match(text, /Biggest energy rise \(drop\/chorus entry\) at 0:45/);
    assert.match(text, /drive all night/);
    assert.match(text, /Release date: 2026-11-20/);
  } finally {
    await app.close();
  }
});

test('music: input validation and no-audio mode', async () => {
  const provider = mockProvider({});
  const app = await startApp({ provider });
  try {
    assert.equal((await app.post('/api/assist/music', {})).status, 400);
    assert.equal((await app.post('/api/assist/music', { lyrics: 'x', track: { releaseDate: 'soon' } })).status, 400);
    assert.equal((await app.post('/api/assist/music', { features: { durationSec: -1 } })).status, 400);
    const r = await app.post('/api/assist/music', { description: 'sad piano ballad' });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.measured, null);
    assert.equal(r.body.result.overall, null);
    assert.match(provider.calls.at(-1).text, /No audio file was analyzed/);
  } finally {
    await app.close();
  }
});
