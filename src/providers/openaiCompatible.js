import { AppError } from '../errors.js';

// Works with any OpenAI-compatible /chat/completions endpoint: Groq, OpenRouter,
// Together, Fireworks, Ollama, LM Studio, vLLM... i.e. open-source models.
// Pick up to `max` images spread evenly across the list (keeps first and last video frames).
export function spreadPick(list, max) {
  if (list.length <= max) return list;
  if (max <= 1) return list.slice(0, Math.max(0, max));
  const out = [];
  for (let i = 0; i < max; i++) out.push(list[Math.round((i * (list.length - 1)) / (max - 1))]);
  return out;
}

// Fit images into the provider's per-request limits (Groq free tier: 5 images, ~4 MB base64).
export function fitImages(images, maxImages, maxBase64Chars) {
  let picked = spreadPick(images, maxImages);
  while (picked.length > 1 && picked.reduce((n, img) => n + img.data.length, 0) > maxBase64Chars) {
    picked = spreadPick(images, picked.length - 1);
  }
  if (picked.length === 1 && picked[0].data.length > maxBase64Chars) picked = [];
  return picked;
}

export function createOpenAICompatibleProvider({ baseUrl, apiKey, model, transcribeModel = 'whisper-large-v3-turbo', supportsVision = true, maxImages = 5, maxImageChars = 3_600_000, maxTokens = 8000, fetchImpl = globalThis.fetch, timeoutMs = 180000 }) {
  const root = baseUrl.replace(/\/+$/, '');
  const url = `${root}/chat/completions`;
  let jsonMode = true;

  async function call(body) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new AppError(504, 'The AI model took too long to answer. Try again or use a faster model.');
      throw new AppError(502, `Could not reach the AI endpoint at ${baseUrl}.`);
    }
    const raw = await res.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const msg = data?.error?.message ?? data?.message ?? raw.slice(0, 300);
      return { ok: false, status: res.status, message: String(msg) };
    }
    return { ok: true, data };
  }

  async function generate({ system, text, images = [], schema }) {
    let userText = text;
    const sent = supportsVision ? fitImages(images, maxImages, maxImageChars) : [];
    if (sent.length && sent.length < images.length) {
      userText += `\n\n(Note: ${images.length} images were uploaded; the ${sent.length} attached are spread evenly across them due to model limits.)`;
    } else if (images.length && !sent.length) {
      userText += `\n\n(Note: the user uploaded ${images.length} image(s) but this model cannot see them. Rely on the written context.)`;
    }
    if (schema) userText += `\n\nReturn ONLY a JSON object matching this JSON Schema (no markdown, no commentary):\n${JSON.stringify(schema)}`;
    const content = sent.length
      ? [{ type: 'text', text: userText }, ...sent.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } }))]
      : userText;

    const body = {
      model,
      temperature: 0.8,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    let r = await call(body);
    if (!r.ok && jsonMode && r.status === 400 && /response_format|json/i.test(r.message)) {
      // Some models/providers reject JSON mode (especially with images): retry without it.
      jsonMode = false;
      delete body.response_format;
      r = await call(body);
    }
    // Free tiers cap tokens per minute and count max_tokens toward it ("Limit 6000, Requested 9500"):
    // shrink the answer budget to fit and retry once.
    const tooLarge = !r.ok && (r.status === 413 || r.status === 400) && r.message.match(/Limit\s*:?\s*(\d+).*?Requested\s*:?\s*(\d+)/i);
    if (tooLarge) {
      const limit = Number(tooLarge[1]);
      const requested = Number(tooLarge[2]);
      const smaller = body.max_tokens - (requested - limit) - 200;
      if (smaller >= 1500) {
        body.max_tokens = smaller;
        r = await call(body);
      } else {
        throw new AppError(413, 'This request is too big for the free AI tier. Use fewer images, platforms or ratios and try again.');
      }
    }
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) throw new AppError(401, 'AI provider rejected the API key. Check OSS_API_KEY.');
      if (r.status === 429) throw new AppError(429, 'Free AI rate limit reached. Wait a minute and try again.');
      if (r.status === 413) throw new AppError(413, 'This request is too big for the free AI tier. Use fewer images, platforms or ratios and try again.');
      if (r.status === 404) throw new AppError(400, `Model "${model}" not found at ${baseUrl}. Check OSS_MODEL.`);
      throw new AppError(502, `AI provider error (${r.status}): ${r.message}`);
    }
    const choice = r.data?.choices?.[0];
    const out = choice?.message?.content;
    if (typeof out !== 'string' || !out.trim()) throw new AppError(502, 'The AI returned an empty answer. Please try again.');
    if (choice.finish_reason === 'length') {
      throw new AppError(502, 'The answer was too long and got cut off. Select fewer platforms/ratios and try again.');
    }
    return { text: out, model: r.data.model ?? model };
  }

  // Speech-to-text (Whisper) via the OpenAI-compatible /audio/transcriptions endpoint.
  async function transcribe({ data, mediaType = 'audio/wav', filename = 'track.wav', language }) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(data, 'base64')], { type: mediaType }), filename);
    form.append('model', transcribeModel);
    form.append('response_format', 'json');
    if (language) form.append('language', language);
    let res;
    try {
      res = await fetchImpl(`${root}/audio/transcriptions`, {
        method: 'POST',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new AppError(504, 'Transcription took too long. Try a shorter section of the track.');
      throw new AppError(502, `Could not reach the transcription endpoint at ${baseUrl}.`);
    }
    const raw = await res.text();
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new AppError(401, 'Transcription provider rejected the API key. Check OSS_API_KEY.');
      if (res.status === 413) throw new AppError(413, 'Audio too large for transcription. Use a shorter section.');
      if (res.status === 429) throw new AppError(429, 'Transcription rate limit reached. Wait a minute and try again.');
      throw new AppError(502, `Transcription failed (${res.status}): ${String(body?.error?.message ?? raw).slice(0, 300)}`);
    }
    return { text: typeof body?.text === 'string' ? body.text.trim() : '', model: transcribeModel };
  }

  return { name: 'openai-compatible', label: 'Free open-source', model, supportsWebSearch: false, supportsVision, generate, transcribe };
}
