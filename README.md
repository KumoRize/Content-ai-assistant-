# Content AI Studio

A web app with five AI assistants for creators:

| Assistant | Input | Output |
|---|---|---|
| **Caption & Hashtag AI** | Reels, videos, posts, images + your instructions | Separate title, caption, hashtags, keywords, hook, CTA and posting tip for YouTube, Instagram, Threads, X, TikTok, Facebook, already trimmed to each platform's limits |
| **Content Analytics AI** | Your content + optional numbers (views, likes, saves, watch time…) | 0–100 scores, computed engagement rates, strengths/weaknesses, prioritized fix list, better hooks, repurpose plan |
| **Trend Idea AI** | One short prompt | Ranked ideas with hook, shot list, why it can trend, hashtags, 2-week plan |
| **Thumbnail Prompt AI** | Video/photos + title + style | Image-AI prompts for 16:9, 9:16, 1:1, 4:5, 3:4, 4:3, 2:3, 21:9, each re-composed for its shape and formatted for Midjourney, FLUX, SDXL, DALL·E, Ideogram, Leonardo or Firefly |
| **Cover Art Prompt AI** | Up to 5 reference pictures + track details | Master 1:1 cover prompt (3000×3000), 3 variations, Spotify Canvas (9:16) and visualizer (16:9) prompts, typography and distributor checks |

Every assistant has a **"Your instructions"** box. Write how you want the result, and it takes priority over the defaults. A **Brand Profile** (niche, audience, tone, language, words to use or avoid) is saved in your browser and sent with every request.

## Quick start

```bash
npm install
cp .env.example .env      # then put your key in .env
npm start                 # http://localhost:3000
npm test                  # 31 tests, no network or API key needed
```

Requires Node 20+.

## Choosing the AI

| `AI_PROVIDER` | What you need | Notes |
|---|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY` | Claude Opus 5.5 with vision, structured JSON output, and optional **live web search** for trending hashtags |
| `openai-compatible` | `OSS_BASE_URL`, `OSS_MODEL`, (`OSS_API_KEY`) | Any open-source model behind an OpenAI-style API: Groq, OpenRouter, Together, or **Ollama/LM Studio locally**. Use a vision model for image/video input |

## Where the trend data comes from

Free public sources, fetched live, cached for 30 minutes, and passed to the AI:
- Google Trends daily RSS (per country)
- Wikipedia most-viewed articles
- Reddit r/popular
- YouTube "most popular" titles + tags (optional: set `YOUTUBE_API_KEY`, a free YouTube Data API v3 key)
- With Claude: the **Live web search** checkbox lets the model search the web for current hashtags and formats in your niche

If a source is down or blocked, it is skipped and the request still works.

## Example

```bash
curl -s localhost:3000/api/assist/ideas -H 'Content-Type: application/json' -d '{
  "prompt": "budget cooking for university students",
  "platforms": ["tiktok", "youtube"],
  "count": 5,
  "geo": "GB",
  "profile": {"tone": "funny, fast", "language": "English"}
}'
```
Endpoints: `POST /api/assist/{caption|analyze|ideas|thumbnail|artcover}`, `GET /api/trends?geo=US`, `GET /api/health`.

## Deploy (make it live)

**Render:** push this repo, choose *New → Blueprint*, select the repo (it reads `render.yaml`), and paste your `ANTHROPIC_API_KEY`. Railway, Fly.io and any VPS also work: `npm ci && npm start`, with the env vars from `.env.example`.

## Assumptions & limits (read these)

- **Videos are analyzed visually**: the browser samples 6 evenly spaced frames per video. Audio and speech are not heard; paste a transcript or lyrics into the context field for those.
- Videos must be playable in your browser (MP4/H.264 works in Chrome, Edge and Safari; WebM in Chrome/Firefox). Convert HEIC photos to JPG first.
- **No tool can guarantee virality.** The assistants follow platform best practices and real trend signals. Results still depend on your content, timing and audience; use the A/B ideas to test.
- Platform limits used (as of late 2026): X 280 chars incl. hashtags (standard accounts), Threads 500 chars + 1 topic tag, Instagram 2,200 chars and a 5-hashtag cap, YouTube title 100 / tags 500 / max 15 hashtags, TikTok 4,000, Facebook 63,206. Platforms change these; edit `src/config.js` if one changes.
- "Best time to post" is a general starting point. Your own analytics are more accurate.
- The rate limit (default 20 AI requests/min per IP) is in-memory. Put the app behind auth before sharing it publicly, since every request spends your API credits.

## Project layout

```
server.js                 entry point (loads .env)
src/app.js                Express routes, validation → AI → JSON repair → post-processing
src/assistants/*.js       one file per assistant: prompt, JSON schema, output clean-up
src/providers/            Claude (official SDK) and OpenAI-compatible (open-source) backends
src/trends.js             live trend sources + cache
src/config.js             platform limits, aspect ratios, styles
public/                   the web UI (no build step)
test/                     node:test suite
```
