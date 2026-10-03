import { analyzeSamples, encodeWav16, mixToMono, stereoCorrelation } from './audio-features.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { config: null, health: null, audio: null, files: { caption: [], score: [], music: [], analyze: [], thumbnail: [], artcover: [] }, busy: false };
const FRAMES_PER_VIDEO = 6;
const MAX_EDGE = 1280;

// ---------- DOM helper (textContent only: model output is never parsed as HTML) ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false || c === '') continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

async function copy(textValue) {
  try {
    await navigator.clipboard.writeText(textValue);
    toast('Copied!');
  } catch {
    const ta = el('textarea', {}, textValue);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Copied!');
  }
}
const copyBtn = (value, label = 'Copy') => el('button', { class: 'copy', type: 'button', onclick: () => copy(value) }, label);

// ---------- storage (best effort) ----------
const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode */
    }
  },
};

// ---------- tabs ----------
function showTab(name) {
  $$('#tabs button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
  store.set('tab', name);
}
$$('#tabs button[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- chips ----------
function buildChips() {
  const { platforms, ratios, thumbnailStyles, coverStyles, imageModels } = state.config;
  const sources = {
    platforms: { items: Object.entries(platforms).map(([k, p]) => [k, p.label]), selected: Object.keys(platforms) },
    ratios: { items: Object.entries(ratios).map(([k, r]) => [k, `${k} · ${r.useCase.split(/[,/]/)[0]}`]), selected: ['16:9', '9:16', '1:1', '4:5'] },
    thumbnailStyles: { items: thumbnailStyles.map((s) => [s, s]), selected: [] },
    coverStyles: { items: coverStyles.map((s) => [s, s]), selected: [] },
  };
  $$('[data-chips]').forEach((box) => {
    const src = sources[box.dataset.chips];
    box.replaceChildren(
      ...src.items.map(([value, label]) =>
        el('button', { type: 'button', class: `chip${src.selected.includes(value) ? ' on' : ''}`, 'data-value': value, onclick: (e) => e.currentTarget.classList.toggle('on') }, label),
      ),
    );
  });
  $$('[data-platform-select]').forEach((s) => s.replaceChildren(...Object.entries(platforms).map(([k, p]) => el('option', { value: k }, p.label))));
  $$('[data-models]').forEach((s) => s.replaceChildren(...Object.entries(imageModels).map(([k, label]) => el('option', { value: k }, label))));
}
const chipValues = (panel, name) => $$(`[data-chips="${name}"] .chip.on`, panel).map((c) => c.dataset.value);

// ---------- presets ----------
$$('.presets').forEach((box) => {
  box.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    const ta = $(`[name="${box.dataset.target}"]`, box.closest('.panel'));
    const current = ta.value.trim();
    ta.value = (current ? `${current}${/[.!?]$/.test(current) ? '' : '.'} ` : '') + e.target.textContent;
  });
});

// ---------- media handling ----------
function canvasToImage(source, width, height, label) {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { mediaType: 'image/jpeg', data: dataUrl.split(',')[1], preview: dataUrl, label };
}

async function imageFileToPayload(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`"${file.name}" can't be read by your browser (HEIC? convert to JPG/PNG first).`);
  }
  const img = canvasToImage(bitmap, bitmap.width, bitmap.height, `photo "${file.name}"`);
  bitmap.close?.();
  return img;
}

function waitFor(target, event, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    target.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
    target.addEventListener('error', () => { clearTimeout(timer); reject(new Error('error')); }, { once: true });
  });
}

