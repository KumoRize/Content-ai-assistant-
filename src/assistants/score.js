import { PLATFORMS } from '../config.js';
import * as v from '../util.js';
import { arr, int, obj, str } from '../schema.js';
import { CORE_RULES, materialSection, trendSection } from './shared.js';
import { AppError } from '../errors.js';

// Content strength = how good the material is on its own.
export const STRENGTH_KEYS = ['hook', 'visualQuality', 'originality', 'emotionalImpact', 'clarity'];
// Extra criteria that feed trending potential.
export const CRITERIA_KEYS = [...STRENGTH_KEYS, 'trendAlignment', 'shareability'];

export function grade(pct) {
  if (pct == null) return '-';
  if (pct >= 90) return 'A+';
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B';
  if (pct >= 55) return 'C';
  if (pct >= 40) return 'D';
  return 'F';
}

const mean = (nums) => {
  const ok = nums.filter((n) => n != null);
  return ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null;
};

export const score = {
  id: 'score',
  maxImages: 12,
  system: `${CORE_RULES}

Your job: be a strict, calibrated content judge. Rate the creator's material in percentages, decide how likely it is to trend, explain what makes it strong, and say exactly how to raise each score.

Calibration (follow it, creators need honest numbers):
- 50% = average content that most people scroll past. 70% = good, above most posts in its niche. 85%+ = genuinely exceptional, rare. 95%+ almost never.
- Never inflate scores to be nice. Never give every criterion the same number.
- Score only what you can see or read. Audio cannot be heard; if sound matters, say the score assumes a fitting sound.`,

  normalize(body) {
    const input = {
      images: v.images(body.images, score.maxImages),
      mediaKind: v.text(body.mediaKind, 'mediaKind', 40),
      context: v.text(body.context, 'context', 6000),
      instructions: v.text(body.instructions, 'instructions', 4000),
      platforms: v.platforms(body.platforms),
      profile: v.profile(body.profile),
      geo: v.geo(body.geo),
      useLiveTrends: v.bool(body.useLiveTrends, true),
      webSearch: v.bool(body.webSearch, false),
    };
    if (!input.images.length && !input.context) {
      throw new AppError(400, 'Upload the material you want rated or describe it.');
    }
    return input;
  },

  buildPrompt(input, ctx) {
    return `Today is ${ctx.today}. Region: ${input.geo}.

<material>
${materialSection(input)}
</material>

<creator_profile>
${v.profileBlock(input.profile)}
</creator_profile>

<creator_instructions>
${input.instructions || '(none: give a full rating)'}
</creator_instructions>

${trendSection(ctx)}

Rate for these platforms: ${input.platforms.map((p) => PLATFORMS[p].label).join(', ')}.

Return:
- criteria: a 0-100 percentage for each of ${CRITERIA_KEYS.join(', ')}, plus a one-line reason for each (criteriaReasons, same keys).
- trendingPotential: 0-100, the chance this can break out beyond the creator's followers right now, considering the live trend data.
- platformPotential: for each platform key (${input.platforms.join(', ')}): potential 0-100 and the main reason.
- verdict: 2 sentences, plain words.
- strengths: 3-6 items. Each: point (specific, refers to what you see) and impact (high/medium/low).
- weaknesses: 2-6 specific items.
- improvements: 4-8 items, biggest gain first. Each: action (exact edit to make), criterion (one of the criteria keys), estimatedGain (whole percentage points this could add to that criterion, honest estimate), why.
- projectedScore: the overall percentage you expect after applying all improvements.
- trendMatches: the current trends/formats this material could ride and how (source name or "evergreen").`;
  },

  schema(input) {
    const keyed = (shape) => obj(Object.fromEntries(CRITERIA_KEYS.map((k) => [k, shape])));
    return obj({
      criteria: keyed(int),
      criteriaReasons: keyed(str),
      trendingPotential: int,
      platformPotential: obj(Object.fromEntries(input.platforms.map((p) => [p, obj({ potential: int, reason: str })]))),
      verdict: str,
      strengths: arr(obj({ point: str, impact: str })),
      weaknesses: arr(str),
      improvements: arr(obj({ action: str, criterion: str, estimatedGain: int, why: str })),
      projectedScore: int,
      trendMatches: arr(obj({ trend: str, source: str, howToUse: str })),
    });
  },

  postprocess(data, input) {
    const rawCriteria = v.asObject(data.criteria);
    const reasons = v.asObject(data.criteriaReasons);
    const criteria = Object.fromEntries(CRITERIA_KEYS.map((k) => [k, v.clampInt(rawCriteria[k], 0, 100)]));
    const strength = mean(STRENGTH_KEYS.map((k) => criteria[k]));
    const trendingPotential = v.clampInt(data.trendingPotential, 0, 100) ?? mean([criteria.trendAlignment, criteria.shareability, criteria.hook]);
    // Computed here, not by the model, so the headline number always matches its parts.
    const overall = strength == null && trendingPotential == null ? null : mean([strength, trendingPotential]);
    const rawProjected = v.clampInt(data.projectedScore, 0, 100);
    const projectedScore = overall == null ? rawProjected : Math.max(overall, rawProjected ?? overall);

    const rawPlatforms = v.asObject(data.platformPotential);
    const impactOrder = { high: 0, medium: 1, low: 2 };

    return {
      overall,
      grade: grade(overall),
      trendingPotential,
      strength,
      projectedScore,
      criteria: CRITERIA_KEYS.map((k) => ({ key: k, score: criteria[k], reason: v.asString(reasons[k]) })),
      platformPotential: input.platforms.map((p) => {
        const o = v.asObject(rawPlatforms[p]);
        return { platform: p, label: PLATFORMS[p].label, potential: v.clampInt(o.potential, 0, 100), reason: v.asString(o.reason) };
      }),
      verdict: v.asString(data.verdict),
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
          return {
            action: v.asString(o.action),
            criterion: CRITERIA_KEYS.includes(criterion) ? criterion : '',
            estimatedGain: v.clampInt(o.estimatedGain, 0, 100) ?? 0,
            why: v.asString(o.why),
          };
        })
        .filter((i) => i.action)
        .sort((a, b) => b.estimatedGain - a.estimatedGain),
      trendMatches: v.asArray(data.trendMatches)
        .map((t) => {
          const o = v.asObject(t);
          return { trend: v.asString(o.trend), source: v.asString(o.source), howToUse: v.asString(o.howToUse) };
        })
        .filter((t) => t.trend),
    };
  },
};
