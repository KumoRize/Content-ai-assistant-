import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrendsService, formatTrendsForPrompt, parseGoogleTrendsRss, decodeXml, ymd } from '../src/trends.js';

const RSS = `<?xml version="1.0"?><rss xmlns:ht="https://trends.google.com/trending/rss"><channel>
<item><title>Cricket World Cup</title><ht:approx_traffic>500K+</ht:approx_traffic><ht:news_item><ht:news_item_title>Final tonight &amp; more</ht:news_item_title></ht:news_item></item>
<item><title><![CDATA[Tom & Jerry]]></title><ht:approx_traffic>10K+</ht:approx_traffic></item>
</channel></rss>`;

test('parses Google Trends RSS', () => {
  const items = parseGoogleTrendsRss(RSS);
  assert.deepEqual(items[0], { term: 'Cricket World Cup', traffic: '500K+', context: ['Final tonight & more'] });
  assert.equal(items[1].term, 'Tom & Jerry');
  assert.equal(decodeXml('&#39;hi&#x21;'), "'hi!");
  assert.equal(ymd(new Date('2026-10-02T05:00:00Z')), '2026/10/02');
});

test('trend service tolerates failing sources and caches', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (url.includes('trends.google.com')) return new Response(RSS, { status: 200 });
    if (url.includes('wikimedia')) {
      return new Response(JSON.stringify({ items: [{ articles: [{ article: 'Main_Page', views: 9e6 }, { article: 'Taylor_Swift', views: 123456 }] }] }), { status: 200 });
    }
    return new Response('blocked', { status: 403 });
  };
  const svc = createTrendsService({ fetchImpl, youtubeApiKey: '', now: () => new Date('2026-10-03T12:00:00Z') });
  const data = await svc.get('US');
  const byName = Object.fromEntries(data.sources.map((s) => [s.name, s]));
  assert.equal(byName['Google Trends'].items.length, 2);
  assert.deepEqual(byName['Wikipedia most viewed (yesterday)'].items, [{ term: 'Taylor Swift', traffic: '123,456 views' }]);
  assert.equal(byName['Reddit r/popular'].ok, false);
  assert.equal(byName['YouTube most popular'], undefined);
  const before = calls;
  await svc.get('US');
  assert.equal(calls, before, 'second call served from cache');

  const text = formatTrendsForPrompt(data);
  assert.match(text, /Cricket World Cup \(500K\+ \| Final tonight & more\)/);
  assert.doesNotMatch(text, /Reddit/);
  assert.equal(formatTrendsForPrompt({ geo: 'US', sources: [{ ok: false, items: [] }] }), '');
  assert.equal(formatTrendsForPrompt(null), '');
});

test('trend service includes YouTube when a key is set', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('googleapis.com/youtube')) {
      assert.match(url, /regionCode=IN/);
      return new Response(JSON.stringify({ items: [{ snippet: { title: 'Song', tags: ['music', 'new'] }, statistics: { viewCount: '1000' } }] }), { status: 200 });
    }
    throw new Error('offline');
  };
  const data = await createTrendsService({ fetchImpl, youtubeApiKey: 'k' }).get('IN');
  const yt = data.sources.find((s) => s.name === 'YouTube most popular');
  assert.deepEqual(yt.items[0], { term: 'Song', traffic: '1,000 views', context: ['music', 'new'] });
});