async function videoFileToFrames(file, count) {
  const url = URL.createObjectURL(file);
  const video = el('video', { muted: '', playsinline: '', preload: 'auto' });
  video.muted = true;
  video.src = url;
  try {
    await waitFor(video, 'loadeddata');
    let duration = video.duration;
    if (!Number.isFinite(duration)) {
      // Some recorded WebM files report Infinity until you seek far ahead.
      video.currentTime = 1e7;
      await waitFor(video, 'seeked').catch(() => {});
      duration = video.duration;
    }
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('bad duration');
    const frames = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min(duration - 0.05, (duration * (i + 0.5)) / count);
      video.currentTime = Math.max(0, t);
      await waitFor(video, 'seeked');
      frames.push(canvasToImage(video, video.videoWidth, video.videoHeight, `frame at ${t.toFixed(1)}s of ${duration.toFixed(1)}s video "${file.name}"`));
    }
    return { frames, duration };
  } catch {
    throw new Error(`Your browser can't decode "${file.name}". Try Chrome, Edge or Safari, re-export it as MP4 (H.264), or upload screenshots instead.`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function addFiles(assistant, fileList) {
  const max = state.config.maxImages[assistant];
  const list = state.files[assistant];
  for (const file of fileList) {
    const remaining = max - list.length;
    if (remaining <= 0) {
      toast(`Limit reached: ${max} images for this assistant.`, true);
      break;
    }
    try {
      if (file.type.startsWith('video/')) {
        if (assistant === 'artcover') throw new Error('Cover Art AI takes reference images only.');
        toast(`Extracting frames from ${file.name}…`);
        const { frames } = await videoFileToFrames(file, Math.min(FRAMES_PER_VIDEO, remaining));
        list.push(...frames);
        toast(`Added ${frames.length} frames from ${file.name}.`);
      } else if (file.type.startsWith('image/')) {
        list.push(await imageFileToPayload(file));
      } else {
        throw new Error(`"${file.name}" is not an image or video.`);
      }
    } catch (err) {
      toast(err.message, true);
    }
  }
  renderPreviews(assistant);
}

function renderPreviews(assistant) {
  const box = $(`[data-previews="${assistant}"]`);
  const max = state.config.maxImages[assistant];
  const list = state.files[assistant];
  box.replaceChildren(
    ...list.map((img, i) =>
      el('figure', {},
        el('img', { src: img.preview, alt: img.label }),
        el('button', { type: 'button', title: 'Remove', onclick: () => { list.splice(i, 1); renderPreviews(assistant); } }, '×'),
      ),
    ),
    list.length ? el('span', { class: 'muted' }, `${list.length}/${max}`) : '',
  );
}

$$('.dropzone[data-for]').forEach((zone) => {
  const input = $('input', zone);
  const assistant = zone.dataset.for;
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && input.click());
  input.addEventListener('change', () => { addFiles(assistant, [...input.files]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); addFiles(assistant, [...e.dataTransfer.files]); });
});

// ---------- profile ----------
const PROFILE_FIELDS = ['niche', 'audience', 'tone', 'language', 'brandWords', 'avoid'];
function loadProfile() {
  const p = store.get('profile', {});
  PROFILE_FIELDS.forEach((f) => ($(`#profileForm [name="${f}"]`).value = p[f] ?? ''));
}
function getProfile() {
  return Object.fromEntries(PROFILE_FIELDS.map((f) => [f, $(`#profileForm [name="${f}"]`).value.trim()]));
}
$('#saveProfile').addEventListener('click', () => {
  store.set('profile', getProfile());
  $('#profileSaved').textContent = 'Saved ✓';
  setTimeout(() => ($('#profileSaved').textContent = ''), 2000);
});

// ---------- request builders ----------
const val = (panel, name) => $(`[name="${name}"]`, panel)?.value.trim() ?? '';
const checked = (panel, name) => Boolean($(`[name="${name}"]`, panel)?.checked);
const payloadImages = (assistant) => state.files[assistant].map(({ mediaType, data, label }) => ({ mediaType, data, label }));

const builders = {
  caption: (p) => ({
    images: payloadImages('caption'),
    mediaKind: val(p, 'mediaKind'),
    context: val(p, 'context'),
    instructions: val(p, 'instructions'),
    platforms: chipValues(p, 'platforms'),
    useLiveTrends: checked(p, 'useLiveTrends'),
    webSearch: checked(p, 'webSearch'),
  }),
  score: (p) => ({
    images: payloadImages('score'),
    mediaKind: val(p, 'mediaKind'),
    context: val(p, 'context'),
    instructions: val(p, 'instructions'),
    platforms: chipValues(p, 'platforms'),
    useLiveTrends: checked(p, 'useLiveTrends'),
    webSearch: checked(p, 'webSearch'),
  }),
  music: (p) => ({
    images: payloadImages('music'),
    features: state.audio?.features ?? null,
    track: {
      title: val(p, 't_title'),
      artist: val(p, 't_artist'),
      genre: val(p, 't_genre'),
      mood: val(p, 't_mood'),
      language: val(p, 't_language'),
      soundsLike: val(p, 't_soundsLike'),
      releaseDate: val(p, 't_releaseDate'),
    },
    description: val(p, 'description'),
    lyrics: val(p, 'lyrics'),
    instructions: val(p, 'instructions'),
    useLiveTrends: checked(p, 'useLiveTrends'),
    webSearch: checked(p, 'webSearch'),
  }),
  analyze: (p) => ({
    images: payloadImages('analyze'),
    context: val(p, 'context'),
    instructions: val(p, 'instructions'),
    platform: val(p, 'platform'),
    metrics: Object.fromEntries($$('[name^="m_"]', p).filter((i) => i.value !== '').map((i) => [i.name.slice(2), Number(i.value)])),
    useLiveTrends: checked(p, 'useLiveTrends'),
    webSearch: checked(p, 'webSearch'),
  }),
  ideas: (p) => ({
    prompt: val(p, 'prompt'),
    count: Number(val(p, 'count')) || 8,
    platforms: chipValues(p, 'platforms'),
    useLiveTrends: checked(p, 'useLiveTrends'),
    webSearch: checked(p, 'webSearch'),
  }),
  thumbnail: (p) => ({
    images: payloadImages('thumbnail'),
    title: val(p, 'title'),
    textOverlay: val(p, 'textOverlay'),
    context: val(p, 'context'),
    targetModel: val(p, 'targetModel'),
    ratios: chipValues(p, 'ratios'),
    styles: chipValues(p, 'thumbnailStyles'),
    instructions: val(p, 'instructions'),
  }),
  artcover: (p) => ({
    images: payloadImages('artcover'),
    track: { title: val(p, 't_title'), artist: val(p, 't_artist'), genre: val(p, 't_genre'), mood: val(p, 't_mood'), themes: val(p, 't_themes') },
    targetModel: val(p, 'targetModel'),
    includeText: checked(p, 'includeText'),
    styles: chipValues(p, 'coverStyles'),
    instructions: val(p, 'instructions'),
  }),
};

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `Server error (${res.status}).` }));
  return { ok: res.ok, status: res.status, data };
}

// ---------- free browser AI (Puter.js: no API key, each user signs in to a free Puter account) ----------
const puterReady = () => Boolean(window.puter?.ai?.chat);
const PUTER_MAX_IMAGES = 5;

