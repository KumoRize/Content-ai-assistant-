import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, mockProvider, PNG } from './helpers.js';

const captionReply = {
  contentAnalysis: { summary: 'Street food', subjects: ['kebab'], mood: 'hype', niche: 'food', scrollStopper: 'flame', audience: 'foodies' },
  trendInsights: [{ trend: 'Diwali recipes', source: 'Google Trends', relevance: 'festive', howToUse: 'tie in' }],
  platforms: {
    youtube: { title: 'Best Kebab?', caption: 'desc', hashtags: ['#food', '#kebab'], keywords: ['kebab'], hook: 'h', cta: 'c', bestTimeToPost: 't', formatTips: 'f' },
    x: { title: '', caption: 'Hot take', hashtags: ['food', 'kebab', 'extra'], keywords: [], hook: 'h', cta: 'c', bestTimeToPost: 't', formatTips: 'f' },
  },
};

test('with no AI engine, Basic mode answers; image ratings return 503', async () => {
  const app = await startApp({ provider: null });
  try {
    const h = await app.get('/api/health');
    assert.equal(h.body.configured, false);
    assert.deepEqual(h.body.basic, ['caption', 'music', 'ideas', 'thumbnail', 'artcover']);
    const r = await app.post('/api/assist/caption', { context: 'Street food tour in Lahore, spicy challenge' });
    assert.equal(r.status, 200);
    assert.equal(r.body.meta.engine, 'basic');
    assert.ok(r.body.result.platforms.x.charCount <= 280);
    const s = await app.post('/api/assist/score', { context: 'x' });
    assert.equal(s.status, 503);
    assert.match(s.body.error, /Puter/);
  } finally {
    await app.close();
  }
});

test('caption: end-to-end with images, trends and limits', async () => {
  const provider = mockProvider(captionReply);
  const app = await startApp({ provider });
  try {
    const r = await app.post('/api/assist/caption', {
      images: [{ mediaType: 'image/png', data: PNG, label: 'frame at 1.0s' }],
      instructions: 'Funny tone',
      platforms: ['youtube', 'x'],
      profile: { niche: 'food', language: 'Urdu' },
      geo: 'pk',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body.result.platforms), ['youtube', 'x']);
    assert.deepEqual(r.body.result.platforms.x.hashtags, ['#food', '#kebab']);
    assert.equal(r.body.meta.trendSources[0], 'Google Trends');
    const call = provider.calls[0];
    assert.equal(call.images.length, 1);
    assert.match(call.text, /Funny tone/);
    assert.match(call.text, /Output language: Urdu/);
    assert.match(call.text, /Diwali recipes/);
    assert.match(call.text, /region: PK/);
    assert.deepEqual(Object.keys(call.schema.properties.platforms.properties), ['youtube', 'x']);
    assert.equal(call.webSearch, false);
  } finally {
    await app.close();
  }
});

test('caption: validation errors', async () => {
  const app = await startApp({ provider: mockProvider(captionReply) });
  try {
    assert.equal((await app.post('/api/assist/caption', {})).status, 400);
    assert.equal((await app.post('/api/assist/caption', { context: 'x', platforms: ['myspace'] })).status, 400);
    assert.equal((await app.post('/api/assist/caption', { context: 'x', images: [{ mediaType: 'image/png', data: '%%%' }] })).status, 400);
    const tooMany = Array.from({ length: 13 }, () => ({ mediaType: 'image/png', data: PNG }));
    assert.match((await app.post('/api/assist/caption', { context: 'x', images: tooMany })).body.error, /up to 12/);
    assert.equal((await app.post('/api/assist/caption', '{bad json')).status, 400);
    assert.equal((await app.post('/api/assist/nope', {})).status, 404);
  } finally {
    await app.close();
  }
});

