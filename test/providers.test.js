import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import { createOpenAICompatibleProvider } from '../src/providers/openaiCompatible.js';
import { createProviderFromEnv } from '../src/providers/index.js';
import { PNG } from './helpers.js';

function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(structuredClone(params));
          const r = responses.shift();
          return { finalMessage: async () => { if (r instanceof Error) throw r; return r; } };
        },
      },
    },
  };
}
const msg = (text, stop_reason = 'end_turn') => ({ model: 'claude-opus-5-5', stop_reason, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] });

test('anthropic: builds vision + structured output request', async () => {
  const client = fakeClient([msg('{"ok":true}')]);
  const p = createAnthropicProvider({ client, model: 'claude-opus-5-5', effort: 'high' });
  const out = await p.generate({ system: 'sys', text: 'go', images: [{ mediaType: 'image/png', data: PNG, label: 'frame 1' }], schema: { type: 'object' } });
  assert.equal(out.text, '{"ok":true}');
  const c = client.calls[0];
  assert.equal(c.model, 'claude-opus-5-5');
  assert.deepEqual(c.thinking, { type: 'adaptive' });
  assert.equal(c.output_config.effort, 'high');
  assert.deepEqual(c.output_config.format, { type: 'json_schema', schema: { type: 'object' } });
  assert.equal(c.fallbacks, 'default');
  assert.deepEqual(c.betas, ['server-side-fallback-2026-07-01']);
  const content = c.messages[0].content;
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].source.media_type, 'image/png');
  assert.equal(content.at(-1).text, 'go');
  assert.equal(c.tools, undefined);
});

test('anthropic: web search resumes pause_turn and skips schema format', async () => {
  const client = fakeClient([msg('searching', 'pause_turn'), msg('{"done":1}')]);
  const p = createAnthropicProvider({ client });
  const out = await p.generate({ system: 's', text: 't', schema: { type: 'object' }, webSearch: true });
  assert.equal(out.text, '{"done":1}');
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].tools[0].type, 'web_search_20260209');
  assert.equal(client.calls[0].output_config.format, undefined);
  assert.equal(client.calls[1].messages.at(-1).role, 'assistant');
});

test('anthropic: refusal and truncation become clear errors', async () => {
  const p1 = createAnthropicProvider({ client: fakeClient([msg('', 'refusal')]) });
  await assert.rejects(p1.generate({ system: 's', text: 't' }), (e) => e.status === 422);
  const p2 = createAnthropicProvider({ client: fakeClient([msg('{"a"', 'max_tokens')]) });
  await assert.rejects(p2.generate({ system: 's', text: 't' }), /cut off/);
});

test('anthropic: retries without fallbacks if rejected, maps auth errors', async () => {
  const bad = new Anthropic.BadRequestError(400, { error: { message: 'fallbacks: unsupported' } }, 'fallbacks: unsupported', new Headers());
  const client = fakeClient([bad, msg('{"x":1}')]);
  const p = createAnthropicProvider({ client });
  assert.equal((await p.generate({ system: 's', text: 't' })).text, '{"x":1}');
  assert.equal(client.calls[1].fallbacks, undefined);

  const auth = new Anthropic.AuthenticationError(401, { error: { message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
  const p2 = createAnthropicProvider({ client: fakeClient([auth]) });
  await assert.rejects(p2.generate({ system: 's', text: 't' }), (e) => e.status === 401 && /ANTHROPIC_API_KEY/.test(e.message));
});

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const r = responses.shift();
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  fn.calls = calls;
  return fn;
}

test('openai-compatible: sends images as data URLs, drops JSON mode on 400', async () => {
  const fetchImpl = fakeFetch([
    { status: 400, body: { error: { message: 'response_format not supported with images' } } },
    { status: 200, body: { model: 'llama', choices: [{ finish_reason: 'stop', message: { content: '{"a":1}' } }] } },
  ]);
  const p = createOpenAICompatibleProvider({ baseUrl: 'https://api.example.com/v1/', apiKey: 'k', model: 'llama', fetchImpl });
  const out = await p.generate({ system: 's', text: 't', images: [{ mediaType: 'image/png', data: PNG }], schema: { type: 'object' } });
  assert.equal(out.text, '{"a":1}');
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.com/v1/chat/completions');
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer k');
  assert.deepEqual(fetchImpl.calls[0].body.response_format, { type: 'json_object' });
  assert.equal(fetchImpl.calls[1].body.response_format, undefined);
  const user = fetchImpl.calls[1].body.messages[1].content;
  assert.match(user[1].image_url.url, /^data:image\/png;base64,/);
  assert.match(user[0].text, /JSON Schema/);
});

test('openai-compatible: text-only models, errors and truncation', async () => {
  const f1 = fakeFetch([{ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] } }]);
  const p1 = createOpenAICompatibleProvider({ baseUrl: 'http://localhost:11434/v1', model: 'llama3', supportsVision: false, fetchImpl: f1 });
  await p1.generate({ system: 's', text: 't', images: [{ mediaType: 'image/png', data: PNG }] });
  assert.equal(typeof f1.calls[0].body.messages[1].content, 'string');
  assert.match(f1.calls[0].body.messages[1].content, /cannot see images/);
  assert.equal(f1.calls[0].headers.Authorization, undefined);

  const p2 = createOpenAICompatibleProvider({ baseUrl: 'http://x/v1', model: 'm', fetchImpl: fakeFetch([{ status: 401, body: { error: { message: 'bad key' } } }]) });
  await assert.rejects(p2.generate({ system: 's', text: 't' }), (e) => e.status === 401);
  const p3 = createOpenAICompatibleProvider({ baseUrl: 'http://x/v1', model: 'm', fetchImpl: fakeFetch([{ status: 200, body: { choices: [{ finish_reason: 'length', message: { content: '{"a' } }] } }]) });
  await assert.rejects(p3.generate({ system: 's', text: 't' }), /cut off/);
});

test('createProviderFromEnv', () => {
  assert.equal(createProviderFromEnv({}), null);
  assert.equal(createProviderFromEnv({ ANTHROPIC_API_KEY: 'k' }).name, 'anthropic');
  assert.equal(createProviderFromEnv({ ANTHROPIC_API_KEY: 'k' }).model, 'claude-opus-5-5');
  assert.equal(createProviderFromEnv({ AI_PROVIDER: 'openai-compatible', OSS_BASE_URL: 'http://x/v1', OSS_MODEL: 'm' }).name, 'openai-compatible');
  assert.equal(createProviderFromEnv({ AI_PROVIDER: 'openai-compatible' }), null);
  assert.throws(() => createProviderFromEnv({ AI_PROVIDER: 'skynet' }), /Unknown AI_PROVIDER/);
});