function spread(list, max) {
  if (list.length <= max) return list;
  return Array.from({ length: max }, (_, i) => list[Math.round((i * (list.length - 1)) / (max - 1))]);
}

function replyText(r) {
  if (typeof r === 'string') return r;
  const c = r?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('');
  if (typeof r?.text === 'string') return r.text;
  return typeof r?.toString === 'function' ? String(r) : '';
}

async function puterChat(messages) {
  const model = state.config.puterModel;
  try {
    const r = await window.puter.ai.chat(messages, model ? { model } : {});
    return { text: replyText(r), model: model || 'Puter default' };
  } catch (err) {
    if (!model) throw err;
    // The configured model may be unavailable: retry with Puter's default.
    const r = await window.puter.ai.chat(messages, {});
    return { text: replyText(r), model: 'Puter default' };
  }
}

class PuterError extends Error {
  constructor(message, token) {
    super(message);
    this.token = token;
  }
}

async function runPuter(assistant, body) {
  const prep = await postJson(`/api/assist/${assistant}/prepare`, body);
  if (!prep.ok) throw new Error(prep.data.error);
  const { token, system, prompt } = prep.data;
  const imgs = spread(state.files[assistant] ?? [], PUTER_MAX_IMAGES);
  const userContent = imgs.length
    ? [{ type: 'text', text: imgs.length < (state.files[assistant] ?? []).length ? `${prompt}\n\n(${imgs.length} of the uploaded images are attached, spread evenly.)` : prompt }, ...imgs.map((i) => ({ type: 'image_url', image_url: { url: i.preview } }))]
    : prompt;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: userContent }];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await puterChat(attempt ? [...messages, { role: 'user', content: 'Respond again with ONE valid JSON object only. No prose, no markdown.' }] : messages);
      const fin = await postJson(`/api/assist/${assistant}/finish`, { token, text: reply.text, model: reply.model });
      if (fin.ok) return fin.data;
      if (fin.status !== 422) throw new Error(fin.data.error);
    }
    throw new Error('The free AI returned an unreadable answer.');
  } catch (err) {
    const msg = err?.message || err?.error?.message || (typeof err === 'string' ? err : 'The free AI is unavailable right now.');
    throw new PuterError(msg, token);
  }
}

function enginePlan(assistant) {
  const choice = $('#engine').value;
  const serverAI = Object.keys(state.health.engines ?? {}).length > 0;
  const basicOK = (state.health.basic ?? []).includes(assistant);
  if (choice === 'basic') {
    if (!basicOK) throw new Error("Basic mode can't rate images or videos because it can't see them. Pick the free AI in the engine menu.");
    return ['server', 'basic'];
  }
  if (choice === 'puter') return ['puter'];
  if (choice !== 'auto') return ['server', choice];
  if (serverAI) return ['server', 'auto'];
  if (puterReady()) return basicOK ? ['puter', 'basic'] : ['puter'];
  if (basicOK) return ['server', 'basic'];
  throw new Error('The free AI could not load (network or ad blocker). Disable blockers for this site and reload.');
}

async function run(assistant, button) {
  if (state.busy) return;
  const panel = $(`#panel-${assistant}`);
  const out = $(`#result-${assistant}`);
  let plan;
  try {
    plan = enginePlan(assistant);
  } catch (err) {
    out.replaceChildren(el('div', { class: 'error-box' }, err.message));
    return;
  }
  const body = { ...builders[assistant](panel), profile: getProfile(), geo: $('#geo').value };
  state.busy = true;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Working… (can take up to a minute)';
  out.replaceChildren(el('div', { class: 'loading' }, el('span', { class: 'spinner' }), 'Analyzing your material and the latest trends…'));
  try {
    let data;
    if (plan[0] === 'puter') {
      if (!puterReady()) throw new Error('The free AI could not load (network or ad blocker). Choose Basic mode or reload.');
      try {
        // Sign-in opens a popup, so it must start right here in the click handler.
        if (window.puter.auth && !window.puter.auth.isSignedIn()) {
          try {
            await window.puter.auth.signIn();
          } catch (e) {
            throw new PuterError(`sign-in was not completed${e?.message ? ` (${e.message})` : ''}`, null);
          }
        }
        data = await runPuter(assistant, body);
      } catch (err) {
        // Validation errors from our own server are shown as-is; Puter problems fall back to Basic mode.
        if (plan[1] !== 'basic' || !(err instanceof PuterError)) throw err;
        // Free AI unavailable (cancelled sign-in, limit reached, outage): use the built-in generator.
        const fb = err.token
          ? await postJson(`/api/assist/${assistant}/finish`, { token: err.token, basic: true })
          : await postJson(`/api/assist/${assistant}`, { ...body, engine: 'basic' });
        if (!fb.ok) throw new Error(fb.data.error);
        data = fb.data;
        data.meta.puterError = err?.message ? String(err.message).slice(0, 160) : '';
      }
    } else {
      const r = await postJson(`/api/assist/${assistant}`, { ...body, engine: plan[1] });
      if (!r.ok) throw new Error(r.data.error || `Request failed (${r.status}).`);
      data = r.data;
    }
    out.replaceChildren(renderMeta(data.meta, data.result), renderers[assistant](data.result));
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    out.replaceChildren(el('div', { class: 'error-box' }, err?.message || String(err) || 'Network error. Is the server running?'));
  } finally {
    state.busy = false;
    button.disabled = false;
    button.textContent = label;
  }
}
$$('[data-run]').forEach((b) => b.addEventListener('click', () => run(b.dataset.run, b)));

