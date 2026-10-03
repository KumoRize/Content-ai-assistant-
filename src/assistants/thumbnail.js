import { IMAGE_MODELS, RATIOS, THUMBNAIL_STYLES } from '../config.js';
import * as v from '../util.js';
import { arr, obj, str } from '../schema.js';
import { CORE_RULES, materialSection } from './shared.js';
import { AppError } from '../errors.js';
import { modelReady } from '../promptFormat.js';

export const thumbnail = {
  id: 'thumbnail',
  maxImages: 8,
  system: `${CORE_RULES}

Your job: be a world-class thumbnail designer and image-AI prompt engineer. Study the creator's material, find the single most click-worthy visual idea, then write production-grade image-generation prompts for every requested aspect ratio, re-composing the layout for each ratio (never just "crop").

Thumbnail principles you apply: one focal subject, readable at phone size, strong emotion on faces, high contrast and complementary colors, 3-5 words of text maximum, curiosity gap with the title, clean negative space for text, rule of thirds, keep key elements out of platform UI zones (bottom-right timestamp on YouTube; top/bottom bars and right-side buttons on 9:16).

A great image prompt names: subject + action/expression, composition & camera (shot type, lens, angle), lighting, color palette, background, style/medium, mood, quality descriptors, and where text space goes. If the creator wants text rendered in the image, put the exact words in quotes.`,

  normalize(body) {
    const input = {
      images: v.images(body.images, thumbnail.maxImages),
      context: v.text(body.context, 'context', 4000),
      title: v.text(body.title, 'title', 200),
      instructions: v.text(body.instructions, 'instructions', 4000),
      textOverlay: v.text(body.textOverlay, 'textOverlay', 100),
      ratios: v.pickList(body.ratios, Object.keys(RATIOS), 'ratios', { min: 1, fallback: ['16:9', '9:16', '1:1'] }),
      styles: v.pickList(body.styles, THUMBNAIL_STYLES, 'styles'),
      targetModel: Object.keys(IMAGE_MODELS).includes(body.targetModel) ? body.targetModel : 'generic',
      profile: v.profile(body.profile),
      useLiveTrends: false,
      webSearch: false,
    };
    if (!input.images.length && !input.context && !input.title) {
      throw new AppError(400, 'Upload your video/image or describe the content and title.');
    }
    return input;
  },

  buildPrompt(input) {
    const ratioLines = input.ratios.map((r) => `- ${r}: ${RATIOS[r].useCase}, ${RATIOS[r].size}`).join('\n');
    return `<material>
${materialSection(input)}
${input.title ? `Video/post title: ${input.title}` : ''}
</material>

<creator_profile>
${v.profileBlock(input.profile)}
</creator_profile>

<creator_instructions>
${input.instructions || '(none: maximize click-through rate)'}
</creator_instructions>

Preferred styles: ${input.styles.length ? input.styles.join(', ') : 'choose what will get the highest CTR for this niche'}.
Text on thumbnail: ${input.textOverlay ? `"${input.textOverlay}"` : 'suggest 2-4 punchy words'}.
Target image AI: ${IMAGE_MODELS[input.targetModel]}. Write prompts in natural, vivid English that this tool understands best.${input.images.length ? ' Describe the real person/subject from the material precisely (appearance, clothing, hair, colors) so the generated image matches; the creator can also use the original photo as an image reference.' : ''}

Write one variant for EACH of these ratios, with the layout re-composed for that shape:
${ratioLines}

For each variant: ratio (exactly as listed), useCase, prompt (detailed, 60-140 words), negativePrompt (comma-separated things to avoid: blurry, extra fingers, distorted text, watermark, etc.), composition (where subject, text and empty space sit), textOverlay (words + font/color/stroke suggestion), colorPalette (3-5 hex codes).
Also give: contentAnalysis, concept (the core click idea), styleNotes, abTestIdeas (2-3 alternative concepts to test).`;
  },

  schema() {
    return obj({
      contentAnalysis: obj({ subject: str, emotion: str, keyVisual: str, colorPalette: arr(str) }),
      concept: str,
      variants: arr(obj({ ratio: str, useCase: str, prompt: str, negativePrompt: str, composition: str, textOverlay: str, colorPalette: arr(str) })),
      styleNotes: arr(str),
      abTestIdeas: arr(str),
    });
  },

  postprocess(data, input) {
    const byRatio = new Map();
    for (const raw of v.asArray(data.variants)) {
      const o = v.asObject(raw);
      const ratio = v.asString(o.ratio).replace(/\s/g, '');
      if (input.ratios.includes(ratio) && !byRatio.has(ratio)) byRatio.set(ratio, o);
    }
    const warnings = [];
    const variants = input.ratios.map((ratio) => {
      const o = byRatio.get(ratio);
      if (!o) {
        warnings.push(`No prompt was returned for ${ratio}. Generate again to fill it in.`);
        return null;
      }
      const prompt = v.asString(o.prompt);
      const negativePrompt = v.asString(o.negativePrompt);
      return {
        ratio,
        size: RATIOS[ratio].size,
        useCase: v.asString(o.useCase) || RATIOS[ratio].useCase,
        prompt,
        negativePrompt,
        composition: v.asString(o.composition),
        textOverlay: v.asString(o.textOverlay),
        colorPalette: v.asStrings(o.colorPalette),
        modelReady: modelReady(prompt, negativePrompt, ratio, input.targetModel),
      };
    }).filter(Boolean);
    const ca = v.asObject(data.contentAnalysis);
    return {
      contentAnalysis: { subject: v.asString(ca.subject), emotion: v.asString(ca.emotion), keyVisual: v.asString(ca.keyVisual), colorPalette: v.asStrings(ca.colorPalette) },
      concept: v.asString(data.concept),
      targetModel: IMAGE_MODELS[input.targetModel],
      variants,
      styleNotes: v.asStrings(data.styleNotes),
      abTestIdeas: v.asStrings(data.abTestIdeas),
      warnings,
    };
  },
};
