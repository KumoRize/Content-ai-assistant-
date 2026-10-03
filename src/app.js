import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSISTANTS } from './assistants/index.js';
import { AppError } from './errors.js';
import { extractJson } from './json.js';
import { createTrendsService, formatTrendsForPrompt } from './trends.js';
import { COVER_STYLES, IMAGE_MODELS, PLATFORMS, RATIOS, THUMBNAIL_STYLES } from './config.js';
import * as v from './util.js';
import { basicAvailable, generateBasic, BASIC_NOTE } from './basic.js';
import { randomUUID } from 'node:crypto';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function rateLimiter(perMinute) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60000);
    if (recent.length >= perMinute) {
      return next(new AppError(429, 'Too many requests. Please wait a minute.'));
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10000) hits.clear();
    next();
  };
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// Errors worth retrying on the other engine: rate limits, outages, and out-of-credit/billing errors.
const shouldFallBack = (err) => err instanceof AppError && (RETRYABLE.has(err.status) || /credit|billing|quota/i.test(err.message));

export function createApp({ providers = {}, provider = null, preferred = 'claude', puterModel = process.env.PUTER_MODEL || '', trends = createTrendsService(), rateLimitPerMin = 20, now = () => new Date() } = {}) {
  if (provider) providers = { ...providers, [preferred]: provider };
  const engines = Object.keys(providers);
  const order = engines.includes(preferred) ? [preferred, ...engines.filter((e) => e !== preferred)] : engines;

  // Server-side engines to try. "basic" is the built-in generator; Auto ends with it when allowed.
  function pickEngines(choice, assistantId) {
    const withBasic = (list) => (basicAvailable(assistantId) ? [...list, 'basic'] : list);
    if (choice === 'basic') return ['basic'];
    if (choice == null || choice === '' || choice === 'auto') {
      const list = withBasic(order);
      if (!list.length) throw new AppError(503, 'No AI engine is available on the server for this assistant. Choose the free browser AI (Puter) in the engine menu.');
      return list;
    }
    if (!engines.includes(choice)) {
      throw new AppError(400, `The "${choice === 'oss' ? 'Open-source' : choice === 'claude' ? 'Claude' : choice}" engine is not configured on this server.`);
    }
    return [choice];
  }

  async function generateWithFallback(candidates, request) {
    let lastErr;
    for (let i = 0; i < candidates.length; i++) {
      const engine = candidates[i];
      if (engine === 'basic') {
        return { data: request.basic(), engine, provider: { label: 'Basic mode (built-in, no AI)' }, model: 'rules', webSearch: false, fellBackFrom: candidates.slice(0, i), note: BASIC_NOTE };
      }
      const p = providers[engine];
      try {
        const webSearch = Boolean(request.webSearch && p.supportsWebSearch);
        // Rebuild the prompt per engine so a fallback engine isn't told it has a web search tool.
        const req = { ...request, webSearch, text: request.buildText(webSearch) };
        delete req.buildText;
        let reply = await p.generate(req);
        let data = extractJson(reply.text);
        if (!data) {
          // One repair attempt: smaller open-source models occasionally wrap or break the JSON.
          reply = await p.generate({ ...req, text: `${req.text}\n\nIMPORTANT: respond with ONE valid JSON object only. No prose, no markdown.` });
          data = extractJson(reply.text);
        }
        if (!data) throw new AppError(502, 'The AI returned an unreadable answer. Please try again.');
        return { data, engine, provider: p, model: reply.model, webSearch: req.webSearch, fellBackFrom: i > 0 ? candidates.slice(0, i) : [] };
      } catch (err) {
        lastErr = err;
        if (i === candidates.length - 1 || !shouldFallBack(err)) throw err;
        console.warn(`Engine "${engine}" failed (${err.message}); falling back.`);
      }
    }
    throw lastErr;
  }

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '40mb' }));
  app.use(express.static(publicDir));

  async function prepare(assistant, body) {
    const input = assistant.normalize(body);
    let trendData = null;
    let trendsText = '';
    if (input.useLiveTrends) {
      trendData = await trends.get(input.geo).catch(() => null);
      trendsText = formatTrendsForPrompt(trendData);
    }
    return { input, trendData, ctx: { today: now().toISOString().slice(0, 10), trendsText, trendData } };
  }

  function respond(assistant, prep, data, meta) {
    return {
      assistant: assistant.id,
      result: assistant.postprocess(data, prep.input),
      meta: {
        ...meta,
        trendSources: prep.trendData ? prep.trendData.sources.filter((s) => s.ok && s.items.length).map((s) => s.name) : [],
      },
    };
  }

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      configured: engines.length > 0,
      basic: Object.keys(ASSISTANTS).filter(basicAvailable),
      preferred: order[0] ?? null,
      engines: Object.fromEntries(
        order.map((e) => [e, { label: providers[e].label ?? e, model: providers[e].model, webSearch: Boolean(providers[e].supportsWebSearch), vision: Boolean(providers[e].supportsVision) }]),
      ),
      transcription: engines.some((e) => typeof providers[e].transcribe === 'function'),
    });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      platforms: Object.fromEntries(Object.entries(PLATFORMS).map(([k, p]) => [k, { label: p.label, captionMax: p.captionMax, hashtagMax: p.hashtagMax }])),
      ratios: RATIOS,
      imageModels: IMAGE_MODELS,
      thumbnailStyles: THUMBNAIL_STYLES,
      coverStyles: COVER_STYLES,
      maxImages: Object.fromEntries(Object.values(ASSISTANTS).map((a) => [a.id, a.maxImages])),
      puterModel: puterModel || null,
    });
  });

  app.get('/api/trends', async (req, res, next) => {
    try {
      res.json(await trends.get(v.geo(req.query.geo), { force: req.query.refresh === '1' }));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/assist/:id', rateLimiter(rateLimitPerMin), async (req, res, next) => {
    try {
      const assistant = ASSISTANTS[req.params.id];
      if (!assistant) throw new AppError(404, 'Unknown assistant.');

      const candidates = pickEngines(req.body?.engine, assistant.id);
      const prep = await prepare(assistant, req.body ?? {});
      const out = await generateWithFallback(candidates, {
        system: assistant.system,
        buildText: (webSearch) => assistant.buildPrompt(prep.input, { ...prep.ctx, webSearch }),
        images: prep.input.images,
        schema: assistant.schema(prep.input),
        webSearch: prep.input.webSearch,
        basic: () => generateBasic(assistant.id, prep.input, prep.ctx),
      });
      res.json(respond(assistant, prep, out.data, {
        engine: out.engine,
        provider: out.provider.label ?? out.provider.name,
        model: out.model,
        webSearch: out.webSearch,
        fellBackFrom: out.fellBackFrom,
        note: out.note,
      }));
    } catch (err) {
      next(err);
    }
  });

  // Browser-side AI (Puter.js): the server builds the prompt, the browser runs it, the server
  // validates and cleans the answer. Prepared inputs are kept briefly in memory.
  const pending = new Map();
  const PENDING_TTL = 15 * 60 * 1000;
  const sweep = () => {
    const cutoff = Date.now() - PENDING_TTL;
    for (const [k, val] of pending) if (val.at < cutoff) pending.delete(k);
  };

  app.post('/api/assist/:id/prepare', rateLimiter(rateLimitPerMin), async (req, res, next) => {
    try {
      const assistant = ASSISTANTS[req.params.id];
      if (!assistant) throw new AppError(404, 'Unknown assistant.');
      const prep = await prepare(assistant, req.body ?? {});
      sweep();
      if (pending.size > 2000) pending.clear();
      const token = randomUUID();
      pending.set(token, { at: Date.now(), assistantId: assistant.id, prep });
      const schema = assistant.schema(prep.input);
      res.json({
        token,
        system: assistant.system,
        prompt: `${assistant.buildPrompt(prep.input, { ...prep.ctx, webSearch: false })}\n\nReturn ONLY a JSON object matching this JSON Schema (no markdown, no commentary):\n${JSON.stringify(schema)}`,
        basicAvailable: basicAvailable(assistant.id),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/assist/:id/finish', async (req, res, next) => {
    try {
      const assistant = ASSISTANTS[req.params.id];
      const entry = pending.get(req.body?.token);
      if (!assistant || !entry || entry.assistantId !== assistant.id) throw new AppError(410, 'This request expired. Please generate again.');
      const { prep } = entry;
      if (req.body.basic === true) {
        // Browser AI was unavailable: answer with the built-in generator instead.
        pending.delete(req.body.token);
        const data = generateBasic(assistant.id, prep.input, prep.ctx);
        return res.json(respond(assistant, prep, data, { engine: 'basic', provider: 'Basic mode (built-in, no AI)', model: 'rules', webSearch: false, fellBackFrom: ['puter'], note: BASIC_NOTE }));
      }
      const data = extractJson(typeof req.body.text === 'string' ? req.body.text : '');
      if (!data) throw new AppError(422, 'The AI returned an unreadable answer.');
      pending.delete(req.body.token);
      const model = typeof req.body.model === 'string' ? req.body.model.slice(0, 80) : 'puter';
      res.json(respond(assistant, prep, data, { engine: 'puter', provider: 'Free browser AI (Puter)', model, webSearch: false, fellBackFrom: [] }));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/transcribe', rateLimiter(rateLimitPerMin), async (req, res, next) => {
    try {
      const engine = engines.find((e) => typeof providers[e].transcribe === 'function');
      if (!engine) throw new AppError(503, 'Lyrics transcription needs the open-source engine (set OSS_API_KEY, e.g. a free Groq key).');
      const audio = req.body?.audio;
      if (!audio || typeof audio.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio.data)) {
        throw new AppError(400, 'Send the audio as base64 in "audio.data".');
      }
      if (!['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/flac'].includes(audio.mediaType)) {
        throw new AppError(400, 'Unsupported audio type.');
      }
      if ((audio.data.length * 3) / 4 > 24 * 1024 * 1024) throw new AppError(413, 'Audio is larger than 24 MB. Use a shorter section.');
      const language = typeof req.body.language === 'string' && /^[a-z]{2}$/.test(req.body.language) ? req.body.language : undefined;
      const out = await providers[engine].transcribe({ data: audio.data, mediaType: audio.mediaType, language });
      res.json({ text: out.text, model: out.model });
    } catch (err) {
      next(err);
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Upload too large. Use fewer or smaller files.' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  });

  return app;
}