// ---------- renderers ----------
const section = (title, ...children) => el('div', { class: 'card' }, el('h3', {}, title), ...children);
const list = (items) => (items?.length ? el('ul', {}, items.map((i) => el('li', {}, i))) : el('p', { class: 'muted' }, '-'));
const field = (label, value, { copyable = true, pre = false } = {}) =>
  value ? el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('span', {}, label), copyable ? copyBtn(value) : ''), el(pre ? 'pre' : 'p', {}, value)) : '';
const tags = (arr) => (arr?.length ? el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('span', {}, 'Hashtags'), copyBtn(arr.join(' '))), el('div', { class: 'tags' }, arr.map((t) => el('span', { class: 'tag' }, t)))) : '');
const swatches = (colors) => (colors?.length ? el('div', { class: 'swatches' }, colors.map((c) => el('span', { class: 'swatch', title: c, style: /^#[0-9a-f]{3,8}$/i.test(c) ? `background:${c}` : '' }, c))) : '');
const warn = (ws) => (ws?.length ? el('div', { class: 'warn' }, ws.join(' ')) : '');

function renderMeta(meta, result) {
  const bits = [`${meta.provider} · ${meta.model}`];
  const names = { puter: 'Free browser AI', basic: 'Basic mode' };
  if (meta.fellBackFrom?.length) bits.push(`(switched automatically: ${meta.fellBackFrom.map((e) => state.health.engines?.[e]?.label ?? names[e] ?? e).join(', ')} was unavailable${meta.puterError ? `: ${meta.puterError}` : ''})`);
  if (meta.trendSources?.length) bits.push(`trends: ${meta.trendSources.join(', ')}`);
  if (meta.webSearch) bits.push('web search on');
  const download = () => {
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `content-ai-${Date.now()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return el('div', {},
    el('div', { class: 'meta' }, el('span', {}, bits.join(' · ')), el('button', { class: 'copy', type: 'button', onclick: download }, 'Download JSON')),
    meta.note ? el('div', { class: 'warn' }, meta.note) : '');
}

const LABELS = { hook: 'Hook', visualQuality: 'Visual quality', originality: 'Originality', emotionalImpact: 'Emotional impact', clarity: 'Clarity', trendAlignment: 'Trend alignment', shareability: 'Shareability' };
const level = (n) => (n == null ? '' : n >= 75 ? 'high' : n >= 50 ? 'mid' : 'low');
const ring = (value, label, sub) =>
  el('div', { class: `ring ${level(value)}`, style: `--p:${value ?? 0}` }, el('div', { class: 'ring-inner' }, el('b', {}, value == null ? '-' : `${value}%`), el('span', {}, label), sub ? el('small', {}, sub) : ''));
const pctBar = (label, value, reason) =>
  el('div', { class: 'pct-row' },
    el('div', { class: 'score' }, el('span', {}, label), el('div', { class: `bar ${level(value)}` }, el('i', { style: `width:${value ?? 0}%` })), el('b', {}, value == null ? '-' : `${value}%`)),
    reason ? el('p', { class: 'muted reason' }, reason) : '');

const svgNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}
const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

function energyChart(curve, step, highlight) {
  const W = 600;
  const H = 120;
  const total = curve.length * step;
  const x = (sec) => (sec / total) * W;
  const pts = curve.map((v, i) => `${x(i * step + step / 2).toFixed(1)},${(H - 14 - (v / 100) * (H - 24)).toFixed(1)}`);
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'energy', role: 'img', 'aria-label': 'Energy over time' });
  if (highlight) chart.append(svg('rect', { x: x(highlight.start), y: 0, width: Math.max(2, x(highlight.end) - x(highlight.start)), height: H - 14, class: 'hl' }));
  chart.append(svg('polyline', { points: pts.join(' '), class: 'line' }));
  for (let t = 0; t <= total; t += total > 240 ? 60 : 30) chart.append(svg('text', { x: Math.min(W - 18, x(t)), y: H - 2, class: 'axis' }, fmt(t)));
  return chart;
}

function momentumChart(values, peakWeek, releaseDate) {
  const start = releaseDate ? new Date(`${releaseDate}T00:00:00`) : null;
  return el('div', { class: 'momentum' }, values.map((v, i) => {
    const label = start ? new Date(start.getTime() + i * 7 * 86400000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : `W${i + 1}`;
    return el('div', { class: `mcol${i + 1 === peakWeek ? ' peak' : ''}`, title: `Week ${i + 1}: ${v}%` },
      el('span', { class: 'mval' }, v),
      el('div', { class: 'mbar' }, el('i', { style: `height:${v}%` })),
      el('span', { class: 'mlab' }, label));
  }));
}

const MUSIC_LABELS = { catchiness: 'Catchiness / hook', production: 'Production', mixQuality: 'Mix & master', originality: 'Originality', lyrics: 'Lyrics', replayValue: 'Replay value', viralSnippet: 'Viral clip potential', genreTrendFit: 'Genre trend fit' };

const renderers = {
  music(r) {
    const tl = r.timeline;
    return el('div', {},
      el('div', { class: 'card rings' },
        ring(r.overall, 'Overall', `Grade ${r.grade}`),
        ring(r.trendingPotential, 'Trending potential'),
        ring(r.strength, 'Strength'),
      ),
      el('div', { class: `confidence ${r.confidence}` }, `Confidence: ${r.confidence}. `, r.confidenceNote),
      r.verdict ? section('Verdict', el('p', {}, r.verdict)) : '',
      r.measured ? section('Peak moment',
        r.peakMoment ? el('p', {}, el('b', { class: 'peak-time' }, r.peakMoment.label), ' ', r.peakMoment.why) : el('p', { class: 'muted' }, 'No peak moment returned.'),
        energyChart(r.measured.energyCurve, r.measured.curveStepSec, r.peakMoment),
        el('p', { class: 'muted small' }, [`Length ${r.measured.duration}`, r.measured.bpm && `~${r.measured.bpm} BPM`, r.measured.dropAt && `drop at ${r.measured.dropAt}`, r.measured.loudness != null && `${r.measured.loudness} dBFS avg`].filter(Boolean).join(' · ')),
      ) : r.peakMoment ? section('Peak moment', el('p', {}, el('b', { class: 'peak-time' }, r.peakMoment.label), ' ', r.peakMoment.why)) : '',
      r.snippets.length ? section('Best clips to post', ...r.snippets.map((sn) => el('div', { class: 'improve low' }, el('span', { class: 'gain' }, sn.label), el('b', {}, sn.useFor), el('p', { class: 'muted' }, sn.why)))) : '',
      section('Trend timeline',
        el('div', { class: 'tl-stats' },
          el('div', {}, el('small', {}, 'Time to peak'), el('b', {}, tl.timeToPeak || '-')),
          el('div', {}, el('small', {}, 'Peak week'), el('b', {}, tl.peakWeek ? `Week ${tl.peakWeek}` : '-')),
          el('div', {}, el('small', {}, 'Trendable for'), el('b', {}, tl.trendLifespanWeeks != null ? `~${tl.trendLifespanWeeks} weeks` : '-')),
        ),
        tl.momentumByWeek.length ? momentumChart(tl.momentumByWeek, tl.peakWeek, tl.releaseDate) : '',
        el('p', { class: 'muted small' }, 'Predicted momentum per week after release. This is an estimate, not a guarantee.'),
        tl.bestReleaseTiming ? el('p', {}, el('b', {}, 'Best release timing: '), tl.bestReleaseTiming) : '',
        ...tl.phases.map((ph) => el('div', { class: 'phase' }, el('div', { class: 'phase-head' }, el('b', {}, ph.phase), el('span', { class: 'pill' }, ph.when)), ph.focus ? el('p', {}, ph.focus) : '', list(ph.actions))),
      ),
      section('Score breakdown', ...r.criteria.map((c) => pctBar(MUSIC_LABELS[c.key] ?? c.key, c.score, c.reason))),
      section('Trending potential by platform', ...r.platformPotential.map((p) => pctBar(p.label, p.potential, p.reason))),
      el('div', { class: 'grid2' },
        section('What makes it strong', ...r.strengths.map((s) => el('div', { class: `improve ${s.impact === 'high' ? 'low' : 'medium'}` }, el('span', { class: 'pill' }, `${s.impact} impact`), el('span', {}, s.point)))),
        section('What holds it back', list(r.weaknesses)),
      ),
      section('How to improve it',
        ...r.improvements.map((i) => el('div', { class: 'improve high' }, el('span', { class: 'gain' }, `+${i.estimatedGain}%`), i.criterion ? el('span', { class: 'pill' }, MUSIC_LABELS[i.criterion] ?? i.criterion) : '', el('b', {}, i.action), el('p', { class: 'muted' }, i.why))),
        el('p', { class: 'muted small' }, 'Gains are estimates per criterion, not guarantees.'),
      ),
      r.trendMatches.length ? section('Trends it can ride', el('div', { class: 'trend-insights' }, r.trendMatches.map((t) => el('div', {}, el('b', {}, t.trend), el('span', { class: 'pill' }, t.source), el('p', { class: 'muted' }, t.howToUse))))) : '',
    );
  },

  score(r) {
    return el('div', {},
      el('div', { class: 'card rings' },
        ring(r.overall, 'Overall', `Grade ${r.grade}`),
        ring(r.trendingPotential, 'Trending potential'),
        ring(r.strength, 'Strength'),
        r.projectedScore != null && r.overall != null && r.projectedScore > r.overall ? ring(r.projectedScore, 'After fixes', `+${r.projectedScore - r.overall}%`) : '',
      ),
      r.verdict ? section('Verdict', el('p', {}, r.verdict)) : '',
      section('Score breakdown', ...r.criteria.map((c) => pctBar(LABELS[c.key] ?? c.key, c.score, c.reason))),
      section('Trending potential by platform', ...r.platformPotential.map((p) => pctBar(p.label, p.potential, p.reason))),
      el('div', { class: 'grid2' },
        section('What makes it strong', ...r.strengths.map((s) => el('div', { class: `improve ${s.impact === 'high' ? 'low' : s.impact === 'medium' ? 'medium' : ''}` }, el('span', { class: 'pill' }, `${s.impact} impact`), el('span', {}, s.point)))),
        section('What holds it back', list(r.weaknesses)),
      ),
      section('How to improve it',
        ...r.improvements.map((i) =>
          el('div', { class: 'improve high' },
            el('span', { class: 'gain' }, `+${i.estimatedGain}%`),
            i.criterion ? el('span', { class: 'pill' }, LABELS[i.criterion] ?? i.criterion) : '',
            el('b', {}, i.action),
            el('p', { class: 'muted' }, i.why),
          ),
        ),
        el('p', { class: 'muted small' }, 'Gains are estimates per criterion, not guarantees.'),
      ),
      r.trendMatches.length ? section('Trends it can ride', el('div', { class: 'trend-insights' }, r.trendMatches.map((t) => el('div', {}, el('b', {}, t.trend), el('span', { class: 'pill' }, t.source), el('p', { class: 'muted' }, t.howToUse))))) : '',
    );
  },

  caption(r) {
    const ca = r.contentAnalysis;
    const platforms = Object.entries(r.platforms).map(([key, p]) =>
      el('div', { class: 'card platform' },
        el('div', { class: 'platform-head' }, el('h3', {}, state.config.platforms[key].label), el('span', { class: p.charCount > p.charLimit ? 'bad' : 'muted' }, `${p.charCount.toLocaleString()} / ${p.charLimit.toLocaleString()} chars`), copyBtn(key === 'youtube' && p.title ? `${p.title}\n\n${p.fullPost}` : p.fullPost, 'Copy post')),
        warn(p.warnings),
        field(key === 'youtube' ? 'Title' : 'On-screen headline', p.title),
        field(key === 'youtube' ? 'Description' : 'Caption', p.caption, { pre: true }),
        tags(p.hashtags),
        p.keywords.length ? field(key === 'youtube' ? 'Tags (keywords)' : 'Search keywords', p.keywords.join(', ')) : '',
        field('Hook', p.hook),
        field('Call to action', p.cta),
        field('Best time to post', p.bestTimeToPost, { copyable: false }),
        field('Format tips', p.formatTips, { copyable: false }),
      ),
    );
    return el('div', {},
      section('What the AI sees', el('p', {}, ca.summary), el('p', { class: 'muted' }, [ca.niche && `Niche: ${ca.niche}`, ca.mood && `Mood: ${ca.mood}`, ca.audience && `Audience: ${ca.audience}`].filter(Boolean).join(' · ')), ca.scrollStopper ? el('p', {}, el('b', {}, 'Scroll-stopper: '), ca.scrollStopper) : ''),
      r.trendInsights.length ? section('Trend angles used', el('div', { class: 'trend-insights' }, r.trendInsights.map((t) => el('div', {}, el('b', {}, t.trend), el('span', { class: 'pill' }, t.source), el('p', {}, t.relevance), el('p', { class: 'muted' }, t.howToUse))))) : '',
      el('div', { class: 'platform-grid' }, platforms),
    );
  },

  analyze(r) {
    const scoreRows = Object.entries(r.scores).map(([k, s]) =>
      el('div', { class: 'score' }, el('span', {}, k.replace(/([A-Z])/g, ' $1')), el('div', { class: 'bar' }, el('i', { style: `width:${s ?? 0}%` })), el('b', {}, s ?? '-')),
    );
    const cm = r.computedMetrics;
    const metricRows = Object.entries(cm).filter(([, v]) => v != null).map(([k, v]) => el('tr', {}, el('td', {}, k.replace(/([A-Z])/g, ' $1')), el('td', {}, /Rate|Percent/.test(k) ? `${v}%` : v.toLocaleString())));
    return el('div', {},
      el('div', { class: 'card hero' }, el('div', { class: 'big' }, r.viralPotential ?? '-', el('small', {}, '/100 viral potential')), el('p', {}, r.verdict)),
      section('Scores', ...scoreRows),
      metricRows.length ? section('Your numbers', el('table', {}, metricRows), el('p', {}, r.metricsInterpretation)) : section('Prediction', el('p', {}, r.metricsInterpretation)),
      el('div', { class: 'grid2' }, section('Strengths', list(r.strengths)), section('Weaknesses', list(r.weaknesses))),
      section('Improvement plan', ...r.improvements.map((i) => el('div', { class: `improve ${i.priority}` }, el('span', { class: 'pill' }, i.priority), el('b', {}, i.action), el('p', { class: 'muted' }, i.why)))),
      section('Better hooks', ...r.suggestedHooks.map((h) => field('Hook', h))),
      section('Improved caption', field('Caption', r.suggestedCaption, { pre: true }), tags(r.hashtags)),
      section('Repurpose plan', list(r.repurposePlan.map((x) => `${x.platform}: ${x.idea}`))),
      section('Next experiments', list(r.nextExperiments)),
    );
  },

  ideas(r) {
    return el('div', {},
      el('div', { class: 'idea-grid' }, r.ideas.map((i, n) =>
        el('div', { class: 'card idea' },
          el('div', { class: 'platform-head' }, el('h3', {}, `${n + 1}. ${i.title}`), copyBtn([i.title, `Hook: ${i.hook}`, i.concept, ...i.outline.map((s, k) => `${k + 1}. ${s}`), i.hashtags.join(' ')].join('\n'))),
          el('div', {}, el('span', { class: 'pill' }, state.config.platforms[i.platform]?.label ?? i.platform), el('span', { class: 'pill' }, i.format), i.effort ? el('span', { class: 'pill' }, `effort: ${i.effort}`) : ''),
          el('p', { class: 'hook' }, `“${i.hook}”`),
          el('p', {}, i.concept),
          el('ol', {}, i.outline.map((s) => el('li', {}, s))),
          el('p', {}, el('b', {}, 'Why it can trend: '), i.whyItWillTrend),
          i.trendTieIn ? el('p', { class: 'muted' }, `Trend tie-in: ${i.trendTieIn}`) : '',
          i.cta ? el('p', { class: 'muted' }, `CTA: ${i.cta}`) : '',
          tags(i.hashtags),
        ),
      )),
      r.postingStrategy ? section('2-week posting strategy', el('p', {}, r.postingStrategy)) : '',
    );
  },

  thumbnail(r) {
    const ca = r.contentAnalysis;
    return el('div', {},
      warn(r.warnings),
      section('Concept', el('p', {}, r.concept), el('p', { class: 'muted' }, [ca.subject, ca.emotion, ca.keyVisual].filter(Boolean).join(' · ')), swatches(ca.colorPalette)),
      ...r.variants.map((x) =>
        el('div', { class: 'card' },
          el('div', { class: 'platform-head' }, el('h3', {}, `${x.ratio}`), el('span', { class: 'muted' }, `${x.useCase} · ${x.size}`), copyBtn(x.modelReady, `Copy for ${r.targetModel}`)),
          field('Prompt', x.prompt, { pre: true }),
          field('Negative prompt', x.negativePrompt),
          field('Composition', x.composition, { copyable: false }),
          field('Text overlay', x.textOverlay),
          swatches(x.colorPalette),
        ),
      ),
      section('Style notes', list(r.styleNotes)),
      section('A/B test concepts', list(r.abTestIdeas)),
    );
  },

  artcover(r) {
    const ra = r.referenceAnalysis;
    return el('div', {},
      section('Reference DNA', list(ra.commonThemes), swatches(ra.palette), el('p', { class: 'muted' }, [ra.lighting, ra.composition, ra.mood].filter(Boolean).join(' · '))),
      section('Concept', el('p', {}, r.concept)),
      el('div', { class: 'card master' },
        el('div', { class: 'platform-head' }, el('h3', {}, 'Master cover prompt (1:1, 3000×3000)'), copyBtn(r.masterModelReady, `Copy for ${r.targetModel}`)),
        el('pre', {}, r.masterPrompt),
        field('Negative prompt', r.negativePrompt),
      ),
      section('Variations', ...r.variations.map((x) => el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('span', {}, `${x.name} · ${x.style}`), copyBtn(x.modelReady)), el('pre', {}, x.prompt)))),
      section('Other formats', ...r.formats.map((f) => el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('span', {}, `${f.ratio} · ${f.useCase}`), copyBtn(f.modelReady)), el('pre', {}, f.prompt)))),
      section('Typography', el('p', {}, [r.typography.titleFont, r.typography.placement, r.typography.treatment].filter(Boolean).join(' · '))),
      section('Before you upload', list(r.complianceNotes)),
    );
  },
};

// ---------- music: audio analysis + transcription ----------
const MAX_AUDIO_BYTES = 80 * 1024 * 1024;
const TRANSCRIBE_SECONDS = 360;

async function decodeAudio(file) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(await file.arrayBuffer());
  } finally {
    ctx.close?.();
  }
}

async function loadAudio(file) {
  const box = $('#audioSummary');
  if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(file.name)) return toast(`"${file.name}" is not an audio file.`, true);
  if (file.size > MAX_AUDIO_BYTES) return toast('Audio file is larger than 80 MB.', true);
  box.classList.remove('hidden');
  box.replaceChildren(el('div', { class: 'loading' }, el('span', { class: 'spinner' }), `Analyzing ${file.name}…`));
  await new Promise((r) => setTimeout(r, 30)); // let the spinner paint
  try {
    const buffer = await decodeAudio(file);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const features = analyzeSamples(mixToMono(channels), buffer.sampleRate);
    if (channels.length > 1) features.stereoCorrelation = stereoCorrelation(channels[0], channels[1]);
    state.audio = { file, buffer, features };
    if (!$('#panel-music [name=t_title]').value) $('#panel-music [name=t_title]').value = file.name.replace(/\.[^.]+$/, '');
    box.replaceChildren(
      el('div', { class: 'audio-head' },
        el('b', {}, file.name),
        el('span', { class: 'muted' }, [fmt(features.durationSec), features.bpm && `~${features.bpm} BPM`, features.dropAtSec != null && `drop at ${fmt(features.dropAtSec)}`, `${features.rmsDb} dBFS avg`].filter(Boolean).join(' · ')),
        el('button', { type: 'button', class: 'copy', onclick: () => { state.audio = null; box.classList.add('hidden'); } }, 'Remove'),
      ),
      energyChart(features.energyCurve, features.curveStepSec, features.bestSnippet15),
      el('p', { class: 'muted small' }, features.bestSnippet15 ? `Highlighted: highest-energy 15s (${fmt(features.bestSnippet15.start)}–${fmt(features.bestSnippet15.end)})` : ''),
    );
  } catch {
    state.audio = null;
    box.replaceChildren(el('div', { class: 'error-box' }, `Your browser couldn't decode "${file.name}". Try MP3 or WAV.`));
  }
}

const audioDrop = $('#audioDrop');
const audioInput = $('input', audioDrop);
audioDrop.addEventListener('click', () => audioInput.click());
audioDrop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && audioInput.click());
audioInput.addEventListener('change', () => { if (audioInput.files[0]) loadAudio(audioInput.files[0]); audioInput.value = ''; });
audioDrop.addEventListener('dragover', (e) => { e.preventDefault(); audioDrop.classList.add('over'); });
audioDrop.addEventListener('dragleave', () => audioDrop.classList.remove('over'));
audioDrop.addEventListener('drop', (e) => { e.preventDefault(); audioDrop.classList.remove('over'); if (e.dataTransfer.files[0]) loadAudio(e.dataTransfer.files[0]); });

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function to16kMonoWav(buffer, maxSeconds) {
  const seconds = Math.min(buffer.duration, maxSeconds);
  const offline = new OfflineAudioContext(1, Math.ceil(seconds * 16000), 16000);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start(0, 0, seconds);
  const rendered = await offline.startRendering();
  return encodeWav16(rendered.getChannelData(0), 16000);
}

$('#transcribeBtn').addEventListener('click', async () => {
  const btn = $('#transcribeBtn');
  const note = $('#transcribeNote');
  if (!state.audio) return toast('Upload the track first.', true);
  btn.disabled = true;
  note.textContent = 'Transcribing… (about 10-30 seconds)';
  try {
    const wav = await to16kMonoWav(state.audio.buffer, TRANSCRIBE_SECONDS);
    const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio: { data: toBase64(wav), mediaType: 'audio/wav' } }) });
    const data = await res.json().catch(() => ({ error: `Server error (${res.status}).` }));
    if (!res.ok) throw new Error(data.error);
    if (!data.text) throw new Error('No vocals detected (instrumental?).');
    $('#panel-music [name=lyrics]').value = data.text;
    note.textContent = `Done${state.audio.buffer.duration > TRANSCRIBE_SECONDS ? ' (first 6 minutes)' : ''}. Check and fix any mistakes.`;
  } catch (err) {
    note.textContent = '';
    toast(err.message || 'Transcription failed.', true);
  } finally {
    btn.disabled = !state.health?.transcription;
  }
});

