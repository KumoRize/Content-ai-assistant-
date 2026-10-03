import { PLATFORMS } from '../config.js';
import * as v from '../util.js';
import { arr, obj, str } from '../schema.js';
import { CORE_RULES, materialSection, trendSection } from './shared.js';
import { AppError } from '../errors.js';

const MEDIA_KINDS = ['reel', 'short video', 'long video', 'image post', 'carousel', 'story', 'other'];

export const caption = {
  id: 'caption',
  maxImages: 12,
  system: `${CORE_RULES}

Your job: analyze the creator's material and write platform-native descriptions, captions, titles, hashtags and keywords that maximize reach on each selected platform. Each platform gets genuinely different copy, written for how that platform's audience and algorithm behave, not the same text resized.`,

  normalize(body) {
    const input = {
      images: v.images(body.images, caption.maxImages),
      mediaKind: MEDIA_KINDS.includes(body.mediaKind) ? body.mediaKind : '',
      context: v.text(body.context, 'context', 6000),
      instructions: v.text(body.instructions, 'instructions', 4000),
      platforms: v.platforms(body.platforms),
      profile: v.profile(body.profile),
      geo: v.geo(body.geo),
      useLiveTrends: v.bool(body.useLiveTrends, true),
      webSearch: v.bool(body.webSearch, false),
    };
    if (!input.images.length && !input.context) {
      throw new AppError(400, 'Upload your material or describe it so the assistant has something to analyze.');
    }
    return input;
  },

  buildPrompt(input, ctx) {
    const rules = input.platforms.map((p) => `- ${p} (${PLATFORMS[p].label}): ${PLATFORMS[p].guidance}`).join('\n');
    return `Today is ${ctx.today}. Target region: ${input.geo}.

<material>
${materialSection(input)}
</material>

<creator_profile>
${v.profileBlock(input.profile)}
</creator_profile>

<creator_instructions>
${input.instructions || '(none: use your best judgment for maximum reach)'}
</creator_instructions>

${trendSection(ctx)}

<platform_rules>
${rules}
</platform_rules>

Steps:
1. Study the material: subject, emotion, the single most scroll-stopping moment, niche and who will care.
2. Pick the trend angles that truly fit (from the live data/searches when available).
3. For EACH platform key (${input.platforms.join(', ')}) write:
   - title: YouTube = SEO title (≤100 chars). Other platforms = the on-screen text / headline overlay for the first 2 seconds.
   - caption: the full description/caption WITHOUT hashtags, in the platform's native style and the output language. Hook in the first line.
   - hashtags: ordered best-first, mixing broad, niche and trend tags, within the platform cap.
   - keywords: 5-12 search phrases people actually type (for YouTube these are the Tags field).
   - hook: the spoken/visual opening line for this platform.
   - cta: one natural call to action.
   - bestTimeToPost: a general recommendation for the target region with a short reason; say it is a starting point to test.
   - formatTips: 1-2 concrete edits/format tips for this platform (length, sound, cover frame, etc.).
4. trendInsights: the trends you used, where each came from (source name or "evergreen"), why it fits and how to use it.`;
  },

  schema(input) {
    const platformShape = obj({ title: str, caption: str, hashtags: arr(str), keywords: arr(str), hook: str, cta: str, bestTimeToPost: str, formatTips: str });
    return obj({
      contentAnalysis: obj({ summary: str, subjects: arr(str), mood: str, niche: str, scrollStopper: str, audience: str }),
      trendInsights: arr(obj({ trend: str, source: str, relevance: str, howToUse: str })),
      platforms: obj(Object.fromEntries(input.platforms.map((p) => [p, platformShape]))),
    });
  },

  postprocess(data, input) {
    const ca = v.asObject(data.contentAnalysis);
    const rawPlatforms = v.asObject(data.platforms);
    const platforms = {};
    for (const key of input.platforms) {
      platforms[key] = finalizePlatform(key, v.asObject(rawPlatforms[key]));
    }
    return {
      contentAnalysis: {
        summary: v.asString(ca.summary),
        subjects: v.asStrings(ca.subjects),
        mood: v.asString(ca.mood),
        niche: v.asString(ca.niche),
        scrollStopper: v.asString(ca.scrollStopper),
        audience: v.asString(ca.audience),
      },
      trendInsights: v.asArray(data.trendInsights).map((t) => {
        const o = v.asObject(t);
        return { trend: v.asString(o.trend), source: v.asString(o.source), relevance: v.asString(o.relevance), howToUse: v.asString(o.howToUse) };
      }).filter((t) => t.trend),
      platforms,
    };
  },
};

// Enforce hard platform limits so the copy can be pasted without being rejected.
export function finalizePlatform(key, p) {
  const rules = PLATFORMS[key];
  const warnings = [];
  const allTags = v.normalizeHashtags(p.hashtags);
  const hashtags = allTags.slice(0, rules.hashtagMax);
  if (allTags.length > hashtags.length) warnings.push(`Trimmed hashtags to ${rules.hashtagMax} (platform best-practice cap).`);
  if (!p.caption && !p.title) warnings.push('The AI returned no copy for this platform. Try generating again.');

  let title = v.asString(p.title);
  if (rules.titleMax && v.charLength(title) > rules.titleMax) {
    title = v.truncateWords(title, rules.titleMax);
    warnings.push(`Title shortened to ${rules.titleMax} characters.`);
  }

  let keywords = [...new Set(v.asStrings(p.keywords).map((k) => k.replace(/^#/, '')))];
  if (rules.tagsCharMax) {
    // YouTube counts commas between tags toward the 500-char limit.
    const kept = [];
    let total = 0;
    for (const k of keywords) {
      const add = v.charLength(k) + (kept.length ? 1 : 0);
      if (total + add > rules.tagsCharMax) break;
      kept.push(k);
      total += add;
    }
    if (kept.length < keywords.length) warnings.push('Trimmed keywords to fit the 500-character Tags limit.');
    keywords = kept;
  }

  const tagLine = hashtags.join(' ');
  const sep = tagLine ? '\n\n' : '';
  let caption = v.asString(p.caption);
  const budget = rules.captionMax - v.charLength(sep + tagLine);
  if (v.charLength(caption) > budget) {
    caption = v.truncateWords(caption, Math.max(0, budget));
    warnings.push(`Caption shortened to fit the ${rules.captionMax.toLocaleString('en-US')}-character limit with hashtags.`);
  }
  const fullPost = caption + sep + tagLine;

  return {
    title,
    caption,
    hashtags,
    keywords,
    hook: v.asString(p.hook),
    cta: v.asString(p.cta),
    bestTimeToPost: v.asString(p.bestTimeToPost),
    formatTips: v.asString(p.formatTips),
    fullPost,
    charCount: v.charLength(fullPost),
    charLimit: rules.captionMax,
    warnings,
  };
}
