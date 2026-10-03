import { createApp } from './src/app.js';
import { createProviderFromEnv } from './src/providers/index.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on real environment variables (e.g. on Render/Railway).
}

const provider = createProviderFromEnv();
const app = createApp({ provider, rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN) || 20 });
const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`Content AI Studio running at http://localhost:${port}`);
  console.log(provider ? `AI provider: ${provider.name} (${provider.model})` : 'WARNING: no AI provider configured. Copy .env.example to .env and add a key.');
});
