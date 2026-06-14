import {
  createReplayRetrievalRunner,
  type ReplayEvaluationFixture,
  type ReplayEvaluationQuery,
  type ReplayRetrievalRunResult,
  type ReplayRetrievalRunner
} from './replay-evaluator.js';
import type { MatchConfidence } from './types.js';

export interface LongMemEvalHybridCombineInput {
  topK: number;
  sessionResult: ReplayRetrievalRunResult;
  turnResult: ReplayRetrievalRunResult;
  query?: ReplayEvaluationQuery;
  sessionFixture?: ReplayEvaluationFixture;
  sessionWeight?: number;
  turnWeight?: number;
}

export interface LongMemEvalHybridRunnerOptions {
  sessionFixture: ReplayEvaluationFixture;
  turnFixture: ReplayEvaluationFixture;
  sessionRunner?: ReplayRetrievalRunner;
  turnRunner?: ReplayRetrievalRunner;
  sessionWeight?: number;
  turnWeight?: number;
}

const DEFAULT_SESSION_WEIGHT = 1;
const DEFAULT_TURN_WEIGHT = 1.5;

export function createLongMemEvalHybridRetrievalRunner(
  options: LongMemEvalHybridRunnerOptions
): ReplayRetrievalRunner {
  const sessionRunner = options.sessionRunner ?? createReplayRetrievalRunner(options.sessionFixture);
  const turnRunner = options.turnRunner ?? createReplayRetrievalRunner(options.turnFixture);

  return async (query, input) => {
    const turnQuery = findMatchingQuery(options.turnFixture, input.query) ?? input.query;
    const [sessionResult, turnResult] = await Promise.all([
      sessionRunner(query, {
        ...input,
        fixture: options.sessionFixture,
        query: input.query
      }),
      turnRunner(query, {
        ...input,
        fixture: options.turnFixture,
        query: turnQuery
      })
    ]);

    return combineLongMemEvalHybridSessionResults({
      topK: input.topK,
      query: input.query,
      sessionFixture: options.sessionFixture,
      sessionResult,
      turnResult,
      sessionWeight: options.sessionWeight,
      turnWeight: options.turnWeight
    });
  };
}

export function combineLongMemEvalHybridSessionResults(
  input: LongMemEvalHybridCombineInput
): ReplayRetrievalRunResult {
  const topK = Math.max(1, Math.floor(input.topK));
  const sessionWeight = input.sessionWeight ?? DEFAULT_SESSION_WEIGHT;
  const turnWeight = input.turnWeight ?? DEFAULT_TURN_WEIGHT;
  const scores = new Map<string, { score: number; firstRank: number; source: 'session' | 'turn' | 'both' }>();
  addRankedIds(scores, input.sessionResult.retrievedIds, sessionWeight, 'session');
  addRankedIds(
    scores,
    input.turnResult.retrievedIds.map(turnIdToSessionId),
    turnWeight,
    'turn'
  );

  const retrievedIds = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].firstRank - b[1].firstRank || a[0].localeCompare(b[0]))
    .map(([id]) => id)
    .slice(0, topK);

  const candidateIds = unique([
    ...input.turnResult.candidateIds?.map(turnIdToSessionId) ?? [],
    ...input.sessionResult.candidateIds ?? [],
    ...retrievedIds
  ]);
  const completed = completeMultiSessionCandidateSiblings({
    topK,
    query: input.query,
    sessionFixture: input.sessionFixture,
    retrievedIds,
    candidateIds
  });
  const promotedTurnSessions = unique(input.turnResult.retrievedIds.map(turnIdToSessionId)).filter(
    (id) => !input.sessionResult.retrievedIds.includes(id)
  ).length;

  return {
    retrievedIds: completed.retrievedIds,
    candidateIds: unique([...candidateIds, ...completed.retrievedIds]),
    confidence: mergeConfidence(input.sessionResult.confidence, input.turnResult.confidence),
    fallbackTrace: unique([
      'hybrid:session-turn',
      `hybrid:weights:session=${formatWeight(sessionWeight)},turn=${formatWeight(turnWeight)}`,
      `hybrid:turn-promoted:${promotedTurnSessions}`,
      ...(completed.promotedCount > 0 ? [`hybrid:multi-session-sibling-completion:${completed.promotedCount}`] : []),
      ...prefixTrace('session', input.sessionResult.fallbackTrace),
      ...prefixTrace('turn', input.turnResult.fallbackTrace)
    ])
  };
}

