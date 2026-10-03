import { PLATFORMS } from '../config.js';
import * as v from '../util.js';
import { arr, int, obj, str } from '../schema.js';
import { CORE_RULES, materialSection, trendSection } from './shared.js';
import { AppError } from '../errors.js';
import { computeMetrics, readMetrics } from '../metrics.js';

const SCORE_KEYS = ['hook', 'visualQuality', 'clarity', 'emotion', 'trendFit', 'shareability', 'retention'];

export const analyze = {
  id: 'analyze',
  maxImages: 12,
  system: `${CORE_RULES}

Your job: act as a brutally honest but constructive content analyst. Audit the creator's material (and its performance numbers when given), score it, explain exactly why it will or did perform the way it does, and give a prioritized, concrete improvement plan to make it trend.`,

  normalize(body) {
    const platform = Object.keys(PLATFORMS).includes(body.platform) ? body.platform : 'instagram';
    const input = {
      images: v.images(body.images, analyze.maxImages),
      mediaKind: v.text(body.mediaKind, 'mediaKind', 40),
      context: v.text(body.context, 'context', 6000),
      instructions: v.text(body.instructions, 'instructions', 4000),
      platform,
      metrics: readMetrics(body.metrics),
      profile: v.profile(body.profile),
      geo: v.geo(body.geo),
      useLiveTrends: v.bool(body.useLiveTrends, true),
      webSearch: v.bool(body.webSearch, false),
    };
    if (!input.images.length && !input.context) {
      throw new AppError(400, 'Upload the content you want analyzed or describe it.');
    }
    input.computed = computeMetrics(input.metrics);
    return input;
  },

  buildPrompt(input, ctx) {
    const hasMetrics = Object.keys(input.metrics).length > 0;
    const metricsText = hasMetrics
      ? `Raw numbers: ${JSON.stringify(input.metrics)}\nComputed (already calculated, do not recompute): ${JSON.stringify(input.computed)}`
      : 'No performance numbers provided: this is a pre-publish audit. Predict performance from the content itself.';
    return `Today is ${ctx.today}. Platform: ${PLATFORMS[input.platform].label}. Region: ${input.geo}.

<material>
${materialSection(input)}
</material>

<performance_data>
${metricsText}
</performance_data>

<creator_profile>
${v.profileBlock(input.profile)}
</creator_profile>

<creator_instructions>
${input.instructions || '(none: give a full audit)'}
</creator_instructions>

${trendSection(ctx)}

Platform context: ${PLATFORMS[input.platform].guidance}

Produce:
- verdict: 2-3 sentence bottom line.
- viralPotential: 0-100 overall.
- scores: each 0-100 for ${SCORE_KEYS.join(', ')}. Be calibrated: 50 is average, 80+ is genuinely excellent.
- strengths / weaknesses: specific, referencing what you see (e.g. "frame 2: text overlay covers the face").
- improvements: 4-8 items, each with priority (high/medium/low), the exact action, and why it moves the algorithm.
- metricsInterpretation: what the numbers say (or "pre-publish prediction" reasoning). Interpret rates relative to each other (e.g. saves vs likes) rather than quoting invented benchmarks.
- suggestedHooks: 3 alternative opening hooks.
- suggestedCaption: an improved caption for ${PLATFORMS[input.platform].label} (no hashtags).
- hashtags: improved hashtags for this platform.
- repurposePlan: how to adapt this content for 2-4 other platforms.
- nextExperiments: 3 A/B tests to run on the next post.`;
  },

  schema() {
    return obj({
      verdict: str,
      viralPotential: int,
      scores: obj(Object.fromEntries(SCORE_KEYS.map((k) => [k, int]))),
      strengths: arr(str),
      weaknesses: arr(str),
      improvements: arr(obj({ priority: str, action: str, why: str })),
      metricsInterpretation: str,
      suggestedHooks: arr(str),
      suggestedCaption: str,
      hashtags: arr(str),
      repurposePlan: arr(obj({ platform: str, idea: str })),
      nextExperiments: arr(str),
    });
  },

  postprocess(data, input) {
    const scores = v.asObject(data.scores);
    const order = { high: 0, medium: 1, low: 2 };
    return {
      verdict: v.asString(data.verdict),
      viralPotential: v.clampInt(data.viralPotential, 0, 100),
      scores: Object.fromEntries(SCORE_KEYS.map((k) => [k, v.clampInt(scores[k], 0, 100)])),
      strengths: v.asStrings(data.strengths),
      weaknesses: v.asStrings(data.weaknesses),
      improvements: v.asArray(data.improvements)
        .map((i) => {
          const o = v.asObject(i);
          const priority = v.asString(o.priority).toLowerCase();
          return { priority: priority in order ? priority : 'medium', action: v.asString(o.action), why: v.asString(o.why) };
        })
        .filter((i) => i.action)
        .sort((a, b) => order[a.priority] - order[b.priority]),
      metricsInterpretation: v.asString(data.metricsInterpretation),
      suggestedHooks: v.asStrings(data.suggestedHooks),
      suggestedCaption: v.asString(data.suggestedCaption),
      hashtags: v.normalizeHashtags(data.hashtags, PLATFORMS[input.platform].hashtagMax),
      repurposePlan: v.asArray(data.repurposePlan).map((r) => ({ platform: v.asString(v.asObject(r).platform), idea: v.asString(v.asObject(r).idea) })).filter((r) => r.idea),
      nextExperiments: v.asStrings(data.nextExperiments),
      metrics: input.metrics,
      computedMetrics: input.computed,
    };
  },
};
