import { RATIOS } from './config.js';

// Format a prompt for the image AI the creator uses.
export function modelReady(prompt, negative, ratio, target) {
  const p = (prompt || '').trim().replace(/\s+/g, ' ');
  const n = (negative || '').trim().replace(/\s+/g, ' ');
  const size = RATIOS[ratio]?.size;
  switch (target) {
    case 'midjourney':
      return `${p.replace(/\s*--\w+[^-]*/g, '').trim()} --ar ${ratio}${n ? ` --no ${n}` : ''}`;
    case 'flux':
      // FLUX ignores negative prompts; describe what you want instead.
      return `${p}\n\nAspect ratio: ${ratio}${size ? ` (${size})` : ''}`;
    case 'sdxl':
    case 'leonardo':
      return `Prompt: ${p}\nNegative prompt: ${n || 'none'}\nAspect ratio: ${ratio}${size ? ` (${size})` : ''}`;
    case 'dalle':
    case 'ideogram':
    case 'firefly':
      return `${p} Aspect ratio ${ratio}.${n ? ` Avoid: ${n}.` : ''}`;
    default:
      return `${p}\n\nNegative prompt: ${n || 'none'}\nAspect ratio: ${ratio}${size ? ` (${size})` : ''}`;
  }
}
