export type HookMemorySource = 'semantic' | 'keyword' | 'graduated' | 'episode' | 'lesson' | 'unknown';

export interface HookMemoryCandidate {
  type: string;
  content: string;
  id?: string;
  sessionId?: string;
  score?: number;
  source?: HookMemorySource;
  fallback?: boolean;
  memoryLevel?: string;
  accessCount?: number;
  retrievalRankScore?: number;
  /** Same-session evidence expanded from a relevant retrieval seed. */
  episodeLinked?: boolean;
  /** The episode was reached through a strongly aligned prompt/tool seed. */
  episodeSeedAligned?: boolean;
  /** Every distinctive identifier anchor and at least four lexical clues matched the seed. */
  episodeSeedStrongAligned?: boolean;
}

export interface HookInjectionPolicy {
  minScore: number;
  semanticMinScore: number;
  keywordMinScore: number;
  fallbackKeywordMinScore: number;
  /** Minimum adjacent-score drop used to retain an additional result. */
  scoreCliffGap: number;
  maxMemories: number;
}

const LOW_SIGNAL_QUERY_TERMS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'what', 'when', 'where', 'why', 'how',
  'please', 'help', 'need', 'using', 'use', 'fix', 'update', 'change', 'memory',
  '그리고', '그것', '그거', '이것', '이거', '해주세요', '해줘', '수정', '구현', '개선',
  '확인', '확인해줘', '확인해주세요', '방법', '관련', '내용', '문제', '원인', '작업', '진행', '계획', '훈련', '다음', '이번',
  '알려줘', '알려주', '알려', '정리해줘', '정리', '설명해줘', '설명', '요약해줘',
  '요약', '부탁', '대해', '무엇', '어떻', '어떻게', '있어', '다시',
  '최종', '결과', '핵심', '근거', '당시', '결론', '해결', '실제', '확인된', '결정', '사항',
  '뭐야', '뭐예요', '뭐였어', '뭐였어요'
]);

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
    scoreCliffGap: readNumber(env.CLAUDE_MEMORY_HOOK_SCORE_CLIFF_GAP, 0.08, { min: 0.01, max: 0.5 }),
    maxMemories: Math.max(1, Math.floor(readNumber(env.CLAUDE_MEMORY_HOOK_MAX_INJECTED, 5)))
  };
}

export function filterHookInjectableMemories(
  candidates: HookMemoryCandidate[],
  policy: HookInjectionPolicy = getHookInjectionPolicy(),
  query?: string
): HookMemoryCandidate[] {
  const ranked = rankHookCandidates(candidates, policy, query);
  const cliffBounded = query ? applyScoreCliff(ranked, policy.scoreCliffGap) : ranked;
  const bounded = cliffBounded.slice(0, policy.maxMemories).map(({ candidate }) => candidate);
  return query ? applyAnswerabilityGate(bounded, query) : bounded;
}

/** Select relevant seeds before episode expansion, without the final answerability gate. */
export function selectHookRetrievalSeeds(
  candidates: HookMemoryCandidate[],
  policy: HookInjectionPolicy = getHookInjectionPolicy(),
  query?: string
): HookMemoryCandidate[] {
  const ranked = rankHookCandidates(candidates, policy, query);
  const cliffBounded = query ? applyScoreCliff(ranked, policy.scoreCliffGap) : ranked;
  return cliffBounded.slice(0, policy.maxMemories).map(({ candidate }) => candidate);
}

/**
 * Select prompt/tool seeds independently from answer ranking. Exact prompts
 * otherwise lose to answer-type utility bonuses before episode expansion,
 * preventing the response from the same turn from ever becoming a candidate.
 */
