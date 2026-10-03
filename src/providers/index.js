import { createAnthropicProvider } from './anthropic.js';
import { createOpenAICompatibleProvider } from './openaiCompatible.js';

// Builds every provider that has credentials. Both can be active at once:
// the UI lets you pick one, and "Auto" falls back to the other on failure.
export function createProvidersFromEnv(env = process.env) {
  const providers = {};
  if (env.ANTHROPIC_API_KEY) {
    providers.claude = createAnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
      effort: env.ANTHROPIC_EFFORT || 'high',
    });
  }
  const ossBase = env.OSS_BASE_URL || 'https://api.groq.com/openai/v1';
  // Hosted endpoints need a key; local servers (Ollama, LM Studio) don't.
  const isLocal = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|host\.docker\.internal|\[::1\])/i.test(ossBase);
  if (env.OSS_API_KEY || (env.OSS_BASE_URL && isLocal)) {
    providers.oss = createOpenAICompatibleProvider({
      baseUrl: ossBase,
      apiKey: env.OSS_API_KEY,
      model: env.OSS_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
      transcribeModel: env.OSS_TRANSCRIBE_MODEL || 'whisper-large-v3-turbo',
      supportsVision: env.OSS_SUPPORTS_VISION !== 'false',
      maxImages: Number(env.OSS_MAX_IMAGES) || 5,
    });
  }
  // The free open-source engine is the default; Claude is an optional paid extra.
  const pref = (env.AI_PROVIDER || 'openai-compatible').toLowerCase();
  if (!['anthropic', 'claude', 'openai-compatible', 'oss'].includes(pref)) {
    throw new Error(`Unknown AI_PROVIDER "${env.AI_PROVIDER}". Use "anthropic" or "openai-compatible".`);
  }
  const preferred = ['openai-compatible', 'oss'].includes(pref) ? 'oss' : 'claude';
  return { providers, preferred };
}
