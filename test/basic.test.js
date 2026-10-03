import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { keywords, tagify } from '../src/basic.js';
import { analyzeSamples } from '../public/audio-features.js';

test('keywords and tagify', () => {
  assert.deepEqual(keywords('Spicy street food tour. Street food is the best food!', 3), ['food', 'street', 'spicy']);
  assert.equal(tagify('street food'), '#StreetFood');
  assert.equal(tagify('खाना पीना'), '#खानापीना');
  assert.equal(tagify('!!'), '');
});

test('Basic mode: every supported assistant returns valid, cleaned output', async () => {
  const app = await startApp({ provider: null });
  try {
    const cap = await app.post('/api/assist/caption', { context: 'Making biryani for 100 people', platforms: ['youtube', 'x', 'threads', 'instagram'], profile: { niche: 'cooking', brandWords: 'ChefAli' } });
    assert.equal(cap.status, 200, JSON.stringify(cap.body));
    const c = cap.body.result;
    assert.match(c.platforms.youtube.title, /Biryani/);
    assert.ok(c.platforms.x.charCount <= 280);
    assert.equal(c.platforms.threads.hashtags.length, 1);
    assert.ok(c.platforms.instagram.hashtags.includes('#Biryani'));
    assert.match(c.platforms.instagram.caption, /ChefAli/);
    assert.deepEqual(c.trendInsights, [], 'the fake trend "Diwali recipes" shares no keyword with biryani');
  } finally {
    await app.close();
  }
});

test('Basic mode: ideas, thumbnail, artcover', async () => {
  const app = await startApp({ provider: null });
  try {
    const ideas = await app.post('/api/assist/ideas', { prompt: 'budget travel in Europe', count: 4, platforms: ['tiktok', 'youtube'] });
    assert.equal(ideas.status, 200);
    assert.equal(ideas.body.result.ideas.length, 4);
    assert.deepEqual(ideas.body.result.ideas.map((i) => i.platform), ['tiktok', 'youtube', 'tiktok', 'youtube']);
    assert.equal(new Set(ideas.body.result.ideas.map((i) => i.format)).size, 4);

    const th = await app.post('/api/assist/thumbnail', { title: 'I survived 24 hours in the desert', ratios: ['16:9', '9:16'], styles: ['Cinematic'], targetModel: 'midjourney' });
    assert.equal(th.status, 200);
    assert.equal(th.body.result.variants.length, 2);
    assert.match(th.body.result.variants[0].modelReady, /--ar 16:9 --no /);
    assert.match(th.body.result.variants[1].prompt, /bottom 20%/);

    const art = await app.post('/api/assist/artcover', { track: { title: 'Midnight', genre: 'phonk', mood: 'dark' }, includeText: true });
    assert.equal(art.status, 200);
    assert.match(art.body.result.masterPrompt, /drifting car/);
    assert.match(art.body.result.masterPrompt, /"Midnight"/);
    assert.equal(art.body.result.formats.length, 3);
  } finally {
    await app.close();
  }
});

test('Basic mode: music scores come from real measurements', async () => {
  const SR = 22050;
  const pcm = new Float32Array(SR * 100);
  for (let beat = 0; beat * 0.5 * SR < pcm.length; beat++) {
    const start = Math.round(beat * 0.5 * SR);
    const amp = start / SR < 30 ? 0.1 : 0.8;
    for (let i = 0; i < SR * 0.03 && start + i < pcm.length; i++) pcm[start + i] = amp * Math.sin(i / 3) * Math.exp(-i / (SR * 0.01));
  }
  const features = analyzeSamples(pcm, SR);
  const app = await startApp({ provider: null });
  try {
    const r = await app.post('/api/assist/music', { features, lyrics: 'drive all night\ndrive all night\nneon lights' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = r.body.result;
    assert.equal(r.body.meta.engine, 'basic');
    assert.equal(m.confidence, 'low');
    assert.ok(m.overall >= 30 && m.overall <= 90, String(m.overall));
    assert.ok(m.peakMoment.start >= 30, `peak ${m.peakMoment.label}`);
    assert.equal(m.timeline.momentumByWeek.length, 12);
    assert.equal(m.timeline.peakWeek, m.timeline.momentumByWeek.indexOf(Math.max(...m.timeline.momentumByWeek)) + 1);
    assert.ok(m.improvements.some((i) => /8 seconds/.test(i.action)), 'long intro flagged');
    assert.ok(m.snippets.length >= 2);
  } finally {
    await app.close();
  }
});

test('browser AI flow: prepare -> finish, with Basic fallback and expiry', async () => {
  const app = await startApp({ provider: null });
  try {
    const prep = await app.post('/api/assist/ideas/prepare', { prompt: 'gym for students', count: 1 });
    assert.equal(prep.status, 200);
    assert.match(prep.body.prompt, /gym for students/);
    assert.match(prep.body.prompt, /JSON Schema/);
    assert.equal(prep.body.basicAvailable, true);

    const bad = await app.post('/api/assist/ideas/finish', { token: prep.body.token, text: 'sorry' });
    assert.equal(bad.status, 422, 'unreadable answers can be retried with the same token');
    const reply = { ideas: [{ title: 'Gym hacks', platform: 'tiktok', format: 'POV', hook: 'h', concept: 'c', outline: [], whyItWillTrend: 'w', trendTieIn: '', hashtags: ['#gym'], effort: 'low', cta: '' }], postingStrategy: 'p' };
    const ok = await app.post('/api/assist/ideas/finish', { token: prep.body.token, text: `Here: ${JSON.stringify(reply)}`, model: 'gpt-x' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.meta.engine, 'puter');
    assert.equal(ok.body.result.ideas[0].title, 'Gym hacks');
    assert.equal((await app.post('/api/assist/ideas/finish', { token: prep.body.token, text: '{}' })).status, 410, 'token is single-use');

    const prep2 = await app.post('/api/assist/ideas/prepare', { prompt: 'cooking', count: 2 });
    const fb = await app.post('/api/assist/ideas/finish', { token: prep2.body.token, basic: true });
    assert.equal(fb.body.meta.engine, 'basic');
    assert.equal(fb.body.result.ideas.length, 2);

    assert.equal((await app.post('/api/assist/ideas/finish', { token: 'nope', text: '{}' })).status, 410);
    assert.equal((await app.post('/api/assist/score/prepare', {})).status, 400, 'validation still applies');
  } finally {
    await app.close();
  }
});