// ---------- engine picker ----------
function setupEngines() {
  const sel = $('#engine');
  const engines = state.health.engines ?? {};
  const serverAI = Object.keys(engines).length > 0;
  sel.replaceChildren(
    el('option', { value: 'auto' }, serverAI ? 'Auto (with fallback)' : 'Auto: free AI, then Basic'),
    ...Object.entries(engines).map(([key, e]) => el('option', { value: key }, `${e.label} · ${e.model}`)),
    el('option', { value: 'puter', disabled: puterReady() ? null : '' }, `Free AI in your browser (Puter)${puterReady() ? '' : ' - could not load'}`),
    el('option', { value: 'basic' }, 'Basic mode (built-in, no AI)'),
  );
  const saved = store.get('engine', 'auto');
  sel.value = [...sel.options].some((o) => o.value === saved && !o.disabled) ? saved : 'auto';
  const sync = () => {
    const chosen = sel.value === 'auto' ? (serverAI ? state.health.preferred : 'puter') : sel.value;
    const canSearch = Boolean(engines[chosen]?.webSearch);
    $$('.check.ws').forEach((l) => {
      l.classList.toggle('hidden', !Object.values(engines).some((e) => e.webSearch));
      l.classList.toggle('disabled', !canSearch);
      $('input', l).disabled = !canSearch;
    });
    $('#engineHint').textContent =
      chosen === 'puter' ? 'Free AI: the first time, a window asks you to sign in to a free Puter account. No API key needed.'
        : chosen === 'basic' ? 'Basic mode: instant and offline-safe, built from your text and the trend data. Cannot rate images.'
          : '';
  };
  sel.addEventListener('change', () => { store.set('engine', sel.value); sync(); });
  sync();
  const tb = $('#transcribeBtn');
  tb.disabled = !state.health.transcription;
  if (!state.health.transcription) {
    tb.title = 'Lyrics transcription needs a free Groq key on the server. You can paste lyrics instead.';
    $('#transcribeNote').textContent = 'Transcription is off on this server. Paste your lyrics instead.';
  }
}

