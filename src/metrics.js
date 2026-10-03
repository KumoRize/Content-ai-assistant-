const round = (n) => Math.round(n * 100) / 100;

export const METRIC_FIELDS = ['views', 'likes', 'comments', 'shares', 'saves', 'followers', 'avgWatchSeconds', 'durationSeconds'];

export function readMetrics(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const k of METRIC_FIELDS) {
    const v = src[k];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

// Deterministic metrics so the AI interprets real numbers instead of doing arithmetic.
export function computeMetrics(m) {
  const interactionKeys = ['likes', 'comments', 'shares', 'saves'].filter((k) => m[k] != null);
  const interactions = interactionKeys.length ? interactionKeys.reduce((sum, k) => sum + m[k], 0) : null;
  const pct = (num, den) => (num != null && den > 0 ? round((num / den) * 100) : null);
  return {
    interactions,
    engagementRateByViews: pct(interactions, m.views),
    engagementRateByFollowers: pct(interactions, m.followers),
    likeRate: pct(m.likes, m.views),
    commentRate: pct(m.comments, m.views),
    shareRate: pct(m.shares, m.views),
    saveRate: pct(m.saves, m.views),
    viewsPerFollower: m.views != null && m.followers > 0 ? round(m.views / m.followers) : null,
    avgPercentWatched:
      m.avgWatchSeconds != null && m.durationSeconds > 0 ? Math.min(100, pct(m.avgWatchSeconds, m.durationSeconds)) : null,
  };
}
