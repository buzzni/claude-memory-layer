/**
 * Privacy-safe retrieval lane metadata helpers.
 *
 * Lane details are intended for trace/debug surfaces. Keep them compact,
 * allow-listed, and free of raw private paths or credential-shaped values.
 */

export const RETRIEVAL_DEBUG_LANE_NAMES = [
  'raw_event',
  'session_summary',
  'graph_path',
  'facet_match'
] as const;

export type RetrievalDebugLaneName = typeof RETRIEVAL_DEBUG_LANE_NAMES[number];

export interface RetrievalDebugLane {
  lane: RetrievalDebugLaneName;
  reason: string;
  score?: number;
}

const RETRIEVAL_DEBUG_LANE_NAME_SET = new Set<string>(RETRIEVAL_DEBUG_LANE_NAMES);

export function isRetrievalDebugLaneName(value: unknown): value is RetrievalDebugLaneName {
  return typeof value === 'string' && RETRIEVAL_DEBUG_LANE_NAME_SET.has(value);
}

export function normalizeRetrievalDebugLanes(value: unknown, maxItems = 6): RetrievalDebugLane[] {
  if (!Array.isArray(value) || maxItems <= 0) return [];

  const normalized: RetrievalDebugLane[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const lane = normalizeRetrievalDebugLane(item);
    if (!lane) continue;
    const key = [lane.lane, lane.reason, lane.score ?? ''].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(lane);
    if (normalized.length >= maxItems) break;
  }
  return normalized;
}

export function normalizeRetrievalDebugLane(value: unknown): RetrievalDebugLane | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!isRetrievalDebugLaneName(raw.lane)) return null;

  const reason = sanitizeRetrievalLaneReason(typeof raw.reason === 'string' ? raw.reason : '') || 'unspecified';
  const score = typeof raw.score === 'number' && Number.isFinite(raw.score)
    ? Math.max(0, Math.min(1, raw.score))
    : undefined;

  return score === undefined
    ? { lane: raw.lane, reason }
    : { lane: raw.lane, reason, score };
}

export function sanitizeRetrievalLaneReason(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[A-Za-z]:[\\/][^\s'"`<>)]*/g, '[path]')
    .replace(/\/(?:Users|home|tmp|var\/folders)\/[^\s'"`<>)]*/g, '[path]')
    .replace(/\\\\[^\s'"`<>)]*/g, '[path]')
    .replace(/\bBearer\s+[^\s'"`,;]{6,}/gi, 'Bearer [REDACTED]')
    .replace(
      /(["']?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|credential)["']?\s*[:=]\s*["']?)[^\s"'`,;}]{6,}/gi,
      '$1[REDACTED]'
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|xox[a-z]-[A-Za-z0-9-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{12,}|AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]+|sk-[A-Za-z0-9_-]{12,})\b/g,
      '[REDACTED]'
    )
    .slice(0, 120);
}
