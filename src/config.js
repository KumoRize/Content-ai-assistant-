// Platform rules. `hashtagMax` is the cap this app enforces (conservative on purpose:
// fewer hashtags never gets a post rejected). `captionMax` is the platform's hard limit.
export const PLATFORMS = {
  youtube: {
    label: 'YouTube',
    titleMax: 100,
    captionMax: 5000,
    hashtagMax: 15,
    tagsCharMax: 500,
    guidance:
      'Title max 100 chars, keep the core idea in the first ~60 so it is not truncated. Description: the first ~150 chars show in search, so front-load the main keyword. Hashtags: 3-5 is ideal (the first 3 appear above the title); more than 15 makes YouTube ignore all of them. Keywords go to the Tags field (max 500 chars total). For Shorts, a punchy title and 1-3 hashtags.',
  },
  instagram: {
    label: 'Instagram',
    captionMax: 2200,
    hashtagMax: 5,
    guidance:
      'Caption max 2,200 chars; only the first ~125 chars show before "more", so open with the hook. Instagram search now leans on keywords in the caption (SEO-style), so weave 2-4 searchable keyword phrases into natural sentences. Use 3-5 highly relevant hashtags (Instagram has moved to capping hashtags at a handful per post). Line breaks for readability, 1-3 emojis max unless the tone calls for more.',
  },
  threads: {
    label: 'Threads',
    captionMax: 500,
    hashtagMax: 1,
    guidance:
      'Post max 500 chars. Threads supports ONE topic tag per post, so give exactly one hashtag (the topic). Conversational, opinionated, ends with a question to drive replies.',
  },
  x: {
    label: 'X (Twitter)',
    captionMax: 280,
    hashtagMax: 2,
    guidance:
      'Standard accounts: 280 chars INCLUDING hashtags (emojis count as 2). 1-2 hashtags max; more reduces engagement. Strong first line, no fluff, curiosity gap or bold claim.',
  },
  tiktok: {
    label: 'TikTok',
    captionMax: 4000,
    hashtagMax: 6,
    guidance:
      'Caption up to 4,000 chars but the first line is what people read; TikTok search indexes caption words, so include the exact phrases people search. 3-6 hashtags mixing 1-2 broad + niche + trend tags. Also suggest the on-screen text hook for the first 2 seconds.',
  },
  facebook: {
    label: 'Facebook',
    captionMax: 63206,
    hashtagMax: 3,
    guidance:
      'Keep it to 1-3 short paragraphs; the first ~80 chars matter most. 1-3 hashtags at most. Story-driven, community tone, ask a question or prompt shares/tags.',
  },
};

export const RATIOS = {
  '16:9': { useCase: 'YouTube thumbnail / landscape video / Facebook link', size: '1280×720 (or 1920×1080)' },
  '9:16': { useCase: 'Shorts, Reels, TikTok cover, Stories', size: '1080×1920' },
  '1:1': { useCase: 'Square feed post, X/Threads image, album-style', size: '1080×1080' },
  '4:5': { useCase: 'Instagram & Facebook portrait feed', size: '1080×1350' },
  '3:4': { useCase: 'Instagram profile grid crop', size: '1080×1440' },
  '4:3': { useCase: 'Classic landscape, blog header', size: '1440×1080' },
  '2:3': { useCase: 'Pinterest pin, poster', size: '1000×1500' },
  '21:9': { useCase: 'Cinematic banner, YouTube channel art band', size: '2560×1097' },
};

export const IMAGE_MODELS = {
  generic: 'Generic (any image AI)',
  midjourney: 'Midjourney',
  flux: 'FLUX',
  sdxl: 'Stable Diffusion / SDXL',
  dalle: 'ChatGPT / DALL·E / GPT-Image',
  ideogram: 'Ideogram (best for text)',
  leonardo: 'Leonardo',
  firefly: 'Adobe Firefly',
};

export const THUMBNAIL_STYLES = [
  'MrBeast-style high energy',
  'Minimal clean',
  'Cinematic',
  'Bold text-first',
  'Shocked face reaction',
  'Before / after split',
  'Documentary / mysterious',
  'Anime / illustrated',
  '3D render',
  'Retro / vintage',
  'Luxury / premium',
  'Gaming neon',
];

export const COVER_STYLES = [
  'Photorealistic',
  'Surreal / dreamlike',
  'Minimal typographic',
  'Dark / moody',
  'Vaporwave / retro',
  'Anime / illustrated',
  'Abstract 3D',
  'Film grain analog',
  'Graffiti / street',
  'Collage / mixed media',
  'Y2K chrome',
  'Hand-painted oil',
];

export const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
// Claude's per-image limit is 5 MB; the browser downsizes images well below this.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