// ---------- trends ----------
async function loadTrends() {
  const box = $('#trendList');
  box.textContent = 'Loading…';
  try {
    const res = await fetch(`/api/trends?geo=${$('#geo').value}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const ok = data.sources.filter((s) => s.ok && s.items.length);
    if (!ok.length) {
      box.textContent = 'Trend sources are unreachable right now. The assistants will use evergreen strategy.';
      return;
    }
    box.replaceChildren(...ok.map((s) => el('details', { open: s === ok[0] ? '' : null }, el('summary', {}, s.name), el('ol', {}, s.items.slice(0, 10).map((i) => el('li', { title: i.traffic || '' }, i.term))))));
  } catch {
    box.textContent = 'Could not load trends.';
  }
}
$('#geo').addEventListener('change', () => { store.set('geo', $('#geo').value); loadTrends(); });

// ---------- boot ----------
async function boot() {
  try {
    const [config, health] = await Promise.all([fetch('/api/config').then((r) => r.json()), fetch('/api/health').then((r) => r.json())]);
    state.config = config;
    state.health = health;
  } catch {
    $('#status').textContent = 'Server unreachable';
    return;
  }
  buildChips();
  loadProfile();
  const status = $('#status');
  const labels = Object.values(state.health.engines ?? {}).map((e) => e.label);
  if (puterReady()) labels.push('Free AI');
  labels.push('Basic mode');
  status.textContent = `Ready · ${labels.join(' + ')}`;
  status.classList.add('ok');
  setupEngines();
  const geo = store.get('geo', 'US');
  if ([...$('#geo').options].some((o) => o.value === geo)) $('#geo').value = geo;
  showTab(store.get('tab', 'caption'));
  loadTrends();
}
boot();
