import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, mockProvider, PNG } from './helpers.js';
import { grade, CRITERIA_KEYS } from '../src/assistants/score.js';

const reply = {
  criteria: { hook: 80, visualQuality: 70, originality: 60, emotionalImpact: 90, clarity: 50, trendAlignment: 40, shareability: 65 },
  criteriaReasons: Object.fromEntries(CRITERIA_KEYS.map((k) => [k, `reason ${k}`])),
  trendingPotential: 62,
  platformPotential: { tiktok: { potential: 120, reason: 'loops well' } },
  verdict: 'Good, not viral yet.',
  strengths: [{ point: 'Clear subject', impact: 'low' }, { point: 'Big emotion', impact: 'HIGH' }, 'plain string strength'],
  weaknesses: ['Slow start'],
  improvements: [
    { action: 'Add caption text', criterion: 'clarity', estimatedGain: 5, why: 'w' },
    { action: 'Cut the first second', criterion: 'hook', estimatedGain: 12, why: 'w' },
    { action: 'Vague tip', criterion: 'vibes', estimatedGain: 'lots', why: 'w' },
  ],
  projectedScore: 40,
  trendMatches: [{ trend: 'POV format', source: 'evergreen', howToUse: 'h' }],
};

test('grade boundaries', () => {
  assert.equal(grade(95), 'A+');
  assert.equal(grade(80), 'A');
  assert.equal(grade(79), 'B');
  assert.equal(grade(55), 'C');
  assert.equal(grade(40), 'D');
  assert.equal(grade(39), 'F');
  assert.equal(grade(null), '-');
});

test('score: percentages are consistent and computed server-side', async () => {
  const provider = mockProvider(reply);
  const app = await startApp({ provider });
  try {
    const r = await app.post('/api/assist/score', { images: [{ mediaType: 'image/png', data: PNG }], platforms: ['tiktok', 'instagram'], instructions: 'Be harsh' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = r.body.result;
    assert.equal(s.strength, 70); // mean of hook, visual, originality, emotion, clarity
    assert.equal(s.trendingPotential, 62);
    assert.equal(s.overall, 66);
    assert.equal(s.grade, 'C');
    assert.equal(s.projectedScore, 66, 'projected never below current');
    assert.equal(s.criteria.length, 7);
    assert.equal(s.criteria[0].reason, 'reason hook');
    assert.deepEqual(s.platformPotential.map((p) => [p.platform, p.potential]), [['tiktok', 100], ['instagram', null]]);
    assert.equal(s.strengths[0].point, 'Big emotion');
    assert.equal(s.strengths.length, 3);
    assert.deepEqual(s.improvements.map((i) => i.estimatedGain), [12, 5, 0]);
    assert.equal(s.improvements[2].criterion, '');
    const call = provider.calls[0];
    assert.match(call.text, /Be harsh/);
    assert.match(call.text, /Diwali recipes/);
    assert.deepEqual(Object.keys(call.schema.properties.platformPotential.properties), ['tiktok', 'instagram']);
  } finally {
    await app.close();
  }
});

test('score: empty model output does not crash; missing input is a 400', async () => {
  const app = await startApp({ provider: mockProvider({}) });
  try {
    assert.equal((await app.post('/api/assist/score', {})).status, 400);
    const r = await app.post('/api/assist/score', { context: 'my reel about cats' });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.overall, null);
    assert.equal(r.body.result.grade, '-');
    assert.equal(r.body.result.platformPotential.length, 6);
  } finally {
    await app.close();
  }
});
