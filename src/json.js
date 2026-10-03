// Pull a JSON object out of a model reply. Handles raw JSON, ```json fences,
// and prose around the JSON (e.g. after web-search narration).
export function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const direct = tryParse(s);
  if (isObject(direct)) return direct;

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const fenced = tryParse(fence[1].trim());
    if (isObject(fenced)) return fenced;
  }

  let best = null;
  let bestLen = 0;
  for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
    const end = matchBrace(s, i);
    if (end === -1) continue;
    if (end - i + 1 <= bestLen) continue;
    const candidate = tryParse(s.slice(i, end + 1));
    if (isObject(candidate)) {
      best = candidate;
      bestLen = end - i + 1;
    }
  }
  return best;
}

function matchBrace(s, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
