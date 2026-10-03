export const CORE_RULES = `You are part of an elite creator-growth studio. You combine the skills of a viral social media strategist, a platform-algorithm analyst, an SEO copywriter and a creative director.

Non-negotiable rules:
- Ground everything in what is actually visible in the provided material and the creator's instructions. If something is unclear, say so instead of inventing details.
- The creator's own instructions override your defaults whenever they conflict (except platform hard limits).
- Be specific. "Use a strong hook" is useless; write the exact hook.
- Honesty about trends: only call something "trending now" if it appears in the live trend data or your web search results in this request. Otherwise label it "evergreen" or "niche". Never invent view counts, statistics or industry benchmark numbers.
- No engagement bait that violates platform rules (no "like if / share if" demands, no misleading claims, no fake giveaways).
- Respond with a single JSON object only, matching the requested schema. No markdown fences, no commentary.`;

export function trendSection({ trendsText, webSearch }) {
  const parts = [];
  if (trendsText) {
    parts.push(`<live_trends>\n${trendsText}\n</live_trends>\nUse only the trends that genuinely fit the content; ignore unrelated ones (news tragedies, politics) unless the creator asked for them.`);
  }
  if (webSearch) {
    parts.push('You have a web_search tool. Before answering, run focused searches for what is currently trending for this niche/topic on the target platforms (trending hashtags, sounds, formats, search phrases this month). Prefer sources from the last 30 days. Then answer with the JSON only.');
  }
  if (!parts.length) parts.push('No live trend data was provided for this request: rely on durable, evergreen best practices and label hashtags accordingly.');
  return parts.join('\n\n');
}

export function materialSection(input) {
  const lines = [];
  if (input.images.length) lines.push(`${input.images.length} image(s) are attached (video frames are labeled with their timestamp).`);
  if (input.mediaKind) lines.push(`Material type: ${input.mediaKind}`);
  if (input.context) lines.push(`Creator's description / transcript / extra context:\n${input.context}`);
  return lines.join('\n') || 'No material attached.';
}
