import { AppError } from './errors.js';
import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, PLATFORMS } from './config.js';

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function text(value, field, maxLen = 4000) {
  if (value == null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new AppError(400, `"${field}" must be text.`);
  }
  const s = String(value).trim();
  if (s.length > maxLen) throw new AppError(400, `"${field}" is too long (max ${maxLen} characters).`);
  return s;
}

export function bool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export function intInRange(value, field, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError(400, `"${field}" must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

export function pickList(value, allowed, field, { min = 0, fallback = [] } = {}) {
  if (value == null) value = fallback;
  if (!Array.isArray(value)) throw new AppError(400, `"${field}" must be a list.`);
  const out = [];
  for (const v of value) {
    if (!allowed.includes(v)) throw new AppError(400, `Unknown ${field} value: "${String(v).slice(0, 40)}".`);
    if (!out.includes(v)) out.push(v);
  }
  if (out.length < min) throw new AppError(400, `Choose at least ${min} ${field}.`);
  return out;
}

export function images(value, max) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new AppError(400, '"images" must be a list.');
  if (value.length > max) {
    throw new AppError(400, `Too many images: this assistant accepts up to ${max} (video frames count as images).`);
  }
  return value.map((img, i) => {
    if (!img || typeof img !== 'object') throw new AppError(400, `Image ${i + 1} is invalid.`);
    const { mediaType, data } = img;
    if (!IMAGE_MEDIA_TYPES.includes(mediaType)) {
      throw new AppError(400, `Image ${i + 1} has unsupported type "${String(mediaType).slice(0, 30)}". Use JPEG, PNG, WebP or GIF.`);
    }
    if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
      throw new AppError(400, `Image ${i + 1} is not valid base64 data.`);
    }
    const bytes = (data.length * 3) / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) throw new AppError(400, `Image ${i + 1} is larger than 5 MB.`);
    return { mediaType, data, label: text(img.label, 'image label', 200) };
  });
}

export function profile(value) {
  const p = value && typeof value === 'object' ? value : {};
  return {
    niche: text(p.niche, 'niche', 200),
    audience: text(p.audience, 'audience', 300),
    tone: text(p.tone, 'tone', 200),
    language: text(p.language, 'language', 60) || 'English',
    brandWords: text(p.brandWords, 'brand words', 500),
    avoid: text(p.avoid, 'avoid', 500),
  };
}

export function geo(value) {
  const g = (typeof value === 'string' ? value : 'US').toUpperCase();
  if (!/^[A-Z]{2}$/.test(g)) throw new AppError(400, '"geo" must be a 2-letter country code like US, GB, IN.');
  return g;
}

export function platforms(value, min = 1) {
  return pickList(value, Object.keys(PLATFORMS), 'platforms', { min, fallback: Object.keys(PLATFORMS) });
}

export function profileBlock(p) {
  const lines = [
    p.niche && `Niche: ${p.niche}`,
    p.audience && `Target audience: ${p.audience}`,
    p.tone && `Brand voice / tone: ${p.tone}`,
    `Output language: ${p.language}`,
    p.brandWords && `Words/phrases to include when natural: ${p.brandWords}`,
    p.avoid && `Never use: ${p.avoid}`,
  ].filter(Boolean);
  return lines.join('\n');
}

// --- defensive readers for model output ---
export const asString = (v, fallback = '') => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : fallback);
export const asArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
export const asStrings = (v) => asArray(v).map((x) => asString(x)).filter(Boolean);
export const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
export function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

export function normalizeHashtags(list, max = Infinity) {
  const seen = new Set();
  const out = [];
  for (const raw of asStrings(list).flatMap((s) => s.split(/[\s,]+/))) {
    const body = raw.replace(/^#+/, '').replace(/[^\p{L}\p{M}\p{N}_]/gu, '');
    if (!body || /^\d+$/.test(body)) continue;
    const key = body.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${body}`);
    if (out.length >= max) break;
  }
  return out;
}

export const charLength = (s) => Array.from(s).length;

export function truncateWords(s, max) {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  if (max <= 1) return chars.slice(0, max).join('');
  const cut = chars.slice(0, max - 1).join('');
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}
