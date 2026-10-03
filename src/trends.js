// Live trend signals from free, public sources. Every source is optional:
// one failing (rate limit, block, outage) never breaks a request.
const UA = 'ContentAI-Assistant/1.0 (+https://github.com/kumorize/content-ai-assistant-)';
const TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 8000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
export function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

export function parseGoogleTrendsRss(xml) {
  const items = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = item.match(/<title>([\s\S]*?)<\/title>/);
    if (!title) continue;
    const traffic = item.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/);
    const news = [...item.matchAll(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/g)].map((m) => decodeXml(m[1]));
    items.push({ term: decodeXml(title[1]), traffic: traffic ? decodeXml(traffic[1]) : '', context: news.slice(0, 2) });
  }
  return items;
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function googleTrends(geo, fetchImpl) {
  const res = await fetchImpl(`https://trends.google.com/trending/rss?geo=${geo}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseGoogleTrendsRss(await res.text()).slice(0, 20);
}

const WIKI_SKIP = /^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:|Talk:|User:|Template:|Category:|-$)/;
export function ymd(date) {
  const d = date.toISOString().slice(0, 10).split('-');
  return d.join('/');
}

async function wikipedia(fetchImpl, now) {
  // Yesterday's data is usually published by mid-morning UTC; fall back one more day.
  for (const daysBack of [1, 2]) {
    const day = new Date(now.getTime() - daysBack * 86400000);
    try {
      const data = await getJson(
        `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${ymd(day)}`,
        fetchImpl,
      );
      const articles = data?.items?.[0]?.articles ?? [];
      return articles
        .filter((a) => !WIKI_SKIP.test(a.article))
        .slice(0, 20)
        .map((a) => ({ term: a.article.replace(/_/g, ' '), traffic: `${a.views.toLocaleString('en-US')} views` }));
    } catch (err) {
      if (daysBack === 2) throw err;
    }
  }
  return [];
}

async function reddit(fetchImpl) {
  const data = await getJson('https://www.reddit.com/r/popular/hot.json?limit=25&raw_json=1', fetchImpl);
  return (data?.data?.children ?? [])
    .map((c) => c.data)
    .filter((p) => p && !p.over_18 && !p.stickied)
    .slice(0, 15)
    .map((p) => ({ term: p.title, traffic: `r/${p.subreddit} · ${p.ups} upvotes` }));
}

async function youtube(apiKey, geo, fetchImpl) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&maxResults=20&regionCode=${geo}&key=${encodeURIComponent(apiKey)}`;
  const data = await getJson(url, fetchImpl);
  return (data?.items ?? []).map((v) => ({
    term: v.snippet?.title ?? '',
    traffic: v.statistics?.viewCount ? `${Number(v.statistics.viewCount).toLocaleString('en-US')} views` : '',
    context: (v.snippet?.tags ?? []).slice(0, 8),
  }));
}

export function createTrendsService({ fetchImpl = globalThis.fetch, youtubeApiKey = process.env.YOUTUBE_API_KEY, now = () => new Date() } = {}) {
  const cache = new Map();

  async function get(geo = 'US', { force = false } = {}) {
    const hit = cache.get(geo);
    if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.data;

    const jobs = {
      'Google Trends': googleTrends(geo, fetchImpl),
      'Wikipedia most viewed (yesterday)': wikipedia(fetchImpl, now()),
      'Reddit r/popular': reddit(fetchImpl),
    };
    if (youtubeApiKey) jobs['YouTube most popular'] = youtube(youtubeApiKey, geo, fetchImpl);

    const names = Object.keys(jobs);
    const settled = await Promise.allSettled(Object.values(jobs));
    const sources = names.map((name, i) =>
      settled[i].status === 'fulfilled'
        ? { name, ok: true, items: settled[i].value }
        : { name, ok: false, error: String(settled[i].reason?.message ?? settled[i].reason), items: [] },
    );
    const data = { geo, fetchedAt: new Date().toISOString(), sources };
    if (sources.some((s) => s.ok && s.items.length)) cache.set(geo, { at: Date.now(), data });
    return data;
  }

  return { get };
}

export function formatTrendsForPrompt(data, perSource = 15) {
  if (!data) return '';
  const blocks = data.sources
    .filter((s) => s.ok && s.items.length)
    .map((s) => {
      const lines = s.items.slice(0, perSource).map((it) => {
        const extra = [it.traffic, it.context?.length ? it.context.join(', ') : ''].filter(Boolean).join(' | ');
        return `- ${it.term}${extra ? ` (${extra})` : ''}`;
      });
      return `### ${s.name}\n${lines.join('\n')}`;
    });
  if (!blocks.length) return '';
  return `Live trend data for region ${data.geo}, fetched ${data.fetchedAt}:\n\n${blocks.join('\n\n')}`;
}
