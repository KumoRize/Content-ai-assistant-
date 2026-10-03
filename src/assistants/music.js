import * as v from '../util.js';
import { arr, int, obj, str } from '../schema.js';
import { CORE_RULES, trendSection } from './shared.js';
import { AppError } from '../errors.js';
import { grade } from './score.js';

export const MUSIC_PLATFORMS = {
  tiktok: 'TikTok',
  instagram: 'Instagram Reels',
  youtube: 'YouTube & Shorts',
  spotify: 'Spotify',
  apple_music: 'Apple Music',
  soundcloud: 'SoundCloud',
};
export const MUSIC_STRENGTH_KEYS = ['catchiness', 'production', 'mixQuality', 'originality', 'lyrics', 'replayValue'];
export const MUSIC_CRITERIA_KEYS = [...MUSIC_STRENGTH_KEYS, 'viralSnippet', 'genreTrendFit'];
const MAX_WEEKS = 16;

const num = (x, min, max) => (typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : null);
const snippet = (s, dur) => {
  if (!s || typeof s !== 'object') return null;
  const start = num(s.start, 0, dur);
  const end = num(s.end, 0, dur);
  return start != null && end != null && end > start ? { start, end, avgEnergy: num(s.avgEnergy, 0, 100) } : null;
};

// Only accept the numeric shape produced by public/audio-features.js.
export function readFeatures(f) {
  if (f == null) return null;
  if (typeof f !== 'object' || Array.isArray(f)) throw new AppError(400, '"features" must be an object.');
  const durationSec = num(f.durationSec, 1, 3600);
  if (durationSec == null) throw new AppError(400, 'Audio analysis is missing the track length.');
  const curve = Array.isArray(f.energyCurve) ? f.energyCurve.slice(0, 400).map((x) => num(x, 0, 100) ?? 0) : [];
  return {
    durationSec,
    bpm: num(f.bpm, 40, 250),
    bpmConfidence: num(f.bpmConfidence, 0, 1),
    peakDb: num(f.peakDb, -200, 10),
    rmsDb: num(f.rmsDb, -200, 10),
    crestDb: num(f.crestDb, 0, 200),
    brightness: ['bright', 'balanced', 'dark/warm'].includes(f.brightness) ? f.brightness : null,
    stereoCorrelation: num(f.stereoCorrelation, -1, 1),
    silenceStartSec: num(f.silenceStartSec, 0, durationSec),
    silenceEndSec: num(f.silenceEndSec, 0, durationSec),
    introSec: num(f.introSec, 0, durationSec),
    dropAtSec: num(f.dropAtSec, 0, durationSec),
    dropStrength: num(f.dropStrength, 0, 100),
    bestSnippet15: snippet(f.bestSnippet15, durationSec),
    bestSnippet30: snippet(f.bestSnippet30, durationSec),
    curveStepSec: num(f.curveStepSec, 1, 60) ?? 1,
    energyCurve: curve,
  };
}

export const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

function featuresText(f) {
  if (!f) return 'No audio file was analyzed. Rely on the description and lyrics only, and lower your confidence.';
  const lines = [
    `Length: ${mmss(f.durationSec)} (${f.durationSec}s)`,
    f.bpm != null && `Estimated tempo: ${f.bpm} BPM (detection confidence ${f.bpmConfidence ?? '?'}; could be half/double time)`,
    f.rmsDb != null && `Average level: ${f.rmsDb} dBFS RMS, peak ${f.peakDb} dBFS, crest factor ${f.crestDb} dB (low crest = heavily compressed/loud master, high = dynamic/quiet)`,
    f.brightness && `Tonal brightness: ${f.brightness}`,
    f.stereoCorrelation != null && `Stereo correlation: ${f.stereoCorrelation} (1 = mono, near 0 = very wide, negative = phase problems)`,
    f.silenceStartSec ? `Silence at start: ${f.silenceStartSec}s` : null,
    f.silenceEndSec ? `Silence at end: ${f.silenceEndSec}s` : null,
    f.introSec != null ? `Reaches full energy at ${mmss(f.introSec)}` : 'Never sustains a clear high-energy section',
    f.dropAtSec != null && `Biggest energy rise (drop/chorus entry) at ${mmss(f.dropAtSec)}, strength ${f.dropStrength}/100`,
    f.bestSnippet15 && `Highest-energy 15s window: ${mmss(f.bestSnippet15.start)}-${mmss(f.bestSnippet15.end)}`,
    f.bestSnippet30 && `Highest-energy 30s window: ${mmss(f.bestSnippet30.start)}-${mmss(f.bestSnippet30.end)}`,
    f.energyCurve.length && `Energy curve (0-100, one value every ${f.curveStepSec}s): ${f.energyCurve.join(',')}`,
  ];
  return lines.filter(Boolean).join('\n');
}