export function selectHookEpisodeSeeds(
  candidates: HookMemoryCandidate[],
  policy: HookInjectionPolicy = getHookInjectionPolicy(),
  query: string
): HookMemoryCandidate[] {
  const queryTerms = meaningfulTerms(query);
  const queryAnchors = identifierAnchors(query);
  return candidates
    .filter((candidate) => candidate.type === 'user_prompt' || candidate.type === 'tool_observation')
    .filter((candidate) => hasQueryMemoryAlignment(query, candidate.content, 2))
    .map((candidate, index) => {
      const contentTerms = new Set(meaningfulTerms(candidate.content));
      const overlap = queryTerms.filter((term) => contentTerms.has(term)).length;
      const lowered = candidate.content.toLowerCase();
      const anchorCoverage = queryAnchors.length === 0
        ? 0
        : queryAnchors.filter((anchor) => lowered.includes(anchor.toLowerCase())).length / queryAnchors.length;
      const lexicalCoverage = overlap / Math.max(1, Math.min(queryTerms.length, 12));
      const score = candidate.score ?? 0;
      const normalThreshold = thresholdFor(candidate, policy);
      const hasDistinctiveAnchor = queryAnchors.some((anchor) =>
        anchor.length >= 6 && /[A-Za-z]/.test(anchor)
      );
      const fullyAnchored = queryAnchors.length > 0 && anchorCoverage === 1 && overlap >= 4 && hasDistinctiveAnchor;
      const usesStrongAnchorFloor = score < normalThreshold && fullyAnchored;
      return {
        candidate: {
          ...candidate,
          // Episode answers are filtered again by the normal semantic floor.
          // A fully anchored prompt that uses the lower seed-only floor needs
          // enough inherited score to compete there; counterfactual anchors
          // cannot take this path because their coverage is zero.
          score: usesStrongAnchorFloor ? Math.max(score, policy.semanticMinScore + 0.02) : score,
          episodeSeedAligned: true,
          episodeSeedStrongAligned: fullyAnchored
        },
        index,
        score: score + lexicalCoverage * 0.25 + anchorCoverage * 0.20,
        eligible: score >= normalThreshold || usesStrongAnchorFloor
      };
    })
    .filter((item) => item.eligible)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, policy.maxMemories)
    .map((item) => item.candidate);
}

function rankHookCandidates(
  candidates: HookMemoryCandidate[],
  policy: HookInjectionPolicy,
  query?: string
): Array<{ candidate: HookMemoryCandidate; index: number; effectiveScore: number }> {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => isHookInjectableMemory(candidate, policy))
    .filter(({ candidate }) => !query || (
      candidate.source === 'episode' && candidate.episodeLinked && candidate.episodeSeedAligned
    ) || hasQueryMemoryAlignment(query, candidate.content, 2))
    // The rule-based session-summary generator emits a table of contents
    // ("Session with N prompts. Topics discussed: ..."), not a result. The
    // graduated lane already excludes this via scoreGraduatedEvidence; the
    // semantic/keyword lanes must exclude it too or it keeps winning the
    // evidenceUtilityBonus('session_summary') = 0.12 slot on session_summary's
    // own high type bonus alone, with nothing answerable inside it.
    .filter(({ candidate }) =>
      candidate.type !== 'session_summary' || !isPromptOnlySessionSummary(candidate.content)
    )
    .map(({ candidate, index }) => ({
      candidate,
      index,
      effectiveScore: Math.max(0,
        (candidate.score ?? 0)
        + (query ? evidenceUtilityBonus(candidate.type, query) : 0)
        + (query ? graduatedEvidenceBonus(candidate) : 0)
        + (candidate.source === 'episode' && candidate.episodeLinked && candidate.episodeSeedStrongAligned
          ? 0.42
          : candidate.source === 'episode' && candidate.episodeLinked && candidate.episodeSeedAligned ? 0.12 : 0)
      )
    }))
    .sort((a, b) => {
      const scoreDelta = b.effectiveScore - a.effectiveScore;
      return scoreDelta || a.index - b.index;
    });
}

function applyScoreCliff(
  ranked: Array<{ candidate: HookMemoryCandidate; index: number; effectiveScore: number }>,
  minimumGap: number
): Array<{ candidate: HookMemoryCandidate; index: number; effectiveScore: number }> {
  if (ranked.length <= 1) return ranked;
  const effectiveMinimumGap = ranked[0].candidate.source === 'graduated'
    ? Math.min(minimumGap, 0.02)
    : minimumGap;
  for (let index = 1; index < ranked.length; index++) {
    const previous = ranked[index - 1].effectiveScore;
    const current = ranked[index].effectiveScore;
    if (previous - current >= effectiveMinimumGap) return ranked.slice(0, index);
  }
  // No clear relevance break: retain only the strongest result rather than
  // accumulating similarly scored but potentially unrelated context.
  return ranked.slice(0, 1);
}

