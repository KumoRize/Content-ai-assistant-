import { PLATFORMS } from '../config.js';
import * as v from '../util.js';
import { arr, obj, str } from '../schema.js';
import { CORE_RULES, trendSection } from './shared.js';
import { AppError } from '../errors.js';

export const ideas = {
  id: 'ideas',
  maxImages: 4,
  system: `${CORE_RULES}

Your job: turn a simple prompt into high-potential content ideas. Every idea must be filmable by a solo creator, have a clear hook, a reason people will share or save it, and fit the platform's current culture. Avoid generic ideas ("day in my life", "top 5 tips") unless you give them a sharp, original twist.`,

  normalize(body) {
    const input = {
      prompt: v.text(body.prompt, 'prompt', 2000),
      images: v.images(body.images, ideas.maxImages),
      platforms: v.platforms(body.platforms),
      count: v.intInRange(body.count, 'count', 1, 15, 8),
      profile: v.profile(body.profile),
      geo: v.geo(body.geo),
      useLiveTrends: v.bool(body.useLiveTrends, true),
      webSearch: v.bool(body.webSearch, false),
    };
    if (!input.prompt) throw new AppError(400, 'Type a short prompt, e.g. "gym motivation for busy students".');
    return input;
  },

  buildPrompt(input, ctx) {
    return `Today is ${ctx.today}. Region: ${input.geo}.

<request>
${input.prompt}
</request>
${input.images.length ? `\n${input.images.length} reference image(s) attached for style/context.\n` : ''}
<creator_profile>
${v.profileBlock(input.profile)}
</creator_profile>

Target platforms: ${input.platforms.map((p) => PLATFORMS[p].label).join(', ')}.

${trendSection(ctx)}

Generate exactly ${input.count} distinct ideas, spread across the target platforms and across formats (talking head, POV, tutorial, skit, story, challenge, carousel, series...). Rank them best first. For each:
- title, platform (one of: ${input.platforms.join(', ')}), format
- hook: the exact first line / first 2 seconds
- concept: 2-3 sentences
- outline: 3-6 shot-by-shot or slide-by-slide steps
- whyItWillTrend: the psychological + algorithmic reason (shares, saves, comments, rewatch)
- trendTieIn: which live trend or format it rides (or "evergreen")
- hashtags: 3-6
- effort: low / medium / high
- cta
Also give postingStrategy: how to sequence these ideas over the next 2 weeks.`;
  },

  schema() {
    return obj({
      ideas: arr(obj({ title: str, platform: str, format: str, hook: str, concept: str, outline: arr(str), whyItWillTrend: str, trendTieIn: str, hashtags: arr(str), effort: str, cta: str })),
      postingStrategy: str,
    });
  },

  postprocess(data, input) {
    return {
      ideas: v.asArray(data.ideas)
        .map((i) => {
          const o = v.asObject(i);
          const platform = input.platforms.includes(v.asString(o.platform)) ? v.asString(o.platform) : input.platforms[0];
          return {
            title: v.asString(o.title),
            platform,
            format: v.asString(o.format),
            hook: v.asString(o.hook),
            concept: v.asString(o.concept),
            outline: v.asStrings(o.outline),
            whyItWillTrend: v.asString(o.whyItWillTrend),
            trendTieIn: v.asString(o.trendTieIn),
            hashtags: v.normalizeHashtags(o.hashtags, PLATFORMS[platform].hashtagMax),
            effort: v.asString(o.effort),
            cta: v.asString(o.cta),
          };
        })
        .filter((i) => i.title || i.concept)
        .slice(0, input.count),
      postingStrategy: v.asString(data.postingStrategy),
    };
  },
};