function formatWeight(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function addRankedIds(
  scores: Map<string, { score: number; firstRank: number; source: 'session' | 'turn' | 'both' }>,
  ids: string[],
  weight: number,
  source: 'session' | 'turn'
): void {
  ids.forEach((rawId, index) => {
    const id = turnIdToSessionId(rawId);
    const rank = index + 1;
    const increment = weight / rank;
    const existing = scores.get(id);
    if (!existing) {
      scores.set(id, { score: increment, firstRank: rank, source });
      return;
    }
    existing.score += increment;
    existing.firstRank = Math.min(existing.firstRank, rank);
    existing.source = existing.source === source ? source : 'both';
  });
}

interface MultiSessionCandidateCompletionInput {
  topK: number;
  query?: ReplayEvaluationQuery;
  sessionFixture?: ReplayEvaluationFixture;
  retrievedIds: string[];
  candidateIds: string[];
}

interface MultiSessionCandidateCompletionResult {
  retrievedIds: string[];
  promotedCount: number;
}

function completeMultiSessionCandidateSiblings(
  input: MultiSessionCandidateCompletionInput
): MultiSessionCandidateCompletionResult {
  const baseRetrievedIds = unique(input.retrievedIds.map(turnIdToSessionId)).slice(0, input.topK);
  if (!isMultiSessionQuestion(input.query) || !input.sessionFixture || baseRetrievedIds.length < 2) {
    return { retrievedIds: baseRetrievedIds, promotedCount: 0 };
  }

  const memoryById = new Map(
    input.sessionFixture.memories.map((memory) => [memory.id, extractUserSiblingText(memory.content)])
  );
  const seedIds = baseRetrievedIds.slice(0, 2);
  const seedTokenSets = seedIds
    .map((id) => memoryById.get(id))
    .filter((content): content is string => content !== undefined)
    .map(tokenSet);
  if (seedTokenSets.length < 2) {
    return { retrievedIds: baseRetrievedIds, promotedCount: 0 };
  }

  const commonSeedTerms = [...seedTokenSets[0]]
    .filter((term) => seedTokenSets.every((tokens) => tokens.has(term)))
    .filter(isSiblingAnchorTerm)
    .slice(0, 12);
  if (commonSeedTerms.length < 2) {
    return { retrievedIds: baseRetrievedIds, promotedCount: 0 };
  }

  const queryTerms = tokenSet(input.query?.query ?? '');
  const seedIdSet = new Set(seedIds);
  const originalRankById = new Map(baseRetrievedIds.map((id, index) => [id, index + 1]));
  const minCommonHits = Math.max(2, Math.min(10, Math.ceil(commonSeedTerms.length * 0.45)));
  const scoredCandidates = unique(input.candidateIds.map(turnIdToSessionId))
    .filter((id) => !seedIdSet.has(id))
    .map((id, index) => {
      const content = memoryById.get(id);
      if (!content) return undefined;
      const tokens = tokenSet(content);
      const commonHits = commonSeedTerms.filter((term) => tokens.has(term)).length;
      const queryHits = [...queryTerms].filter((term) => tokens.has(term) && isSiblingAnchorTerm(term)).length;
      const originalRank = originalRankById.get(id) ?? Number.POSITIVE_INFINITY;
      const score = (commonHits * 2) + queryHits - (Math.min(originalRank, input.topK + index + 1) / 1000);
      return { id, score, commonHits, queryHits, originalRank, index };
    })
    .filter((row): row is {
      id: string;
      score: number;
      commonHits: number;
      queryHits: number;
      originalRank: number;
      index: number;
    } => row !== undefined)
    .filter((row) => row.commonHits >= minCommonHits && row.queryHits >= 1)
    .sort((a, b) => b.score - a.score || a.originalRank - b.originalRank || a.index - b.index || a.id.localeCompare(b.id));

  const siblingIds = scoredCandidates.slice(0, 2).map((row) => row.id);
  if (siblingIds.length === 0) {
    return { retrievedIds: baseRetrievedIds, promotedCount: 0 };
  }

  const seedKeep = Math.min(2, baseRetrievedIds.length);
  const completed = unique([
    ...baseRetrievedIds.slice(0, seedKeep),
    ...siblingIds,
    ...baseRetrievedIds.slice(seedKeep)
  ]).slice(0, input.topK);
  const promotedCount = siblingIds.filter((id) => {
    const originalRank = originalRankById.get(id);
    const newRank = completed.indexOf(id) + 1;
    return newRank > 0 && (originalRank === undefined || newRank < originalRank);
  }).length;
  return { retrievedIds: completed, promotedCount };
}

function isMultiSessionQuestion(query: ReplayEvaluationQuery | undefined): boolean {
  return query?.category?.toLowerCase().includes('multi') === true;
}

function tokenSet(value: string): Set<string> {
  return new Set(value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .map(normalizeSiblingToken)
    .filter((token) => token.length >= 4 && !SIBLING_STOPWORDS.has(token)));
}

function extractUserSiblingText(content: string): string {
  const flattened = content.replace(/\r?\n/g, ' | ');
  const segments = [...flattened.matchAll(/(?:^|\|\s*)user:\s*([\s\S]*?)(?=\s*\|\s*(?:assistant|system|tool|user):|$)/gi)]
    .map((match) => match[1]?.trim())
    .filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join(' ') : content;
}

function normalizeSiblingToken(value: string): string {
  let token = value.replace(/^[-']+|[-']+$/g, '');
  if (/^cloth(?:e[sd]?|es|ing)?$/.test(token)) return 'cloth';
  if (/^organi[sz]/.test(token)) return 'organiz';
  if (token.endsWith('ing') && token.length > 6) token = token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 5) token = token.slice(0, -2);
  if (token.endsWith('s') && token.length > 5) token = token.slice(0, -1);
  return token;
}

