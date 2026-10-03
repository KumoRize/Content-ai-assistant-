import { createAnthropicProvider } from './anthropic.js';
import { createOpenAICompatibleProvider } from './openaiCompatible.js';

// Returns null when nothing is configured; the UI then shows setup instructions.
export function createProviderFromEnv(env = process.env) {
  const kind = (env.AI_PROVIDER || 'anthropic').toLowerCase();
  if (kind === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) return null;
    return createAnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
      effort: env.ANTHROPIC_EFFORT || 'high',
    });
  }
  if (kind === 'openai-compatible' || kind === 'oss') {
    if (!env.OSS_BASE_URL || !env.OSS_MODEL) return null;
    return createOpenAICompatibleProvider({
      baseUrl: env.OSS_BASE_URL,
      apiKey: env.OSS_API_KEY,
      model: env.OSS_MODEL,
      supportsVision: env.OSS_SUPPORTS_VISION !== 'false',
    });
  }
  throw new Error(`Unknown AI_PROVIDER "${env.AI_PROVIDER}". Use "anthropic" or "openai-compatible".`);
}
