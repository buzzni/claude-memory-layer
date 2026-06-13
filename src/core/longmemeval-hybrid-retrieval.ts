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
  const promotedTurnSessions = unique(input.turnResult.retrievedIds.map(turnIdToSessionId)).filter(
    (id) => !input.sessionResult.retrievedIds.includes(id)
  ).length;

  return {
    retrievedIds,
    candidateIds,
    confidence: mergeConfidence(input.sessionResult.confidence, input.turnResult.confidence),
    fallbackTrace: unique([
      'hybrid:session-turn',
      `hybrid:weights:session=${formatWeight(sessionWeight)},turn=${formatWeight(turnWeight)}`,
      `hybrid:turn-promoted:${promotedTurnSessions}`,
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