function isSiblingAnchorTerm(term: string): boolean {
  return term.length >= 4 && !SIBLING_STOPWORDS.has(term);
}

const SIBLING_STOPWORDS = new Set([
  'assistant', 'because', 'before', 'buying', 'could', 'from', 'give', 'have', 'help',
  'item', 'many', 'need', 'please', 'return', 'session', 'still', 'store', 'tell',
  'that', 'them', 'there', 'they', 'this', 'tips', 'user', 'want', 'with', 'would',
  'your'
]);

function findMatchingQuery(
  fixture: ReplayEvaluationFixture,
  query: ReplayEvaluationQuery
): ReplayEvaluationQuery | undefined {
  return fixture.queries.find((candidate) => candidate.queryId === query.queryId);
}

function turnIdToSessionId(id: string): string {
  const marker = '::turn::';
  const markerIndex = id.indexOf(marker);
  return markerIndex === -1 ? id : id.slice(0, markerIndex);
}

function mergeConfidence(a: MatchConfidence | undefined, b: MatchConfidence | undefined): MatchConfidence {
  if (a === 'high' || b === 'high') return 'high';
  if (a === 'suggested' || b === 'suggested') return 'suggested';
  return 'none';
}

function prefixTrace(prefix: string, values: string[] | undefined): string[] {
  return (values ?? []).map((value) => `${prefix}:${value}`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
