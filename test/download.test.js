import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createZip, crc32, collectSourceFiles, buildSourceZip } from '../src/zip.js';
import { startApp, mockProvider } from './helpers.js';

// Read entries back using the central directory, like an unzip tool does.
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    const lnameLen = buf.readUInt16LE(local + 26);
    const body = buf.subarray(local + 30 + lnameLen, local + 30 + lnameLen + csize);
    const data = method === 8 ? inflateRawSync(body) : body;
    assert.equal(crc32(data), crc, `crc for ${name}`);
    out[name] = data.toString();
    p += 46 + nameLen;
  }
  return out;
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('createZip round-trips stored and deflated files', () => {
  const zip = createZip([
    { name: 'a/small.txt', data: Buffer.from('hi') },
    { name: 'a/big.txt', data: Buffer.from('repeat '.repeat(500)) },
    { name: 'ünïcode.md', data: Buffer.from('ok') },
  ]);
  assert.deepEqual(readZip(zip), { 'a/small.txt': 'hi', 'a/big.txt': 'repeat '.repeat(500), 'ünïcode.md': 'ok' });
});

test('source zip never includes .env, .git or node_modules', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'zip-'));
  try {
    for (const d of ['src', 'public/icons', 'node_modules/x', '.git']) mkdirSync(path.join(root, d), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}');
    writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=secret');
    writeFileSync(path.join(root, '.env.example'), 'ANTHROPIC_API_KEY=');
    writeFileSync(path.join(root, 'src/app.js'), 'x');
    writeFileSync(path.join(root, 'src/.env.local'), 'SECRET=1');
    writeFileSync(path.join(root, 'public/icons/i.png'), 'png');
    writeFileSync(path.join(root, 'node_modules/x/index.js'), 'dep');
    writeFileSync(path.join(root, '.git/config'), 'git');
    assert.deepEqual(collectSourceFiles(root), ['package.json', '.env.example', 'src/app.js', 'public/icons/i.png']);
    const files = readZip(buildSourceZip(root));
    assert.deepEqual(Object.keys(files), ['content-ai-studio/package.json', 'content-ai-studio/.env.example', 'content-ai-studio/src/app.js', 'content-ai-studio/public/icons/i.png']);
    assert.ok(!JSON.stringify(files).includes('secret'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('download endpoint serves the real project, manifest and service worker', async () => {
  const app = await startApp({ provider: mockProvider({}) });
  try {
    const base = app.base;
    const res = await fetch(`${base}/download/source.zip`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition'), /content-ai-studio\.zip/);
    const files = readZip(Buffer.from(await res.arrayBuffer()));
    for (const f of ['package.json', 'server.js', 'src/app.js', 'public/index.html', 'public/manifest.webmanifest', 'README.md']) {
      assert.ok(files[`content-ai-studio/${f}`], `missing ${f}`);
    }
    assert.ok(!Object.keys(files).some((f) => /node_modules|\/\.env$|\.git\//.test(f)));
    const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
    assert.equal(manifest.display, 'standalone');
    assert.deepEqual(manifest.icons.map((i) => i.sizes), ['192x192', '512x512', '512x512']);
    assert.equal((await fetch(`${base}/sw.js`)).status, 200);
    assert.equal((await fetch(`${base}/icons/icon-512.png`)).status, 200);
  } finally {
    await app.close();
  }
});