function applyAnswerabilityGate(candidates: HookMemoryCandidate[], query: string): HookMemoryCandidate[] {
  const answerEvidence = candidates.filter((candidate) =>
    candidate.type === 'agent_response'
    || candidate.type === 'session_summary'
    || candidate.type === 'lesson'
  );
  if (answerEvidence.length > 0) {
    const toolEvidence = hasToolEvidenceIntent(query)
      ? candidates.filter((candidate) =>
        candidate.type === 'tool_observation' && toolEvidenceMatchesQueryAnchors(candidate, query)
      )
      : [];
    return [...answerEvidence, ...toolEvidence];
  }
  // No tool-only fallback. Injecting raw tool attempts because nothing better
  // survived ranking produced 131 traces whose memories were never used in an
  // answer (grounding 0.2%). Abstaining is cheaper than unusable context.
  return isContinuationQuery(query) ? candidates : [];
}

/**
 * A tool observation may only accompany an answer when the query's distinctive
 * identifiers actually occur in it. Queries without identifiers cannot be
 * verified this way, so they keep the intent-only behaviour.
 */
function toolEvidenceMatchesQueryAnchors(candidate: HookMemoryCandidate, query: string): boolean {
  const anchors = identifierAnchors(query);
  if (anchors.length === 0) return true;
  const lowered = candidate.content.toLowerCase();
  return anchors.some((anchor) => lowered.includes(anchor.toLowerCase()));
}

function hasToolEvidenceIntent(query: string): boolean {
  // "command", "log", and "output" are deliberately absent: <task-notification>
  // payloads embed <output-file>, which made nearly every notification look like
  // a tool-evidence request. Retrieval queries are also enriched with the
  // previous turn, so generic words match far beyond the current question.
  return /\b(?:kubectl|curl|psql|sql|stderr|stdout|traceback|stack\s*trace|exit\s*code)\b|(?:명령어|스택\s*트레이스|종료\s*코드|터미널)/iu
    .test(query);
}

function evidenceUtilityBonus(type: string, query: string): number {
  // Lessons are human-reviewed runbooks rather than transcript, so they outrank
  // every derived evidence type.
  if (type === 'lesson') return 0.16;
  if (type === 'session_summary') return 0.12;
  if (type === 'agent_response') return 0.10;
  // Tool observations only earn a slot when the question actually asks for tool
  // evidence; otherwise they are pushed below answer evidence instead of
  // consuming the bounded injection budget.
  if (type === 'tool_observation') return hasToolEvidenceIntent(query) ? 0.03 : -0.15;
  if (type === 'user_prompt') return -0.10;
  return 0;
}

function graduatedEvidenceBonus(candidate: HookMemoryCandidate): number {
  // scoreGraduatedEvidence already includes a bounded level/access prior.
  // Applying the level bonus again here can let a broad L2 answer outrank a
  // more exact L1 answer, so calibrated graduated candidates get no second
  // promotion boost.
  if (candidate.source === 'graduated') return 0;
  if (candidate.type !== 'agent_response' && candidate.type !== 'session_summary') return 0;
  if (candidate.memoryLevel === 'L4') return 0.10;
  if (candidate.memoryLevel === 'L3') return 0.08;
  if (candidate.memoryLevel === 'L2') return 0.06;
  if (candidate.memoryLevel === 'L1') return 0.03;
  return 0;
}

/**
 * Deterministic score for the L1+ answer lane.  It rewards query coverage and
 * exact identifier coverage; level/access are only small tie-breakers so a
 * frequently reused but wrong entity cannot win on graduation alone.
 */
