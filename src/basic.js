// Built-in "Basic mode": a rule-based generator that needs no AI service at all.
// It only uses what it can actually measure or read (your text, platform rules,
// live trend data, audio measurements), so it never pretends to see images.
import { AppError } from './errors.js';
import { PLATFORMS, RATIOS } from './config.js';
import { MUSIC_PLATFORMS, mmss } from './assistants/music.js';

const STOP = new Set(
  'the and for are but not you your yours with this that from have has had was were will would can could should about into over under then than them they their there here what when where which while who whom why how all any each few more most other some such only own same very just also too out off our ours its i me my we us he she his her him a an of to in on at by as or if so do does did be been being is am get got make made like really video reel post content my new day one people person thing things way lot lots time times today tonight hour hours minute minutes took take takes taking went go going gone come came see saw watch watched look looked try tried trying want wanted need needed know knew think thought feel felt said say says let lets ever never always still even much many every first last next best good great nice big small little making doing getting using having being putting starting started finally actually literally basically gets makes uses'.split(' '),
);

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const pick = (list, seed, offset = 0) => list[(seed + offset) % list.length];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = (s) => s.replace(/\p{L}[\p{L}\p{M}']*/gu, (w) => cap(w.toLowerCase()));
const clean = (s) => s.replace(/\s+/g, ' ').trim();
const firstSentence = (s, max = 140) => {
  const m = clean(s).match(/^.*?[.!?](\s|$)/);
  const out = (m ? m[0] : clean(s)).trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
};

export function keywords(text, n = 8) {
  const counts = new Map();
  for (const w of (text.toLowerCase().match(/[\p{L}\p{M}\p{N}]{3,}/gu) ?? [])) {
    if (STOP.has(w) || /^\d+$/.test(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

export const tagify = (phrase) => {
  const body = phrase.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean).map(cap).join('');
  return body ? `#${body}` : '';
};

function trendHits(trendsData, words) {
  if (!trendsData) return [];
  const set = new Set(words);
  const hits = [];
  for (const s of trendsData.sources ?? []) {
    if (!s.ok) continue;
    for (const it of s.items) {
      const termWords = (it.term.toLowerCase().match(/[\p{L}\p{M}\p{N}]{3,}/gu) ?? []);
      if (termWords.some((w) => set.has(w))) hits.push({ trend: it.term, source: s.name });
    }
  }
  return hits.slice(0, 5);
}

const BASIC_NOTE = 'Made in Basic mode (no AI): built from your text, platform rules and trend data. Sign in to the free AI for tailored results.';

// ---------------- caption ----------------
const HOOKS = {
  video: ['Wait for the end of this one', 'Nobody talks about this', "I didn't expect this to work", 'Save this for later', 'This changed how I see {t}'],
  image: ['Swipe-stopping {t}', 'This is your sign to try {t}', 'Rate this {t} from 1 to 10', 'Small details, big difference'],
};
const PLATFORM_TAGS = { tiktok: ['#fyp'], instagram: ['#reels'], youtube: ['#shorts'], facebook: [], x: [], threads: [] };
const CTAS = {
  youtube: 'Subscribe for more',
  instagram: 'Save this and share it with someone who needs it',
  tiktok: 'Follow for part 2',
  x: 'Repost if you agree',
  threads: 'What would you add?',
  facebook: 'Tag someone who would love this',
};
const TIMES = {
  youtube: 'Common starting point: 2-4 hours before your audience\'s evening peak (e.g. 3-5 pm local). Check YouTube Studio > Audience for your real times.',
  instagram: 'Common starting point: weekdays 11 am-1 pm or 7-9 pm local. Check Insights > Most active times.',
  tiktok: 'Common starting point: 6-10 pm local. Check Analytics > Followers activity.',
  x: 'Common starting point: weekday mornings 8-11 am local.',
  threads: 'Common starting point: weekday mornings and lunchtime.',
  facebook: 'Common starting point: weekdays 9 am-1 pm local.',
};
const TIPS = {
  youtube: 'Put the main keyword in the first 60 characters of the title and the first line of the description.',
  instagram: 'Use a clear cover frame and put on-screen text in the first second; keep Reels under 30s for reach.',
  tiktok: 'Hook in the first 2 seconds, use a trending sound at low volume, add captions on screen.',
  x: 'Attach the video natively (not a link) and keep the post to one idea.',
  threads: 'Write like a conversation starter; reply to early comments quickly.',
  facebook: 'Upload natively as a Reel and add captions; people often watch muted.',
};

function youtubeTitle(topic, subject) {
  const s = titleCase(firstSentence(subject, 70).replace(/[.!?…]$/, ''));
  // Avoid "Biryani: Making Biryani For 100 People" style repetition.
  return s.toLowerCase().includes(topic.toLowerCase()) ? s : `${titleCase(topic)}: ${s}`;
}

function caption(input, ctx) {
  const text = [input.context, input.instructions, input.profile.niche, input.profile.brandWords].filter(Boolean).join(' ');
  const kw = keywords(text, 8);
  const topic = kw.slice(0, 2).join(' ') || input.profile.niche || 'this';
  const seed = hash(text || 'x');
  const isVideo = /reel|video|story/.test(input.mediaKind) || input.images.some((i) => /frame at/.test(i.label));
  const subject = input.context ? firstSentence(input.context) : `New ${input.mediaKind || 'post'}${input.profile.niche ? ` about ${input.profile.niche}` : ''}`;
  const hook = pick(HOOKS[isVideo ? 'video' : 'image'], seed).replace('{t}', kw[0] || input.profile.niche || 'this');
  const baseTags = [...kw.slice(0, 6).map(tagify), input.profile.niche ? tagify(input.profile.niche) : ''].filter(Boolean);
  const hits = trendHits(ctx.trendData, kw);
  const trendTags = hits.map((h) => tagify(h.trend)).filter((t) => t.length <= 30);
  const brand = input.profile.brandWords ? ` ${input.profile.brandWords.split(',')[0].trim()}.` : '';

  const platforms = {};
  for (const p of input.platforms) {
    const tags = [...trendTags.slice(0, 1), ...baseTags, ...PLATFORM_TAGS[p]];
    const kwPhrases = [...kw, ...kw.slice(0, -1).map((w, i) => `${w} ${kw[i + 1]}`)].slice(0, 12);
    const bodies = {
      youtube: `${subject}\n\nIn this ${isVideo ? 'video' : 'post'}: ${kw.slice(0, 4).join(', ') || topic}.${brand}\n\n${CTAS.youtube} ${input.profile.niche || topic} content.`,
      instagram: `${hook} 👇\n\n${subject}${brand}\n\nWhat do you think? Tell me in the comments.\n\n${CTAS.instagram}.`,
      tiktok: `${hook}. ${subject}${brand} ${CTAS.tiktok}.`,
      x: `${hook}. ${subject}`,
      threads: `${subject}${brand}\n\nHonest question: ${pick(['would you try this?', 'what would you do differently?', 'am I the only one?'], seed)}`,
      facebook: `${subject}${brand}\n\n${pick(['Have you ever tried this?', 'What do you think?', 'Would you do this?'], seed)} ${CTAS.facebook}.`,
    };
    platforms[p] = {
      title: p === 'youtube' ? youtubeTitle(topic, subject) : hook,
      caption: bodies[p],
      hashtags: tags,
      keywords: kwPhrases,
      hook,
      cta: CTAS[p],
      bestTimeToPost: TIMES[p],
      formatTips: TIPS[p],
    };
  }
  return {
    contentAnalysis: {
      summary: input.context ? subject : 'Basic mode cannot see images. Add a short description in "What\'s in it" for copy that matches your content.',
      subjects: kw.slice(0, 5),
      mood: input.profile.tone || '',
      niche: input.profile.niche || '',
      scrollStopper: '',
      audience: input.profile.audience || '',
    },
    trendInsights: hits.map((h) => ({ trend: h.trend, source: h.source, relevance: 'Shares keywords with your content.', howToUse: 'Mention it naturally in the caption or on-screen text if it genuinely fits.' })),
    platforms,
  };
}

// ---------------- ideas ----------------
const IDEA_TEMPLATES = [
  { format: 'POV', title: 'POV: you finally get {t} right', hook: 'POV: you stopped making this {t} mistake', why: 'POV puts the viewer in the story, which drives watch time and comments.' },
  { format: 'Mistakes list', title: '3 {t} mistakes everyone makes', hook: "You're probably making mistake #2 right now", why: 'Lists promise quick value and get saved for later.' },
  { format: 'Myth vs fact', title: '{T} myths that need to die', hook: 'Everything you know about {t} is wrong', why: 'Contrarian claims trigger comments and debate.' },
  { format: 'Before / after', title: '{T}: before vs after', hook: 'Watch the difference in 10 seconds', why: 'Transformations are rewatched and shared.' },
  { format: 'Budget vs luxury', title: '$5 vs $50 {t}', hook: 'Is expensive actually better?', why: 'Comparison formats create curiosity and strong opinions.' },
  { format: 'Tutorial in 30s', title: '{T} in 30 seconds', hook: 'The fastest way to {t}', why: 'Fast, useful tutorials get saved and shared.' },
  { format: 'Storytime', title: 'The time {t} went completely wrong', hook: 'This is the worst {t} story I have', why: 'Personal stories build connection and keep people watching to the end.' },
  { format: 'Tier list', title: 'Ranking every {t} option', hook: "You won't agree with my #1", why: 'Rankings invite people to argue in the comments.' },
  { format: 'Challenge', title: '7-day {t} challenge', hook: 'Day 1 of trying {t} every day', why: 'Series create return viewers who follow for the next part.' },
  { format: 'Reply to a comment', title: 'Answering your {t} questions', hook: 'Someone asked me this about {t}…', why: 'Replying to comments boosts community and repeat engagement.' },
  { format: 'Behind the scenes', title: 'What {t} really looks like', hook: 'Nobody shows this part of {t}', why: 'Authentic behind-the-scenes content builds trust.' },
  { format: 'Hot take', title: 'Unpopular opinion about {t}', hook: 'This might make some people angry', why: 'Bold opinions drive shares and duets/stitches.' },
  { format: 'Beginner guide', title: 'If I started {t} today, I would do this', hook: 'What I wish I knew on day one', why: 'Beginner advice has a huge search audience.' },
  { format: 'Duet / stitch', title: 'Reacting to viral {t} advice', hook: 'Is this viral {t} tip actually good?', why: 'Riding existing viral content borrows its audience.' },
  { format: 'Series part 1', title: '{T} from zero: part 1', hook: 'Part 1: let me show you how this starts', why: 'Part numbers make people follow for the next episode.' },
];

function ideas(input, ctx) {
  const kw = keywords(input.prompt, 6);
  const t = clean(input.prompt).replace(/[.!?]+$/, '').slice(0, 60) || 'this';
  const hits = trendHits(ctx.trendData, kw);
  const tags = [...kw.slice(0, 4).map(tagify), ...(input.profile.niche ? [tagify(input.profile.niche)] : [])];
  const seed = hash(input.prompt);
  const out = [];
  for (let i = 0; i < input.count; i++) {
    const tpl = IDEA_TEMPLATES[(seed + i) % IDEA_TEMPLATES.length];
    const fill = (s) => s.replaceAll('{t}', t.toLowerCase()).replaceAll('{T}', cap(t));
    out.push({
      title: fill(tpl.title),
      platform: input.platforms[i % input.platforms.length],
      format: tpl.format,
      hook: fill(tpl.hook),
      concept: `A ${tpl.format.toLowerCase()} video about ${t.toLowerCase()}. Open with the hook, deliver the payoff fast, end with a question.`,
      outline: ['0-2s: say the hook with text on screen', '2-10s: show the problem or setup', '10-25s: deliver the main value / reveal', 'Last 3s: ask a question or tease part 2'],
      whyItWillTrend: tpl.why,
      trendTieIn: hits[i % Math.max(1, hits.length)]?.trend ?? 'evergreen',
      hashtags: tags,
      effort: i % 3 === 0 ? 'low' : i % 3 === 1 ? 'medium' : 'low',
      cta: 'Comment your answer below',
    });
  }
  return { ideas: out, postingStrategy: 'Post the low-effort ideas first to test which format your audience likes, then double down on the winner with a part 2. Aim for 3-5 posts a week at a consistent time.' };
}

// ---------------- thumbnail ----------------
const STYLE_WORDS = {
  'MrBeast-style high energy': ['hyper-saturated colors, exaggerated excited expression, bold outlines, high contrast', ['#FFD400', '#FF2E2E', '#00A3FF']],
  'Minimal clean': ['minimal composition, lots of negative space, soft even lighting, clean background', ['#FFFFFF', '#111111', '#3B82F6']],
  Cinematic: ['cinematic lighting, shallow depth of field, anamorphic look, teal and orange grade', ['#0F3D4C', '#F29E4C', '#1B1B1B']],
  'Bold text-first': ['huge bold sans-serif text dominating the frame, simple background, thick stroke', ['#000000', '#FFE600', '#FFFFFF']],
  'Shocked face reaction': ['close-up of a shocked face, wide eyes, open mouth, dramatic rim light', ['#FF3B30', '#FFFFFF', '#1C1C1E']],
  'Before / after split': ['split-screen layout, left "before" and right "after", clear dividing line, arrow', ['#E5E7EB', '#22C55E', '#EF4444']],
  'Documentary / mysterious': ['moody low-key lighting, fog, muted colors, mysterious atmosphere', ['#1F2937', '#6B7280', '#D97706']],
  'Anime / illustrated': ['anime illustration style, cel shading, vibrant colors, expressive character', ['#FF6AD5', '#8C1EFF', '#00E5FF']],
  '3D render': ['glossy 3D render, studio lighting, octane render look, soft shadows', ['#7C3AED', '#06B6D4', '#F8FAFC']],
  'Retro / vintage': ['retro 80s aesthetic, film grain, faded colors, halftone texture', ['#F4A261', '#E76F51', '#264653']],
  'Luxury / premium': ['luxury aesthetic, black and gold, elegant lighting, premium materials', ['#0B0B0B', '#D4AF37', '#F5F5F5']],
  'Gaming neon': ['neon glow, cyberpunk lighting, dark background, electric accents', ['#00FFC6', '#FF00E5', '#0A0A12']],
};
const RATIO_LAYOUT = {
  '16:9': 'subject on the right third, face large, bold text on the left half, keep the bottom-right corner clear for the timestamp',
  '9:16': 'subject centered in the upper-middle, text in the top third, keep the bottom 20% and right edge clear of buttons and captions',
  '1:1': 'subject centered and filling 60% of the frame, short text across the top',
  '4:5': 'subject centered slightly low, text in the top quarter, works when cropped to a square grid',
  '3:4': 'subject centered, text in the top third, safe for the profile grid crop',
  '4:3': 'subject on the right, text on the left, generous margins',
  '2:3': 'subject in the lower two thirds, large title text at the top, poster layout',
  '21:9': 'wide panoramic layout, subject on one side, text on the opposite side, key content in the central safe area',
};
const NEG = 'blurry, low resolution, extra fingers, distorted face, deformed hands, watermark, logo, misspelled text, cluttered background, jpeg artifacts';

function thumbnail(input) {
  const subject = clean([input.title, input.context].filter(Boolean).join('. ')) || 'the creator';
  const styles = input.styles.length ? input.styles : ['Bold text-first'];
  const words = styles.map((s) => STYLE_WORDS[s]?.[0]).filter(Boolean).join(', ');
  const palette = STYLE_WORDS[styles[0]]?.[1] ?? ['#FFD400', '#111111', '#FFFFFF'];
  const text = input.textOverlay || keywords(subject, 3).slice(0, 3).join(' ').toUpperCase() || 'WATCH THIS';
  const extra = input.instructions ? ` ${clean(input.instructions)}.` : '';
  return {
    contentAnalysis: { subject: firstSentence(subject, 120), emotion: /shock|fail|crazy|insane|survive/i.test(subject) ? 'shock / suspense' : 'curiosity', keyVisual: firstSentence(subject, 80), colorPalette: palette },
    concept: `One clear focal subject about "${firstSentence(subject, 80)}" with the words "${text}" for a curiosity gap.`,
    variants: input.ratios.map((ratio) => ({
      ratio,
      useCase: RATIOS[ratio].useCase,
      prompt: `YouTube-style thumbnail about ${subject}. ${cap(RATIO_LAYOUT[ratio])}. ${words}. Bold text that reads "${text}" with a thick dark stroke. Sharp focus, high contrast, vibrant, professional quality, readable at small size.${extra}`,
      negativePrompt: NEG,
      composition: cap(RATIO_LAYOUT[ratio]),
      textOverlay: `"${text}" in a heavy sans-serif (e.g. Anton or Bebas Neue), ${palette[0]} with a black stroke`,
      colorPalette: palette,
    })),
    styleNotes: ['Use 3-5 words of text at most.', 'Faces with strong emotion get more clicks.', 'Test the thumbnail at phone size before posting.'],
    abTestIdeas: ['Same image, different 2-word text', 'Close-up face vs. wide shot', 'Bright background vs. dark background'],
  };
}

// ---------------- art cover ----------------
const GENRE_LOOK = [
  [/phonk|drift/i, 'dark night city, drifting car silhouette, purple and red neon haze, VHS grain, Memphis rap aesthetic', ['#1A0B2E', '#7B2CBF', '#FF206E']],
  [/lo-?fi|chill/i, 'cozy anime-style room at dusk, warm desk lamp, rain on the window, soft pastel tones', ['#F2C6DE', '#9AD1D4', '#2E2E3A']],
  [/drill|trap|hip ?hop|rap/i, 'gritty urban street at night, hard flash photography, smoke, chrome details, high contrast', ['#0D0D0D', '#B0B0B0', '#E63946']],
  [/punjabi|bhangra|desi/i, 'bold portrait with golden-hour light, rich jewel tones, ornate patterns, cinematic Punjab landscape', ['#C9A227', '#7A0019', '#0B3D2E']],
  [/afro/i, 'vibrant sunset tones, warm skin-light glow, tropical leaves, bold geometric patterns', ['#FF7B00', '#FFD000', '#00916E']],
  [/edm|house|techno|electro|dance/i, 'abstract light beams, laser grid, futuristic chrome shapes, deep blacks, electric colors', ['#00F5D4', '#9B5DE5', '#0A0A0A']],
  [/rock|metal|punk/i, 'raw textured collage, distressed paper, high-contrast black and white with one red accent', ['#111111', '#E5E5E5', '#C1121F']],
  [/r&b|rnb|soul/i, 'intimate low-light portrait, satin textures, warm amber and deep blue, soft bokeh', ['#1D3557', '#E9C46A', '#6D2E46']],
  [/pop/i, 'bright clean studio set, bold color blocking, glossy finish, playful props', ['#FF4D6D', '#FFD6E0', '#3A86FF']],
  [/classical|piano|orchestr/i, 'elegant minimal still life, piano keys, soft window light, muted classic palette', ['#F5F1E8', '#2B2B2B', '#A68A64']],
  [/ambient|cinematic|soundtrack/i, 'vast misty landscape, tiny lone figure, soft volumetric light, calm muted tones', ['#A3B1C6', '#36454F', '#E8E8E8']],
];

function artcover(input) {
  const t = input.track;
  const [, look, palette] = GENRE_LOOK.find(([re]) => re.test(`${t.genre} ${t.mood}`)) ?? [null, 'striking surreal central image, strong single focal point, rich color grading', ['#22223B', '#9A8C98', '#F2E9E4']];
  const mood = t.mood || 'evocative';
  const themes = t.themes ? ` inspired by: ${firstSentence(t.themes, 120)}` : '';
  const styleWords = input.styles.length ? input.styles.join(', ') : 'photorealistic';
  const text = input.includeText ? ` Typography reading "${t.title || 'TITLE'}"${t.artist ? ` and "${t.artist}"` : ''} in a clean bold font.` : ' Leave clean space at the top for the title.';
  const extra = input.instructions ? ` ${clean(input.instructions)}.` : '';
  const master = `Album cover art for a ${t.genre || 'modern'} track${t.title ? ` called "${t.title}"` : ''}, ${mood} mood${themes}. ${cap(look)}. ${styleWords} style, centered composition that reads at thumbnail size, high detail, professional album artwork.${text}${extra}`;
  const alt = input.styles.length > 1 ? input.styles : ['Minimal typographic', 'Surreal / dreamlike', 'Film grain analog'];
  return {
    referenceAnalysis: {
      commonThemes: input.images.length ? ['Basic mode cannot see reference images: describe what you like about them in the instructions.'] : [t.genre, t.mood].filter(Boolean),
      palette,
      lighting: '',
      composition: 'Single strong focal point, centered',
      mood,
    },
    concept: `A ${mood} visual in the language of ${t.genre || 'the genre'}${themes ? `, ${themes.trim()}` : ''}.`,
    masterPrompt: master,
    negativePrompt: 'text errors, watermark, logo, URL, social media handle, blurry, low resolution, extra limbs, distorted faces, cluttered',
    variations: alt.slice(0, 3).map((style) => ({ name: style, style, prompt: master.replace(styleWords, style) })),
    formats: [
      { ratio: '1:1', useCase: 'Main cover', prompt: master },
      { ratio: '9:16', useCase: 'Canvas / Stories', prompt: `Vertical 9:16 version: ${master} Extend the scene vertically, subject in the middle third, subtle looping motion potential.` },
      { ratio: '16:9', useCase: 'Visualizer', prompt: `Wide 16:9 version: ${master} Extend the background horizontally, subject off-center, space for lyrics.` },
    ],
    typography: { titleFont: /drill|trap|rap|phonk|metal/i.test(t.genre) ? 'Heavy condensed sans or gothic blackletter' : 'Clean geometric sans-serif', placement: 'Top or bottom edge, away from the focal subject', treatment: 'High contrast against the background; test at 64×64 px' },
    complianceNotes: ['Export at 3000×3000 px, RGB, JPG or PNG.', 'No URLs, social handles, prices or streaming logos on the cover.', 'Any text must match the release title and artist exactly.', 'Only use images you own or have rights to.'],
  };
}

// ---------------- music ----------------
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

function music(input) {
  const f = input.features;
  const lyrics = input.lyrics;
  const lines = lyrics.split(/\n+/).map((l) => l.trim().toLowerCase()).filter(Boolean);
  const repeated = lines.length ? 1 - new Set(lines).size / lines.length : 0;
  const reasons = {};
  const sc = {};

  const intro = f?.introSec;
  sc.viralSnippet = f ? clamp(45 + (f.dropStrength ?? 0) * 0.6 + (intro == null ? -10 : intro <= 8 ? 15 : intro <= 15 ? 5 : -10)) : 50;
  reasons.viralSnippet = f ? `Full energy at ${intro == null ? 'no clear point' : mmss(intro)}, drop strength ${f.dropStrength ?? 0}/100.` : 'No audio analyzed.';

  if (f && f.rmsDb != null) {
    let m = 70;
    if (f.peakDb > -0.3) m -= 12;
    if (f.crestDb < 6) m -= 15;
    if (f.crestDb > 16) m -= 10;
    if (f.rmsDb < -20) m -= 12;
    if (f.stereoCorrelation != null && f.stereoCorrelation < 0) m -= 20;
    sc.mixQuality = clamp(m);
    reasons.mixQuality = `Avg ${f.rmsDb} dBFS, peak ${f.peakDb} dBFS, crest ${f.crestDb} dB${f.stereoCorrelation != null ? `, stereo correlation ${f.stereoCorrelation}` : ''}.`;
  } else {
    sc.mixQuality = 50;
    reasons.mixQuality = 'Not measured.';
  }

  const variety = f && f.energyCurve.length > 4 ? Math.sqrt(f.energyCurve.reduce((s, v, _, a) => s + (v - a.reduce((x, y) => x + y, 0) / a.length) ** 2, 0) / f.energyCurve.length) : null;
  sc.production = clamp(55 + (variety != null ? Math.min(20, variety / 1.5) : 0) - (f?.silenceStartSec > 1 ? 8 : 0));
  reasons.production = variety != null ? `Energy variation ${Math.round(variety)} (builds and drops keep listeners engaged).` : 'Not measured.';

  sc.catchiness = clamp(50 + repeated * 40 + (f?.dropStrength ?? 0) * 0.2);
  reasons.catchiness = `Estimated from lyric repetition (${Math.round(repeated * 100)}% repeated lines) and the drop. Can't be judged without listening.`;

  sc.lyrics = lyrics ? clamp(55 + Math.min(15, lines.length / 3) + repeated * 20) : 55;
  reasons.lyrics = lyrics ? `${lines.length} lines, ${repeated > 0.15 ? 'has a repeated hook' : 'little repetition'}.` : 'No lyrics provided (instrumental or not shared).';

  sc.originality = 50;
  reasons.originality = "Originality can't be measured without listening.";

  const dur = f?.durationSec;
  sc.replayValue = dur ? clamp(dur >= 120 && dur <= 210 ? 72 : dur < 120 ? 66 : dur <= 270 ? 60 : 50) : 55;
  reasons.replayValue = dur ? `Length ${mmss(dur)} (2:00-3:30 tends to replay best in the short-form era).` : 'Not measured.';

  const bpm = f?.bpm;
  sc.genreTrendFit = clamp(55 + (bpm && bpm >= 90 && bpm <= 150 ? 10 : 0));
  reasons.genreTrendFit = bpm ? `~${bpm} BPM${bpm >= 90 && bpm <= 150 ? ', inside the range most short-form trends use' : ''}.` : 'Tempo not measured.';

  const tp = clamp(sc.viralSnippet * 0.35 + sc.catchiness * 0.2 + sc.genreTrendFit * 0.2 + sc.mixQuality * 0.1 + sc.replayValue * 0.15);
  const peakWeek = tp >= 70 ? 2 : tp >= 50 ? 3 : 4;
  const life = Math.round(3 + tp / 12);
  const momentum = Array.from({ length: 12 }, (_, i) => {
    const w = i + 1;
    const v = w <= peakWeek ? tp * (0.35 + (0.65 * w) / peakWeek) : tp * Math.exp(-(w - peakWeek) / (life / 2));
    return clamp(v);
  });

  const snip15 = f?.bestSnippet15;
  const snip30 = f?.bestSnippet30;
  const improvements = [];
  if (intro != null && intro > 10) improvements.push({ action: `Make a radio/short-form edit that starts within 8 seconds of the drop (now ${mmss(intro)})`, criterion: 'viralSnippet', estimatedGain: 10, why: 'Most people decide in the first few seconds.' });
  if (f?.peakDb > -0.3) improvements.push({ action: 'Lower the master ceiling to about -1 dBTP', criterion: 'mixQuality', estimatedGain: 6, why: 'Peaks near 0 dBFS can distort after streaming encoding.' });
  if (f?.crestDb != null && f.crestDb < 6) improvements.push({ action: 'Reduce limiting so the master keeps some punch', criterion: 'mixQuality', estimatedGain: 6, why: 'Streaming services turn loud masters down anyway, so over-limiting only loses impact.' });
  if (f?.rmsDb != null && f.rmsDb < -20) improvements.push({ action: 'Raise overall loudness in mastering', criterion: 'mixQuality', estimatedGain: 6, why: 'A very quiet master sounds weak next to other tracks.' });
  if (f?.stereoCorrelation != null && f.stereoCorrelation < 0) improvements.push({ action: 'Fix phase issues (check in mono)', criterion: 'mixQuality', estimatedGain: 12, why: 'Out-of-phase elements disappear on phone speakers.' });
  if (f?.silenceStartSec > 0.5) improvements.push({ action: `Trim the ${f.silenceStartSec}s of silence at the start`, criterion: 'production', estimatedGain: 4, why: 'Silence at the start makes people skip.' });
  if (lyrics && repeated < 0.15) improvements.push({ action: 'Add a short repeated hook line people can lip-sync to', criterion: 'catchiness', estimatedGain: 8, why: 'Repeated lines are what people quote in videos.' });
  if (snip15) improvements.push({ action: `Upload ${mmss(snip15.start)}-${mmss(snip15.end)} as the official TikTok/Reels sound before release`, criterion: 'viralSnippet', estimatedGain: 8, why: 'An easy-to-use clip lets creators adopt the song.' });

  return {
    criteria: sc,
    criteriaReasons: reasons,
    trendingPotential: tp,
    platformPotential: Object.fromEntries(Object.keys(MUSIC_PLATFORMS).map((p) => {
      const v = { tiktok: sc.viralSnippet, instagram: (sc.viralSnippet + sc.catchiness) / 2, youtube: (sc.production + sc.replayValue) / 2, spotify: (sc.replayValue + sc.mixQuality + sc.production) / 3, apple_music: (sc.production + sc.mixQuality) / 2 - 5, soundcloud: (sc.genreTrendFit + sc.originality) / 2 }[p];
      return [p, { potential: clamp(v), reason: 'Rule-based estimate from the measured audio.' }];
    })),
    confidence: 'low',
    confidenceNote: 'Basic mode scores only what can be measured (structure, loudness, tempo, lyrics). It cannot hear melody, vocals or originality.',
    verdict: f ? `Measured: ${mmss(f.durationSec)}${bpm ? `, ~${bpm} BPM` : ''}, ${intro == null ? 'no sustained high-energy section' : `full energy at ${mmss(intro)}`}. Rule-based trending potential: ${tp}%.` : 'No audio was analyzed, so this is a rough estimate from the text only.',
    peakMoment: snip15 ? { start: snip15.start, end: snip15.end, why: 'Highest sustained energy in the track.' } : f?.dropAtSec != null ? { start: f.dropAtSec, end: Math.min(f.durationSec, f.dropAtSec + 15), why: 'Biggest energy rise (the drop).' } : { start: 0, end: 0, why: '' },
    snippets: [
      snip15 && { start: snip15.start, end: snip15.end, useFor: 'TikTok / Shorts 15s sound', why: 'Highest-energy 15 seconds.' },
      snip30 && { start: snip30.start, end: snip30.end, useFor: 'Reels / Stories 30s edit', why: 'Highest-energy 30 seconds.' },
      f?.dropAtSec != null && { start: Math.max(0, f.dropAtSec - 3), end: Math.min(f.durationSec, f.dropAtSec + 7), useFor: 'Transition / loop clip', why: 'Build-up into the drop is ideal for transitions.' },
    ].filter(Boolean),
    timeline: {
      timeToPeak: `${peakWeek - 1}-${peakWeek + 1} weeks after release (rule of thumb)`,
      peakWeek,
      trendLifespanWeeks: life,
      momentumByWeek: momentum,
      bestReleaseTiming: 'Friday at 00:00 in your main market: the global release day, when new music playlists refresh.',
      phases: [
        { phase: 'Teasers', when: 'Weeks -2 to 0', focus: 'Seed the hook', actions: [snip15 ? `Post 3-5 short clips using ${mmss(snip15.start)}-${mmss(snip15.end)}` : 'Post 3-5 short teaser clips', 'Pitch to editorial playlists via Spotify for Artists at least 7 days before release', 'Share the sound with 5-10 creators in your niche'] },
        { phase: 'Release spike', when: 'Week 1', focus: 'Concentrate attention', actions: ['Post daily using the official sound', 'Go live or reply to every comment', 'Ask fans to save the track'] },
        { phase: 'Creator push', when: `Weeks 2-${peakWeek + 1}`, focus: 'Get other people using it', actions: ['Duet/stitch every video that uses the sound', 'Start a simple challenge or edit format'] },
        { phase: 'Long tail', when: `Week ${peakWeek + 2} onward`, focus: 'Keep it alive', actions: ['Release a sped-up or slowed version', 'Post a lyric video or visualizer'] },
      ],
    },
    strengths: [
      f?.dropStrength >= 30 && { point: `Clear energy drop at ${mmss(f.dropAtSec)}`, impact: 'high' },
      intro != null && intro <= 8 && { point: 'Gets to the energy fast', impact: 'high' },
      sc.mixQuality >= 65 && { point: 'Healthy loudness and dynamics', impact: 'medium' },
      repeated >= 0.15 && { point: 'Lyrics have a repeated hook', impact: 'medium' },
    ].filter(Boolean),
    weaknesses: [
      intro != null && intro > 15 && `Long build: full energy only at ${mmss(intro)}`,
      f?.peakDb > -0.3 && 'Peaks very close to 0 dBFS',
      f?.stereoCorrelation != null && f.stereoCorrelation < 0 && 'Possible phase problems',
      !f && 'No audio analyzed',
    ].filter(Boolean),
    improvements,
    trendMatches: [],
  };
}

const GENERATORS = { caption, ideas, thumbnail, artcover, music };

export function basicAvailable(id) {
  return id in GENERATORS;
}

export function generateBasic(id, input, ctx) {
  const gen = GENERATORS[id];
  if (!gen) {
    throw new AppError(503, "Basic mode can't rate images or videos because it can't see them. Choose the free AI engine (sign in with Puter) for this assistant.");
  }
  return gen(input, ctx);
}

export { BASIC_NOTE };
