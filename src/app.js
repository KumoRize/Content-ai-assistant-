import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSISTANTS } from './assistants/index.js';
import { AppError } from './errors.js';
import { extractJson } from './json.js';
import { createTrendsService, formatTrendsForPrompt } from './trends.js';
import { COVER_STYLES, IMAGE_MODELS, PLATFORMS, RATIOS, THUMBNAIL_STYLES } from './config.js';
import * as v from './util.js';

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

export function createApp({ provider = null, trends = createTrendsService(), rateLimitPerMin = 20, now = () => new Date() } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '40mb' }));
  app.use(express.static(publicDir));

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      configured: Boolean(provider),
      provider: provider?.name ?? null,
      model: provider?.model ?? null,
      webSearch: Boolean(provider?.supportsWebSearch),
      vision: Boolean(provider?.supportsVision),
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
      if (!provider) throw new AppError(503, 'No AI provider configured. Add ANTHROPIC_API_KEY (or OSS_* settings) to .env and restart.');

      const input = assistant.normalize(req.body ?? {});
      let trendData = null;
      let trendsText = '';
      if (input.useLiveTrends) {
        trendData = await trends.get(input.geo).catch(() => null);
        trendsText = formatTrendsForPrompt(trendData);
      }
      const webSearch = Boolean(input.webSearch && provider.supportsWebSearch);
      const ctx = { today: now().toISOString().slice(0, 10), trendsText, webSearch };
      const request = {
        system: assistant.system,
        text: assistant.buildPrompt(input, ctx),
        images: input.images,
        schema: assistant.schema(input),
        webSearch,
      };

      let reply = await provider.generate(request);
      let data = extractJson(reply.text);
      if (!data) {
        // One repair attempt: smaller open-source models occasionally wrap or break the JSON.
        reply = await provider.generate({ ...request, text: `${request.text}\n\nIMPORTANT: respond with ONE valid JSON object only. No prose, no markdown.` });
        data = extractJson(reply.text);
      }
      if (!data) throw new AppError(502, 'The AI returned an unreadable answer. Please try again.');

      res.json({
        assistant: assistant.id,
        result: assistant.postprocess(data, input),
        meta: {
          provider: provider.name,
          model: reply.model,
          webSearch,
          trendSources: trendData ? trendData.sources.filter((s) => s.ok && s.items.length).map((s) => s.name) : [],
        },
      });
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