export const music = {
  id: 'music',
  maxImages: 1,
  system: `${CORE_RULES}

Your job: be an A&R scout, music-marketing strategist and short-form-video trend analyst in one. Rate the creator's music track in percentages, judge how likely it is to trend, find its peak moment, and predict a realistic trend timeline with the actions that make it happen.

Important honesty rules for music:
- You cannot hear the audio. You get objective measurements extracted from the waveform (tempo, loudness, dynamics, energy over time, where the drop is), plus the lyrics and the creator's description. Base your judgment on those. Where a score depends on listening (vocal performance, melody), say so in the reason and set confidence accordingly.
- Calibrate: 50% = an average independent release. 70% = strong. 85%+ = exceptional, rare.
- Timelines are predictions, not promises: base them on how songs in this genre typically move on short-form video and streaming (teasers, the release spike, creator adoption, playlist pickup, decay).`,

  normalize(body) {
    const t = body.track && typeof body.track === 'object' ? body.track : {};
    const releaseDate = v.text(t.releaseDate, 'release date', 10);
    if (releaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) throw new AppError(400, 'Release date must look like 2026-11-20.');
    const input = {
      images: v.images(body.images, music.maxImages),
      features: readFeatures(body.features),
      track: {
        title: v.text(t.title, 'track title', 200),
        artist: v.text(t.artist, 'artist', 200),
        genre: v.text(t.genre, 'genre', 200),
        mood: v.text(t.mood, 'mood', 300),
        language: v.text(t.language, 'song language', 100),
        soundsLike: v.text(t.soundsLike, 'sounds like', 500),
        releaseDate,
      },
      lyrics: v.text(body.lyrics, 'lyrics', 10000),
      description: v.text(body.description, 'description', 3000),
      instructions: v.text(body.instructions, 'instructions', 4000),
      profile: v.profile(body.profile),
      geo: v.geo(body.geo),
      useLiveTrends: v.bool(body.useLiveTrends, true),
      webSearch: v.bool(body.webSearch, false),
    };
    if (!input.features && !input.lyrics && !input.description) {
      throw new AppError(400, 'Upload your track (or at least paste lyrics / describe the sound) so it can be rated.');
    }
    return input;
  },

  buildPrompt(input, ctx) {
    const t = input.track;
    return `Today is ${ctx.today}. Region: ${input.geo}.

<track>
Title: ${t.title || '(untitled)'}
Artist: ${t.artist || '(not given)'}
Genre: ${t.genre || '(not given)'}
Mood: ${t.mood || '(not given)'}
Song language: ${t.language || '(not given)'}
Sounds like / references: ${t.soundsLike || '(not given)'}
Release date: ${t.releaseDate || 'not decided / already out'}
Creator's description of the sound: ${input.description || '(none)'}
</track>

<audio_measurements>
${featuresText(input.features)}
</audio_measurements>

<lyrics>
${input.lyrics || '(none provided: instrumental, or lyrics not shared)'}
</lyrics>
${input.images.length ? '\nThe attached image is the cover art: factor it into streaming/click potential.\n' : ''}
<creator_profile>
${v.profileBlock(input.profile)}
</creator_profile>

<creator_instructions>
${input.instructions || '(none: give a full rating and plan)'}
</creator_instructions>

${trendSection(ctx)}

Return:
- criteria: 0-100 for ${MUSIC_CRITERIA_KEYS.join(', ')} (for instrumentals, rate "lyrics" as melodic/arrangement storytelling), plus criteriaReasons (same keys, one line each, mention the measurement you used).
- trendingPotential: 0-100, the chance this track catches on (short-form video use + streaming growth) in the next 3 months.
- platformPotential: for each of ${Object.keys(MUSIC_PLATFORMS).join(', ')}: potential 0-100 and reason.
- confidence: low / medium / high, and confidenceNote explaining what limits it.
- verdict: 2 sentences.
- peakMoment: the single best moment of the track (start/end in whole seconds within the track length) and why. Use the measured drop and energy curve.
- snippets: 2-3 clip suggestions (start, end in seconds) with useFor (e.g. "TikTok dance 15s", "Reels lyric edit 30s", "Shorts loop") and why.
- timeline: timeToPeak (plain words, e.g. "2-4 weeks after release"), peakWeek (week number after release when momentum peaks), trendLifespanWeeks, momentumByWeek (exactly 12 integers 0-100: predicted momentum for weeks 1-12 after release), bestReleaseTiming (day/time and why), phases (4-6 phases from pre-release to long tail: phase, when, focus, actions[]).
- strengths: 3-6 (point, impact high/medium/low). weaknesses: 2-6.
- improvements: 4-8, biggest gain first (action, criterion from the criteria keys, estimatedGain in percentage points, why). Include mix/master fixes when the measurements show problems (e.g. long intro, very low crest factor, silence at start, phase issues).
- trendMatches: current sounds/formats/trends this can ride and how (source name or "evergreen").`;
  },

  schema() {
    const keyed = (shape) => obj(Object.fromEntries(MUSIC_CRITERIA_KEYS.map((k) => [k, shape])));
    return obj({
      criteria: keyed(int),
      criteriaReasons: keyed(str),
      trendingPotential: int,
      platformPotential: obj(Object.fromEntries(Object.keys(MUSIC_PLATFORMS).map((p) => [p, obj({ potential: int, reason: str })]))),
      confidence: str,
      confidenceNote: str,
      verdict: str,
      peakMoment: obj({ start: int, end: int, why: str }),
      snippets: arr(obj({ start: int, end: int, useFor: str, why: str })),
      timeline: obj({
        timeToPeak: str,
        peakWeek: int,
        trendLifespanWeeks: int,
        momentumByWeek: arr(int),
        bestReleaseTiming: str,
        phases: arr(obj({ phase: str, when: str, focus: str, actions: arr(str) })),
      }),
      strengths: arr(obj({ point: str, impact: str })),
      weaknesses: arr(str),
      improvements: arr(obj({ action: str, criterion: str, estimatedGain: int, why: str })),
      trendMatches: arr(obj({ trend: str, source: str, howToUse: str })),
    });
  },

  postprocess(data, input) {
    const dur = input.features?.durationSec ?? 3600;
    const span = (o) => {
      const start = v.clampInt(o.start, 0, dur);
      const end = v.clampInt(o.end, 0, dur);
      return start != null && end != null && end > start ? { start, end, label: `${mmss(start)}–${mmss(end)}` } : null;
    };
    const rawCriteria = v.asObject(data.criteria);
    const reasons = v.asObject(data.criteriaReasons);
    const criteria = Object.fromEntries(MUSIC_CRITERIA_KEYS.map((k) => [k, v.clampInt(rawCriteria[k], 0, 100)]));
    const avg = (nums) => {
      const ok = nums.filter((n) => n != null);
      return ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null;
    };
    const strength = avg(MUSIC_STRENGTH_KEYS.map((k) => criteria[k]));
    const trendingPotential = v.clampInt(data.trendingPotential, 0, 100);
    const overall = avg([strength, trendingPotential]);

    const tl = v.asObject(data.timeline);
    const momentum = v.asArray(tl.momentumByWeek).slice(0, MAX_WEEKS).map((x) => v.clampInt(x, 0, 100) ?? 0);
    // Peak week comes from the curve itself when there is one, so chart and text agree.
    const peakWeek = momentum.length ? momentum.indexOf(Math.max(...momentum)) + 1 : v.clampInt(tl.peakWeek, 1, 52);

    const pm = v.asObject(data.peakMoment);
    const peakSpan = span(pm);
    const rawPlatforms = v.asObject(data.platformPotential);
    const impactOrder = { high: 0, medium: 1, low: 2 };
    const confidence = v.asString(data.confidence).toLowerCase();

    return {
      overall,
      grade: grade(overall),
      trendingPotential,
      strength,
      confidence: ['low', 'medium', 'high'].includes(confidence) ? confidence : 'medium',
      confidenceNote: v.asString(data.confidenceNote),
      verdict: v.asString(data.verdict),
      criteria: MUSIC_CRITERIA_KEYS.map((k) => ({ key: k, score: criteria[k], reason: v.asString(reasons[k]) })),
      platformPotential: Object.entries(MUSIC_PLATFORMS).map(([key, label]) => {
        const o = v.asObject(rawPlatforms[key]);
        return { platform: key, label, potential: v.clampInt(o.potential, 0, 100), reason: v.asString(o.reason) };
      }),
      peakMoment: peakSpan ? { ...peakSpan, why: v.asString(pm.why) } : null,
      snippets: v.asArray(data.snippets)
        .map((s) => {
          const o = v.asObject(s);
          const sp = span(o);
          return sp ? { ...sp, useFor: v.asString(o.useFor), why: v.asString(o.why) } : null;
        })
        .filter(Boolean),
      timeline: {
        timeToPeak: v.asString(tl.timeToPeak),
        peakWeek,
        trendLifespanWeeks: v.clampInt(tl.trendLifespanWeeks, 0, 104),
        momentumByWeek: momentum,
        bestReleaseTiming: v.asString(tl.bestReleaseTiming),
        releaseDate: input.track.releaseDate || null,
        phases: v.asArray(tl.phases)
          .map((p) => {
            const o = v.asObject(p);
            return { phase: v.asString(o.phase), when: v.asString(o.when), focus: v.asString(o.focus), actions: v.asStrings(o.actions) };
          })
          .filter((p) => p.phase),
      },
      strengths: v.asArray(data.strengths)
        .map((s) => {
          const o = typeof s === 'string' ? { point: s } : v.asObject(s);
          const impact = v.asString(o.impact).toLowerCase();
          return { point: v.asString(o.point), impact: impact in impactOrder ? impact : 'medium' };
        })
        .filter((s) => s.point)
        .sort((a, b) => impactOrder[a.impact] - impactOrder[b.impact]),
      weaknesses: v.asStrings(data.weaknesses),
      improvements: v.asArray(data.improvements)
        .map((i) => {
          const o = v.asObject(i);
          const criterion = v.asString(o.criterion);
          return { action: v.asString(o.action), criterion: MUSIC_CRITERIA_KEYS.includes(criterion) ? criterion : '', estimatedGain: v.clampInt(o.estimatedGain, 0, 100) ?? 0, why: v.asString(o.why) };
        })
        .filter((i) => i.action)
        .sort((a, b) => b.estimatedGain - a.estimatedGain),
      trendMatches: v.asArray(data.trendMatches)
        .map((t) => {
          const o = v.asObject(t);
          return { trend: v.asString(o.trend), source: v.asString(o.source), howToUse: v.asString(o.howToUse) };
        })
        .filter((t) => t.trend),
      measured: input.features
        ? {
            duration: mmss(input.features.durationSec),
            bpm: input.features.bpm,
            loudness: input.features.rmsDb,
            crest: input.features.crestDb,
            introSec: input.features.introSec,
            dropAt: input.features.dropAtSec != null ? mmss(input.features.dropAtSec) : null,
            energyCurve: input.features.energyCurve,
            curveStepSec: input.features.curveStepSec,
          }
        : null,
    };
  },
};
