import { createApp } from '../src/app.js';

// 1×1 transparent PNG
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export function mockProvider(replies) {
  const calls = [];
  const queue = Array.isArray(replies) ? [...replies] : null;
  return {
    name: 'mock',
    model: 'mock-1',
    supportsWebSearch: true,
    supportsVision: true,
    calls,
    async generate(req) {
      calls.push(req);
      const r = queue ? queue.shift() : replies;
      if (r instanceof Error) throw r;
      return { text: typeof r === 'string' ? r : JSON.stringify(r), model: 'mock-1' };
    },
  };
}

export const fakeTrends = {
  async get(geo) {
    return { geo, fetchedAt: '2026-10-03T00:00:00Z', sources: [{ name: 'Google Trends', ok: true, items: [{ term: 'Diwali recipes', traffic: '200K+' }] }] };
  },
};

export async function startApp(opts) {
  const app = createApp({ trends: fakeTrends, now: () => new Date('2026-10-03T12:00:00Z'), ...opts });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };
  return { base, post, get, close: () => new Promise((r) => server.close(r)) };
}
