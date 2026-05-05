export type HookMemorySource = 'semantic' | 'keyword' | 'unknown';

export interface HookMemoryCandidate {
  type: string;
  content: string;
  id?: string;
  score?: number;
  source?: HookMemorySource;
  fallback?: boolean;
}

export interface HookInjectionPolicy {
  minScore: number;
  semanticMinScore: number;
  keywordMinScore: number;
  fallbackKeywordMinScore: number;
  maxMemories: number;
}

export function getHookInjectionPolicy(env: NodeJS.ProcessEnv = process.env): HookInjectionPolicy {
  const minScore = readScoreThreshold(env.CLAUDE_MEMORY_HOOK_INJECTION_MIN_SCORE, 0.65);
  const keywordMinScore = readNumber(
    env.CLAUDE_MEMORY_HOOK_KEYWORD_MIN_SCORE,
    Math.max(minScore, 0.7),
    { min: 0, max: 1 }
  );

  return {
    minScore,
    semanticMinScore: readScoreThreshold(env.CLAUDE_MEMORY_HOOK_SEMANTIC_MIN_SCORE, minScore),
    keywordMinScore,
    fallbackKeywordMinScore: readNumber(
      env.CLAUDE_MEMORY_HOOK_FALLBACK_KEYWORD_MIN_SCORE,
      Math.max(keywordMinScore, 0.8),
      { min: 0, max: 1 }
    ),
    maxMemories: Math.max(1, Math.floor(readNumber(env.CLAUDE_MEMORY_HOOK_MAX_INJECTED, 5)))
  };
}

export function filterHookInjectableMemories(
  candidates: HookMemoryCandidate[],
  policy: HookInjectionPolicy = getHookInjectionPolicy()
): HookMemoryCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => isHookInjectableMemory(candidate, policy))
    .sort((a, b) => {
      const scoreDelta = (b.candidate.score ?? Number.NEGATIVE_INFINITY)
        - (a.candidate.score ?? Number.NEGATIVE_INFINITY);
      return scoreDelta || a.index - b.index;
    })
    .slice(0, policy.maxMemories)
    .map(({ candidate }) => candidate);
}

export function summarizeHookInjectionConfidence(candidates: HookMemoryCandidate[]): 'none' | 'medium' | 'high' {
  const scores = candidates
    .map((candidate) => candidate.score)
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
  if (scores.length === 0) return 'none';

  const maxScore = Math.max(...scores);
  if (maxScore >= 0.8) return 'high';
  if (maxScore >= 0.65) return 'medium';
  return 'none';
}

function isHookInjectableMemory(candidate: HookMemoryCandidate, policy: HookInjectionPolicy): boolean {
  if (typeof candidate.score !== 'number' || !Number.isFinite(candidate.score)) {
    return false;
  }

  return candidate.score >= thresholdFor(candidate, policy);
}

function thresholdFor(candidate: HookMemoryCandidate, policy: HookInjectionPolicy): number {
  if (candidate.source === 'keyword') {
    return candidate.fallback
      ? policy.fallbackKeywordMinScore
      : policy.keywordMinScore;
  }
  if (candidate.source === 'semantic') {
    return policy.semanticMinScore;
  }
  return policy.minScore;
}

function readScoreThreshold(value: string | undefined, fallback: number): number {
  return readNumber(value, fallback, { min: 0, max: 1 });
}

function readNumber(
  value: string | undefined,
  fallback: number,
  bounds?: { min?: number; max?: number }
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (bounds?.min !== undefined && parsed < bounds.min) return fallback;
  if (bounds?.max !== undefined && parsed > bounds.max) return fallback;
  return parsed;
}