export function scoreGraduatedEvidence(query: string, candidate: HookMemoryCandidate): number | null {
  if (candidate.type !== 'user_prompt' && candidate.type !== 'agent_response' && candidate.type !== 'session_summary') return null;
  if (!candidate.memoryLevel || candidate.memoryLevel === 'L0') return null;
  if (candidate.type === 'session_summary' && isPromptOnlySessionSummary(candidate.content)) return null;
  if (!hasQueryMemoryAlignment(query, candidate.content, 2)) return null;

  const queryTerms = meaningfulTerms(query);
  const contentTerms = new Set(meaningfulTerms(candidate.content));
  const overlap = queryTerms.filter((term) => contentTerms.has(term)).length;
  if (overlap < Math.min(3, queryTerms.length)) return null;
  const coverage = overlap / Math.max(1, Math.min(queryTerms.length, 8));
  const anchors = identifierAnchors(query);
  const lowered = candidate.content.toLowerCase();
  const matchedAnchors = anchors.filter((anchor) => lowered.includes(anchor.toLowerCase())).length;
  const anchorCoverage = anchors.length === 0 ? 0 : matchedAnchors / anchors.length;
  if (anchors.length >= 2 && matchedAnchors < Math.ceil(anchors.length * 0.6)) return null;
  if (candidate.type !== 'user_prompt' && isDiagnosticQuery(query) && !hasDiagnosticOutcome(candidate.content)) return null;

  const entities = entityAnchors(query);
  const matchedEntityPositions = entities
    .map((entity) => lowered.indexOf(entity))
    .filter((index) => index >= 0);
  const entityCoverage = entities.length === 0 ? 0 : matchedEntityPositions.length / entities.length;
  if (anchors.length > 0 && entities.length >= 2 && entityCoverage < 0.8) return null;
  const entityProximity = matchedEntityPositions.length < 2
    ? 0
    : 1 - Math.min(1,
      (Math.max(...matchedEntityPositions) - Math.min(...matchedEntityPositions)) / 2000
    );
  const levelPrior = candidate.memoryLevel === 'L4' ? 0.05
    : candidate.memoryLevel === 'L3' ? 0.045
      : candidate.memoryLevel === 'L2' ? 0.035
        : 0.015;
  const accessPrior = Math.min(0.02, Math.log2(Math.max(1, (candidate.accessCount ?? 0) + 1)) * 0.008);
  const rankPrior = Math.max(0, Math.min(1, candidate.retrievalRankScore ?? 0)) * 0.08;
  const base = candidate.type === 'user_prompt' ? 0.52 : 0.45;
  return Math.min(0.98,
    base
    + coverage * 0.20
    + anchorCoverage * 0.04
    + entityCoverage * 0.20
    + entityProximity * 0.10
    + rankPrior
    + levelPrior
    + accessPrior
  );
}

export interface LessonEvidenceInput {
  lessonId: string;
  name: string;
  trigger?: string;
  steps: string[];
  failureModes?: string[];
  confidence: number;
}

/**
 * Render a curated lesson as injectable evidence, scored by query coverage.
 *
 * Lessons live outside the events table, so they reach the prompt only through
 * this lane. The score stays lexical and deterministic for the same reason the
 * graduated lane does: a reviewed runbook must not outrank exact evidence just
 * for being curated, so confidence is only a small tie-breaker.
 */
export function scoreLessonEvidence(
  query: string,
  lesson: LessonEvidenceInput
): HookMemoryCandidate | null {
  const content = formatLessonContent(lesson);
  if (!hasQueryMemoryAlignment(query, content, 2)) return null;

  const queryTerms = meaningfulTerms(query);
  const contentTerms = new Set(meaningfulTerms(content));
  const overlap = queryTerms.filter((term) => contentTerms.has(term)).length;
  if (overlap < Math.min(3, queryTerms.length)) return null;

  const coverage = overlap / Math.max(1, Math.min(queryTerms.length, 8));
  const anchors = identifierAnchors(query);
  const lowered = content.toLowerCase();
  const matchedAnchors = anchors.filter((anchor) => lowered.includes(anchor.toLowerCase())).length;
  const anchorCoverage = anchors.length === 0 ? 0 : matchedAnchors / anchors.length;
  if (anchors.length >= 2 && matchedAnchors < Math.ceil(anchors.length * 0.6)) return null;

  const confidencePrior = Math.min(0.05, Math.max(0, lesson.confidence) * 0.05);
  const score = Math.min(0.98, 0.5 + coverage * 0.28 + anchorCoverage * 0.12 + confidencePrior);

  return {
    id: lesson.lessonId,
    type: 'lesson',
    content,
    score,
    source: 'lesson'
  };
}