test('repairs one unreadable reply, then fails cleanly on a second', async () => {
  const provider = mockProvider(['sorry, here is text', JSON.stringify(captionReply)]);
  const app = await startApp({ provider });
  try {
    const ok = await app.post('/api/assist/caption', { context: 'x', platforms: ['x'] });
    assert.equal(ok.status, 200);
    assert.equal(provider.calls.length, 2);
    assert.match(provider.calls[1].text, /ONE valid JSON object/);
  } finally {
    await app.close();
  }
  const bad = await startApp({ provider: mockProvider(['nope', 'still nope', 'nope', 'nope']) });
  try {
    const forced = await bad.post('/api/assist/caption', { context: 'x', engine: 'claude' });
    assert.equal(forced.status, 502);
    const auto = await bad.post('/api/assist/caption', { context: 'x' });
    assert.equal(auto.status, 200);
    assert.equal(auto.body.meta.engine, 'basic', 'Auto falls back to Basic mode');
    assert.deepEqual(auto.body.meta.fellBackFrom, ['claude']);
  } finally {
    await bad.close();
  }
});

test('provider errors surface with their status', async () => {
  const { AppError } = await import('../src/errors.js');
  const app = await startApp({ provider: mockProvider(new AppError(429, 'rate limited')) });
  try {
    const r = await app.post('/api/assist/ideas', { prompt: 'gym', engine: 'claude' });
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'rate limited');
    const score = await app.post('/api/assist/score', { context: 'x' });
    assert.equal(score.status, 429, 'no Basic fallback for image ratings');
  } finally {
    await app.close();
  }
});

