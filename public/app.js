const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { config: null, health: null, files: { caption: [], analyze: [], thumbnail: [], artcover: [] }, busy: false };
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

$$('.dropzone').forEach((zone) => {
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

async function run(assistant, button) {
  if (state.busy) return;
  const panel = $(`#panel-${assistant}`);
  const out = $(`#result-${assistant}`);
  const body = { ...builders[assistant](panel), profile: getProfile(), geo: $('#geo').value };
  state.busy = true;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Working… (can take up to a minute)';
  out.replaceChildren(el('div', { class: 'loading' }, el('span', { class: 'spinner' }), 'Analyzing your material and the latest trends…'));
  try {
    const res = await fetch(`/api/assist/${assistant}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({ error: `Server error (${res.status}).` }));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    out.replaceChildren(renderMeta(data.meta, data.result), renderers[assistant](data.result));
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    out.replaceChildren(el('div', { class: 'error-box' }, err.message || 'Network error. Is the server running?'));
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
  if (meta.trendSources?.length) bits.push(`trends: ${meta.trendSources.join(', ')}`);
  if (meta.webSearch) bits.push('web search on');
  const download = () => {
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `content-ai-${Date.now()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return el('div', { class: 'meta' }, el('span', {}, bits.join(' · ')), el('button', { class: 'copy', type: 'button', onclick: download }, 'Download JSON'));
}

const renderers = {
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
  if (state.health.configured) {
    status.textContent = `AI ready · ${state.health.model}`;
    status.classList.add('ok');
  } else {
    status.textContent = 'AI not configured';
    status.classList.add('bad');
    $('#setupBanner').classList.remove('hidden');
  }
  if (!state.health.webSearch) {
    $$('.check.ws').forEach((l) => { l.classList.add('disabled'); $('input', l).disabled = true; l.title = 'Live web search needs the Claude provider.'; });
  }
  const geo = store.get('geo', 'US');
  if ([...$('#geo').options].some((o) => o.value === geo)) $('#geo').value = geo;
  showTab(store.get('tab', 'caption'));
  loadTrends();
}
boot();
