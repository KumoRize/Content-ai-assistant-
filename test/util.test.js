import { test } from 'node:test';
import assert from 'node:assert/strict';
import { images, normalizeHashtags, truncateWords, platforms, geo, intInRange, charLength } from '../src/util.js';
import { extractJson } from '../src/json.js';
import { computeMetrics, readMetrics } from '../src/metrics.js';
import { modelReady } from '../src/promptFormat.js';
import { AppError } from '../src/errors.js';
import { PNG } from './helpers.js';

test('normalizeHashtags cleans, dedupes, caps', () => {
  assert.deepEqual(normalizeHashtags(['#Food', 'food', ' street food ', '#ok!', '#123', '##Travel', ''], 10), ['#Food', '#street', '#ok', '#Travel']);
  assert.deepEqual(normalizeHashtags('#a #b,#c', 2), ['#a', '#b']);
  assert.deepEqual(normalizeHashtags(['#खाना', '#café']), ['#खाना', '#café']);
  assert.deepEqual(normalizeHashtags(null), []);
});

test('truncateWords respects limit and word boundaries', () => {
  const s = 'The quick brown fox jumps over the lazy dog';
  const out = truncateWords(s, 20);
  assert.ok(charLength(out) <= 20);
  assert.ok(out.endsWith('…'));
  assert.equal(truncateWords('short', 20), 'short');
  assert.equal(charLength(truncateWords('😀😀😀😀😀', 3)), 3);
});

test('images validation', () => {
  assert.deepEqual(images(undefined, 3), []);
  assert.equal(images([{ mediaType: 'image/png', data: PNG }], 3).length, 1);
  assert.throws(() => images([{ mediaType: 'image/png', data: PNG }, { mediaType: 'image/png', data: PNG }], 1), /up to 1/);
  assert.throws(() => images([{ mediaType: 'image/heic', data: PNG }], 3), /unsupported type/);
  assert.throws(() => images([{ mediaType: 'image/png', data: 'not base64!' }], 3), /base64/);
  assert.throws(() => images('x', 3), AppError);
  const huge = 'A'.repeat(Math.ceil((6 * 1024 * 1024) / 3) * 4);
  assert.throws(() => images([{ mediaType: 'image/jpeg', data: huge }], 3), /5 MB/);
});

test('platforms / geo / intInRange', () => {
  assert.equal(platforms(undefined).length, 6);
  assert.deepEqual(platforms(['x', 'x', 'tiktok']), ['x', 'tiktok']);
  assert.throws(() => platforms([]), /at least 1/);
  assert.throws(() => platforms(['myspace']), /Unknown/);
  assert.equal(geo('in'), 'IN');
  assert.throws(() => geo('USA'), /2-letter/);
  assert.equal(intInRange(undefined, 'n', 1, 5, 3), 3);
  assert.throws(() => intInRange(9, 'n', 1, 5, 3), /between 1 and 5/);
});

test('extractJson handles fences, prose and nested braces in strings', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":"b"}\n```'), { a: 'b' });
  assert.deepEqual(extractJson('I searched {briefly}. Result: {"caption":"use {curly} \\"quotes\\"","n":[1,2]} done'), { caption: 'use {curly} "quotes"', n: [1, 2] });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('[1,2]'), null);
  assert.equal(extractJson(undefined), null);
});

test('computeMetrics', () => {
  const m = readMetrics({ views: '1000', likes: 80, comments: 10, shares: 5, saves: 5, followers: 2000, avgWatchSeconds: 9, durationSeconds: 12, bogus: 5, likesNeg: -1 });
  const c = computeMetrics(m);
  assert.equal(c.interactions, 100);
  assert.equal(c.engagementRateByViews, 10);
  assert.equal(c.engagementRateByFollowers, 5);
  assert.equal(c.shareRate, 0.5);
  assert.equal(c.viewsPerFollower, 0.5);
  assert.equal(c.avgPercentWatched, 75);
  const empty = computeMetrics(readMetrics({ views: 0, likes: 'abc' }));
  assert.equal(empty.engagementRateByViews, null);
  assert.equal(empty.interactions, null);
  assert.equal(computeMetrics({ avgWatchSeconds: 30, durationSeconds: 10 }).avgPercentWatched, 100);
});

test('modelReady formats per image AI', () => {
  assert.equal(modelReady('a cat', 'blurry, text', '16:9', 'midjourney'), 'a cat --ar 16:9 --no blurry, text');
  assert.equal(modelReady('a cat --ar 1:1 --v 6', '', '9:16', 'midjourney'), 'a cat --ar 9:16');
  assert.match(modelReady('a cat', 'blurry', '1:1', 'sdxl'), /Negative prompt: blurry\nAspect ratio: 1:1/);
  assert.doesNotMatch(modelReady('a cat', 'blurry', '1:1', 'flux'), /blurry/);
  assert.equal(modelReady('a cat', 'dogs', '4:5', 'dalle'), 'a cat Aspect ratio 4:5. Avoid: dogs.');
});
