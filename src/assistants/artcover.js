import { COVER_STYLES, IMAGE_MODELS, RATIOS } from '../config.js';
import * as v from '../util.js';
import { arr, obj, str } from '../schema.js';
import { CORE_RULES } from './shared.js';
import { AppError } from '../errors.js';
import { modelReady } from '../promptFormat.js';

const FORMATS = [
  { ratio: '1:1', useCase: 'Main cover for Spotify, Apple Music, YouTube Music, SoundCloud (export 3000×3000)' },
  { ratio: '9:16', useCase: 'Spotify Canvas still / Reels / Stories / TikTok promo' },
  { ratio: '16:9', useCase: 'YouTube visualizer / lyric video background' },
];

export const artcover = {
  id: 'artcover',
  maxImages: 5,
  system: `${CORE_RULES}

Your job: be an award-winning album-art director and image-AI prompt engineer. Distill the creator's reference images and track details into a cohesive visual identity and write prompts that produce a cover which (1) reads instantly at thumbnail size in a streaming app, (2) matches the genre's visual language while standing out, and (3) feels like the sound of the track.

When analyzing references, extract the shared DNA: palette, lighting, texture/medium, composition, era, mood, typography. Do not copy any reference 1:1 and never reproduce copyrighted characters, logos or a real artist's likeness unless it is the creator's own photo.

Streaming-platform rules to respect: square 1:1 main cover at 3000×3000 px; no URLs, social handles, prices, or platform logos on the cover; no explicit/graphic imagery; any text must match the release metadata and stay legible when shrunk.`,

  normalize(body) {
    const t = body.track && typeof body.track === 'object' ? body.track : {};
    const input = {
      images: v.images(body.images, artcover.maxImages),
      track: {
        title: v.text(t.title, 'track title', 200),
        artist: v.text(t.artist, 'artist', 200),
        genre: v.text(t.genre, 'genre', 200),
        mood: v.text(t.mood, 'mood', 300),
        themes: v.text(t.themes, 'themes / lyrics', 3000),
      },
      instructions: v.text(body.instructions, 'instructions', 4000),
      styles: v.pickList(body.styles, COVER_STYLES, 'styles'),
      includeText: v.bool(body.includeText, false),
      targetModel: Object.keys(IMAGE_MODELS).includes(body.targetModel) ? body.targetModel : 'generic',
      profile: v.profile(body.profile),
      useLiveTrends: false,
      webSearch: false,
    };
    if (!input.images.length && !input.track.title && !input.track.genre && !input.track.mood && !input.instructions) {
      throw new AppError(400, 'Add up to 5 reference pictures and/or the track details (title, genre, mood).');
    }
    return input;
  },

  buildPrompt(input) {
    const t = input.track;
    return `<references>
${input.images.length ? `${input.images.length} reference image(s) attached (max 5).` : 'No reference images: build the identity from the track details.'}
</references>

<track>
Title: ${t.title || '(untitled)'}
Artist: ${t.artist || '(not given)'}
Genre: ${t.genre || '(not given)'}
Mood / energy: ${t.mood || '(not given)'}
Themes / lyrics excerpt: ${t.themes || '(not given)'}
</track>

<creator_instructions>
${input.instructions || '(none: create the most striking cover for this track)'}
</creator_instructions>

Preferred styles: ${input.styles.length ? input.styles.join(', ') : 'choose the best fit for the genre and references'}.
Text on the cover: ${input.includeText ? `yes: render "${t.title || 'TITLE'}"${t.artist ? ` and "${t.artist}"` : ''} in the image, exact spelling in quotes` : 'no: leave clean space for typography to be added later in an editor'}.
Target image AI: ${IMAGE_MODELS[input.targetModel]}.

Deliver:
- referenceAnalysis: commonThemes, palette (hex codes), lighting, composition, mood.
- concept: the visual idea and why it fits the sound (2-3 sentences).
- masterPrompt: the definitive 1:1 cover prompt, 80-160 words.
- negativePrompt: comma-separated.
- variations: 3 alternative directions (name, style, full prompt), each clearly different.
- formats: one prompt per format, re-composed for the shape: ${FORMATS.map((f) => `${f.ratio} (${f.useCase})`).join('; ')}.
- typography: titleFont suggestion, placement, treatment.
- complianceNotes: anything to check before uploading to a distributor.`;
  },

  schema() {
    return obj({
      referenceAnalysis: obj({ commonThemes: arr(str), palette: arr(str), lighting: str, composition: str, mood: str }),
      concept: str,
      masterPrompt: str,
      negativePrompt: str,
      variations: arr(obj({ name: str, style: str, prompt: str })),
      formats: arr(obj({ ratio: str, useCase: str, prompt: str })),
      typography: obj({ titleFont: str, placement: str, treatment: str }),
      complianceNotes: arr(str),
    });
  },

  postprocess(data, input) {
    const ra = v.asObject(data.referenceAnalysis);
    const typo = v.asObject(data.typography);
    const negativePrompt = v.asString(data.negativePrompt);
    const masterPrompt = v.asString(data.masterPrompt);
    const fmtByRatio = new Map(v.asArray(data.formats).map((f) => [v.asString(v.asObject(f).ratio).replace(/\s/g, ''), v.asObject(f)]));
    return {
      referenceAnalysis: {
        commonThemes: v.asStrings(ra.commonThemes),
        palette: v.asStrings(ra.palette),
        lighting: v.asString(ra.lighting),
        composition: v.asString(ra.composition),
        mood: v.asString(ra.mood),
      },
      concept: v.asString(data.concept),
      targetModel: IMAGE_MODELS[input.targetModel],
      masterPrompt,
      negativePrompt,
      masterModelReady: modelReady(masterPrompt, negativePrompt, '1:1', input.targetModel),
      variations: v.asArray(data.variations)
        .map((x) => {
          const o = v.asObject(x);
          const prompt = v.asString(o.prompt);
          return { name: v.asString(o.name), style: v.asString(o.style), prompt, modelReady: modelReady(prompt, negativePrompt, '1:1', input.targetModel) };
        })
        .filter((x) => x.prompt),
      formats: FORMATS.map((f) => {
        const o = fmtByRatio.get(f.ratio);
        const prompt = o ? v.asString(o.prompt) : '';
        return prompt
          ? { ratio: f.ratio, size: f.ratio === '1:1' ? '3000×3000' : RATIOS[f.ratio].size, useCase: f.useCase, prompt, modelReady: modelReady(prompt, negativePrompt, f.ratio, input.targetModel) }
          : null;
      }).filter(Boolean),
      typography: { titleFont: v.asString(typo.titleFont), placement: v.asString(typo.placement), treatment: v.asString(typo.treatment) },
      complianceNotes: v.asStrings(data.complianceNotes),
    };
  },
};
