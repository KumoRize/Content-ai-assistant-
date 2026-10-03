import { AppError } from '../errors.js';

// Works with any OpenAI-compatible /chat/completions endpoint: Groq, OpenRouter,
// Together, Fireworks, Ollama, LM Studio, vLLM... i.e. open-source models.
export function createOpenAICompatibleProvider({ baseUrl, apiKey, model, transcribeModel = 'whisper-large-v3-turbo', supportsVision = true, fetchImpl = globalThis.fetch, timeoutMs = 180000 }) {
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
    if (schema) userText += `\n\nReturn ONLY a JSON object matching this JSON Schema (no markdown, no commentary):\n${JSON.stringify(schema)}`;
    let content = userText;
    if (images.length && supportsVision) {
      content = [
        { type: 'text', text: userText },
        ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
      ];
    } else if (images.length) {
      content = `${userText}\n\n(Note: the user uploaded ${images.length} image(s) but this model cannot see images. Rely on the written context.)`;
    }

    const body = {
      model,
      temperature: 0.8,
      max_tokens: 8000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    let r = await call(body);
    if (!r.ok && jsonMode && r.status === 400) {
      // Some models/providers reject JSON mode (especially with images): retry without it.
      jsonMode = false;
      delete body.response_format;
      r = await call(body);
    }
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) throw new AppError(401, 'AI provider rejected the API key. Check OSS_API_KEY.');
      if (r.status === 429) throw new AppError(429, 'AI provider rate limit reached. Wait a minute and try again.');
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

  return { name: 'openai-compatible', label: 'Open-source', model, supportsWebSearch: false, supportsVision, generate, transcribe };
}
