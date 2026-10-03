import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, mockProvider } from './helpers.js';
import { AppError } from '../src/errors.js';

const ideasReply = { ideas: [{ title: 'A', platform: 'tiktok', format: 'f', hook: 'h', concept: 'c', outline: [], whyItWillTrend: 'w', trendTieIn: '', hashtags: [], effort: 'low', cta: '' }], postingStrategy: 'p' };

function engines(claudeReply, ossReply) {
  const claude = { ...mockProvider(claudeReply), label: 'Claude', supportsWebSearch: true };
  const oss = { ...mockProvider(ossReply), label: 'Open-source', supportsWebSearch: false, model: 'llama' };
  oss.transcribe = async ({ language }) => ({ text: `lyrics ${language ?? ''}`.trim(), model: 'whisper-large-v3-turbo' });
  return { claude, oss };
}

test('health lists both engines in preferred order', async () => {
  const app = await startApp({ providers: engines(ideasReply, ideasReply), preferred: 'oss' });
  try {
    const h = (await app.get('/api/health')).body;
    assert.deepEqual(Object.keys(h.engines), ['oss', 'claude']);
    assert.equal(h.preferred, 'oss');
    assert.equal(h.engines.claude.webSearch, true);
    assert.equal(h.transcription, true);
  } finally {
    await app.close();
  }
});

test('auto falls back to open-source when Claude is out of credit, without the web search prompt', async () => {
  const p = engines(new AppError(400, 'Claude rejected the request: Your credit balance is too low'), ideasReply);
  const app = await startApp({ providers: p });
  try {
    const r = await app.post('/api/assist/ideas', { prompt: 'gym', webSearch: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.meta.engine, 'oss');
    assert.deepEqual(r.body.meta.fellBackFrom, ['claude']);
    assert.equal(r.body.meta.webSearch, false);
    assert.match(p.claude.calls[0].text, /web_search tool/);
    assert.doesNotMatch(p.oss.calls[0].text, /web_search tool/);
  } finally {
    await app.close();
  }
});

test('explicit engine choice: no fallback, unknown engine rejected, invalid input not retried', async () => {
  const p = engines(new AppError(429, 'Claude rate limit'), ideasReply);
  const app = await startApp({ providers: p });
  try {
    assert.equal((await app.post('/api/assist/ideas', { prompt: 'x', engine: 'claude' })).status, 429);
    const r = await app.post('/api/assist/ideas', { prompt: 'x', engine: 'oss' });
    assert.equal(r.body.meta.engine, 'oss');
    assert.equal((await app.post('/api/assist/ideas', { prompt: 'x', engine: 'gpt' })).status, 400);
  } finally {
    await app.close();
  }
  const p2 = engines(new AppError(401, 'bad key'), ideasReply);
  const app2 = await startApp({ providers: p2 });
  try {
    assert.equal((await app2.post('/api/assist/ideas', { prompt: 'x' })).status, 401, 'auth errors are not hidden by fallback');
    assert.equal(p2.oss.calls.length, 0);
  } finally {
    await app2.close();
  }
});

test('transcribe endpoint', async () => {
  const app = await startApp({ providers: engines(ideasReply, ideasReply) });
  try {
    const ok = await app.post('/api/transcribe', { audio: { data: 'UklGRg==', mediaType: 'audio/wav' }, language: 'hi' });
    assert.deepEqual(ok.body, { text: 'lyrics hi', model: 'whisper-large-v3-turbo' });
    assert.equal((await app.post('/api/transcribe', { audio: { data: '!!', mediaType: 'audio/wav' } })).status, 400);
    assert.equal((await app.post('/api/transcribe', { audio: { data: 'AAAA', mediaType: 'video/avi' } })).status, 400);
  } finally {
    await app.close();
  }
  const claudeOnly = await startApp({ provider: mockProvider(ideasReply) });
  try {
    assert.equal((await claudeOnly.post('/api/transcribe', { audio: { data: 'AAAA', mediaType: 'audio/wav' } })).status, 503);
  } finally {
    await claudeOnly.close();
  }
});
