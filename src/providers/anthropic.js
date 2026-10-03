import Anthropic from '@anthropic-ai/sdk';
import { AppError } from '../errors.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function createAnthropicProvider({ apiKey, model = 'claude-opus-5-5', effort = 'high', client } = {}) {
  const anthropic = client ?? new Anthropic({ apiKey, maxRetries: 2 });
  let useFallbacks = true;

  async function run(params) {
    const body = useFallbacks ? { ...params, betas: [FALLBACK_BETA], fallbacks: 'default' } : params;
    try {
      return await anthropic.beta.messages.stream(body).finalMessage();
    } catch (err) {
      // If the account/endpoint doesn't accept server-side fallbacks, run without them.
      if (useFallbacks && err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
        useFallbacks = false;
        return anthropic.beta.messages.stream(params).finalMessage();
      }
      throw err;
    }
  }

  async function generate({ system, text, images = [], schema, webSearch = false }) {
    const content = [
      ...images.flatMap((img, i) => [
        { type: 'text', text: img.label ? `Image ${i + 1}: ${img.label}` : `Image ${i + 1}:` },
        { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } },
      ]),
      { type: 'text', text },
    ];
    const messages = [{ role: 'user', content }];
    const output_config = { effort };
    const params = { model, max_tokens: 32000, system, messages, thinking: { type: 'adaptive' }, output_config };
    if (webSearch) {
      params.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }];
    } else if (schema) {
      output_config.format = { type: 'json_schema', schema };
    }

    try {
      let msg;
      // Server tools can pause a long turn; resume it a few times.
      for (let i = 0; i < 4; i++) {
        msg = await run(params);
        if (msg.stop_reason !== 'pause_turn') break;
        messages.push({ role: 'assistant', content: msg.content });
      }
      if (msg.stop_reason === 'refusal') {
        throw new AppError(422, 'The AI declined this request. Try rephrasing your instructions or using different material.');
      }
      if (msg.stop_reason === 'max_tokens') {
        throw new AppError(502, 'The answer was too long and got cut off. Select fewer platforms/ratios and try again.');
      }
      const out = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      return { text: out, model: msg.model };
    } catch (err) {
      throw mapError(err);
    }
  }

  return { name: 'anthropic', model, supportsWebSearch: true, supportsVision: true, generate };
}

function mapError(err) {
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AppError(401, 'Claude API key is invalid. Check ANTHROPIC_API_KEY.');
  if (err instanceof Anthropic.PermissionDeniedError) return new AppError(403, 'This Claude API key cannot use the selected model.');
  if (err instanceof Anthropic.NotFoundError) return new AppError(400, 'Claude model not found. Check ANTHROPIC_MODEL.');
  if (err instanceof Anthropic.RateLimitError) return new AppError(429, 'Claude rate limit reached. Wait a minute and try again.');
  if (err instanceof Anthropic.BadRequestError) return new AppError(400, `Claude rejected the request: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new AppError(502, 'Could not reach the Claude API. Check your network.');
  if (err instanceof Anthropic.APIError) return new AppError(502, `Claude API error: ${err.message}`);
  return err;
}