function formatLessonContent(lesson: LessonEvidenceInput): string {
  const parts = [lesson.name];
  if (lesson.trigger) parts.push(`적용 시점: ${lesson.trigger}`);
  if (lesson.steps.length > 0) {
    parts.push(lesson.steps.slice(0, 8).map((step) => `- ${step}`).join('\n'));
  }
  if (lesson.failureModes && lesson.failureModes.length > 0) {
    parts.push(`주의: ${lesson.failureModes.slice(0, 4).join(' / ')}`);
  }
  return parts.join('\n');
}

function isPromptOnlySessionSummary(content: string): boolean {
  return /Session with \d+ user prompts?|Topics discussed:|\[\d{4}-\d{2}-\d{2}\].*주요 작업:/iu.test(content);
}

function isDiagnosticQuery(query: string): boolean {
  return /(?:원인|왜|실패|오류|에러|장애|CrashLoopBackOff)|\b(?:cause|failure|failed|error|incident|diagnos)/iu.test(query);
}

function hasDiagnosticOutcome(content: string): boolean {
  return /(?:원인|근본|때문|불일치|실패|오류|예외|해결|조치|리밋|한도)|\b(?:cause|because|failure|failed|error|exception|mismatch|resolved|fix)/iu.test(content);
}

function entityAnchors(value: string): string[] {
  return Array.from(new Set(
    (value.match(/[A-Za-z][A-Za-z0-9_./:-]*/g) ?? [])
      .map((term) => term.toLowerCase())
      .filter((term) => term.length >= 2 && !LOW_SIGNAL_QUERY_TERMS.has(term))
  ));
}

function isContinuationQuery(query: string): boolean {
  return /Previous user:|Previous assistant:|\b(?:continue|resume|carry on|pick up)\b|(?:이어서|계속|그거|아까|지난번)/iu.test(query);
}

function hasQueryMemoryAlignment(query: string, content: string, minimumOverlap: number = 2): boolean {
  const queryTerms = meaningfulTerms(query);
  // Short follow-ups are resolved through session context; requiring a lexical
  // overlap there would suppress legitimate "fix it" continuations.
  if (queryTerms.length < 2) return true;
  const contentTerms = new Set(meaningfulTerms(content));
  const requiredAnchors = identifierAnchors(query);
  const normalizedContent = content.toLowerCase();
  if (requiredAnchors.length > 0 && !requiredAnchors.some((anchor) => normalizedContent.includes(anchor.toLowerCase()))) {
    return false;
  }
  // A single overlap is often a generic verb that escaped tokenization (for
  // example, "알려줘"). Requiring two strong terms makes this an intentional
  // no-match gate instead of a weak semantic-score tie breaker.
  // Question boilerplate is removed by meaningfulTerms. This matters for
  // short queries: "대기" plus "어떻게" previously looked like two strong
  // overlaps between an astronomy question and an unrelated CI incident.
  return queryTerms.filter((term) => contentTerms.has(term)).length >= minimumOverlap;
}

function identifierAnchors(value: string): string[] {
  return (value.match(/[A-Za-z0-9_./:-]+/g) ?? [])
    .filter((term) => /[A-Za-z0-9]/.test(term) && term.length >= 2)
    .filter((term) => /\d|[_./:-]/.test(term))
    .filter((term) => !/^\d{1,2}$/.test(term));
}

function meaningfulTerms(value: string): string[] {
  return Array.from(new Set(
    (value.toLowerCase().match(/[a-z0-9가-힣]+/g) ?? [])
      .map(normalizeTerm)
      .filter((term) => term.length >= 2 && !LOW_SIGNAL_QUERY_TERMS.has(term))
  ));
}

function normalizeTerm(value: string): string {
  return value.replace(/(?:은|는|이|가|을|를|에|의|와|과|도|으로|에서|에게|한테)$/u, '');
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
  if (
    candidate.source === 'semantic'
    || candidate.source === 'graduated'
    || candidate.source === 'episode'
    || candidate.source === 'lesson'
  ) {
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
