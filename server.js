import { createApp } from './src/app.js';
import { createProvidersFromEnv } from './src/providers/index.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on real environment variables (e.g. on Render/Railway).
}

const { providers, preferred } = createProvidersFromEnv();
const app = createApp({ providers, preferred, rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN) || 20 });
const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`Content AI Studio running at http://localhost:${port}`);
  const active = Object.entries(providers).map(([k, p]) => `${k}: ${p.model}`);
  console.log(active.length ? `AI engines: ${active.join(', ')} (preferred: ${preferred})` : 'WARNING: no AI provider configured. Set ANTHROPIC_API_KEY and/or OSS_API_KEY.');
});
