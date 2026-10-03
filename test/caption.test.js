import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizePlatform } from '../src/assistants/caption.js';
import { charLength } from '../src/util.js';

test('X post (caption + hashtags) never exceeds 280 chars', () => {
  const p = finalizePlatform('x', { caption: 'word '.repeat(100), hashtags: ['#one', '#two', '#three', '#four'] });
  assert.equal(p.hashtags.length, 2);
  assert.ok(p.charCount <= 280, `got ${p.charCount}`);
  assert.equal(p.charCount, charLength(p.fullPost));
  assert.ok(p.fullPost.endsWith('#one #two'));
  assert.ok(p.warnings.length >= 2);
});

test('Threads gets exactly one topic tag', () => {
  const p = finalizePlatform('threads', { caption: 'hi', hashtags: ['#a', '#b'] });
  assert.deepEqual(p.hashtags, ['#a']);
});

test('YouTube title ≤100 and tags ≤500 chars', () => {
  const p = finalizePlatform('youtube', {
    title: 'T'.repeat(150),
    caption: 'desc',
    hashtags: [],
    keywords: Array.from({ length: 60 }, (_, i) => `keyword phrase ${i}`),
  });
  assert.ok(charLength(p.title) <= 100);
  assert.ok(p.keywords.join(',').length <= 500);
  assert.equal(p.fullPost, 'desc');
});

test('missing fields do not crash', () => {
  const p = finalizePlatform('instagram', {});
  assert.equal(p.caption, '');
  assert.deepEqual(p.hashtags, []);
  assert.match(p.warnings.join(' '), /no copy/);
});