test('analyze: computes metrics and clamps scores', async () => {
  const provider = mockProvider({
    verdict: 'ok', viralPotential: 140,
    scores: { hook: 90, visualQuality: -5, clarity: 50, emotion: 60, trendFit: 70, shareability: 40, retention: 'x' },
    strengths: ['s'], weaknesses: ['w'],
    improvements: [{ priority: 'low', action: 'a1', why: 'w' }, { priority: 'HIGH', action: 'a2', why: 'w' }],
    metricsInterpretation: 'm', suggestedHooks: ['h'], suggestedCaption: 'c', hashtags: ['#a', '#b', '#c', '#d', '#e', '#f', '#g'],
    repurposePlan: [{ platform: 'tiktok', idea: 'i' }], nextExperiments: ['e'],
  });
  const app = await startApp({ provider });
  try {
    const r = await app.post('/api/assist/analyze', { context: 'reel', platform: 'instagram', metrics: { views: 1000, likes: 50, shares: 10 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const res = r.body.result;
    assert.equal(res.viralPotential, 100);
    assert.equal(res.scores.visualQuality, 0);
    assert.equal(res.scores.retention, null);
    assert.equal(res.improvements[0].action, 'a2');
    assert.equal(res.hashtags.length, 5);
    assert.equal(res.computedMetrics.engagementRateByViews, 6);
    assert.match(provider.calls[0].text, /"engagementRateByViews":6/);
  } finally {
    await app.close();
  }
});

test('ideas: count bounds and platform fallback', async () => {
  const provider = mockProvider({
    ideas: [
      { title: 'A', platform: 'tiktok', format: 'POV', hook: 'h', concept: 'c', outline: ['1'], whyItWillTrend: 'w', trendTieIn: 't', hashtags: ['#x'], effort: 'low', cta: 'c' },
      { title: 'B', platform: 'friendster', format: 'skit', hook: 'h', concept: 'c', outline: [], whyItWillTrend: 'w', trendTieIn: '', hashtags: [], effort: 'low', cta: '' },
      { title: 'C', platform: 'tiktok', format: 'x', hook: 'h', concept: 'c', outline: [], whyItWillTrend: 'w', trendTieIn: '', hashtags: [], effort: 'low', cta: '' },
    ],
    postingStrategy: 'p',
  });
  const app = await startApp({ provider });
  try {
    assert.equal((await app.post('/api/assist/ideas', { prompt: '' })).status, 400);
    assert.equal((await app.post('/api/assist/ideas', { prompt: 'x', count: 99 })).status, 400);
    const r = await app.post('/api/assist/ideas', { prompt: 'budget cooking', count: 2, platforms: ['tiktok', 'youtube'], webSearch: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.ideas.length, 2);
    assert.equal(r.body.result.ideas[1].platform, 'tiktok');
    assert.equal(provider.calls.at(-1).webSearch, true);
    assert.match(provider.calls.at(-1).text, /exactly 2 distinct ideas/);
  } finally {
    await app.close();
  }
});

test('thumbnail: one variant per requested ratio with model-ready prompts', async () => {
  const provider = mockProvider({
    contentAnalysis: { subject: 's', emotion: 'e', keyVisual: 'k', colorPalette: ['#ff0000'] },
    concept: 'c',
    variants: [
      { ratio: '16:9', useCase: 'yt', prompt: 'man shocked', negativePrompt: 'blurry', composition: 'left', textOverlay: 'WOW', colorPalette: [] },
      { ratio: '1:1', useCase: 'sq', prompt: 'square', negativePrompt: '', composition: '', textOverlay: '', colorPalette: [] },
    ],
    styleNotes: [], abTestIdeas: [],
  });
  const app = await startApp({ provider });
  try {
    assert.equal((await app.post('/api/assist/thumbnail', { ratios: ['16:9'] })).status, 400);
    const r = await app.post('/api/assist/thumbnail', { title: 'Desert', ratios: ['16:9', '9:16'], targetModel: 'midjourney', styles: ['Cinematic'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const res = r.body.result;
    assert.deepEqual(res.variants.map((v) => v.ratio), ['16:9']);
    assert.equal(res.variants[0].modelReady, 'man shocked --ar 16:9 --no blurry');
    assert.match(res.warnings[0], /9:16/);
    assert.equal(provider.calls[0].webSearch, false);
  } finally {
    await app.close();
  }
});

test('artcover: max 5 references and formats', async () => {
  const provider = mockProvider({
    referenceAnalysis: { commonThemes: ['neon'], palette: ['#000'], lighting: 'l', composition: 'c', mood: 'm' },
    concept: 'c', masterPrompt: 'neon car at night', negativePrompt: 'text',
    variations: [{ name: 'v1', style: 's', prompt: 'p1' }],
    formats: [{ ratio: '1:1', useCase: 'u', prompt: 'sq' }, { ratio: '9:16', useCase: 'u', prompt: 'tall' }],
    typography: { titleFont: 'f', placement: 'p', treatment: 't' },
    complianceNotes: ['no URLs'],
  });
  const app = await startApp({ provider });
  try {
    const six = Array.from({ length: 6 }, () => ({ mediaType: 'image/png', data: PNG }));
    assert.match((await app.post('/api/assist/artcover', { images: six, track: { title: 'x' } })).body.error, /up to 5/);
    assert.equal((await app.post('/api/assist/artcover', {})).status, 400);
    const r = await app.post('/api/assist/artcover', { images: six.slice(0, 5), track: { title: 'Midnight', genre: 'phonk' }, targetModel: 'sdxl', includeText: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const res = r.body.result;
    assert.deepEqual(res.formats.map((f) => f.ratio), ['1:1', '9:16']);
    assert.equal(res.formats[0].size, '3000×3000');
    assert.match(res.masterModelReady, /Negative prompt: text/);
    assert.match(provider.calls[0].text, /render "Midnight"/);
    assert.equal(provider.calls[0].images.length, 5);
  } finally {
    await app.close();
  }
});

test('rate limiting and config endpoint', async () => {
  const app = await startApp({ provider: mockProvider(captionReply), rateLimitPerMin: 2 });
  try {
    const cfg = await app.get('/api/config');
    assert.equal(cfg.body.maxImages.artcover, 5);
    assert.ok(cfg.body.ratios['9:16']);
    await app.post('/api/assist/caption', { context: 'x' });
    await app.post('/api/assist/caption', { context: 'x' });
    assert.equal((await app.post('/api/assist/caption', { context: 'x' })).status, 429);
    assert.equal((await app.get('/api/trends?geo=USA')).status, 400);
    assert.equal((await app.get('/api/trends?geo=gb')).body.geo, 'GB');
  } finally {
    await app.close();
  }
});
