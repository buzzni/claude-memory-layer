import { createHash } from 'node:crypto';

export type MemoryFieldCaseKind = 'positive' | 'counterfactual' | 'unrelated';
export type MemoryFieldLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'unknown';
export type MemoryFieldDifficulty = 'easy' | 'standard' | 'hard';
export type MemoryFieldQueryStyle =
  | 'exact'
  | 'contextual'
  | 'compressed_clues'
  | 'paraphrased_clues'
  | 'noisy_clues'
  | 'plausible_counterfactual'
  | 'unrelated';

export interface MemoryFieldPair {
  promptId: string;
  prompt: string;
  answerId: string;
  relatedAnswerIds?: string[];
  answer: string;
  answerLevel: MemoryFieldLevel;
  sessionId: string;
  timestamp: string;
}

export interface MemoryFieldCase {
  caseId: string;
  kind: MemoryFieldCaseKind;
  query: string;
  expectedEventIds: string[];
  sourceLevel: MemoryFieldLevel;
  sourceDigest: string;
  difficulty: MemoryFieldDifficulty;
  queryStyle: MemoryFieldQueryStyle;
}

export interface MemoryFieldDataset {
  schemaVersion: 1;
  name: string;
  generatedAt: string;
  localOnly: true;
  rawQueryContentIncluded: true;
  generation: {
    requestedCases: number;
    positiveCases: number;
    counterfactualCases: number;
    unrelatedCases: number;
    promotedPositiveCases: number;
    sourceSessions: number;
    difficultyCounts: Record<MemoryFieldDifficulty, number>;
    queryStyleCounts: Record<string, number>;
  };
  cases: MemoryFieldCase[];
}

export interface MemoryFieldExecution {
  caseId: string;
  selectedEventIds: string[];
  hasContext: boolean;
  latencyMs: number;
  errorCode?: string;
}

export interface MemoryFieldStoreSnapshot {
  events: number;
  retrievalTraces: number;
  levels: Record<string, number>;
}

export interface MemoryFieldFailure {
  caseId: string;
  kind: MemoryFieldCaseKind;
  sourceLevel: MemoryFieldLevel;
  difficulty: MemoryFieldDifficulty;
  queryStyle: MemoryFieldQueryStyle;
  reason: 'miss' | 'wrong_top1' | 'unexpected_injection' | 'execution_error';
  selectedCount: number;
}

export interface MemoryFieldEvaluationReport {
  schemaVersion: 1;
  datasetName: string;
  evaluatedAt: string;
  counts: {
    total: number;
    positive: number;
    counterfactual: number;
    unrelated: number;
  };
  metrics: {
    overallAccuracy: number;
    positiveHitRate: number;
    positiveTop1Accuracy: number;
    noMatchAccuracy: number;
    unexpectedInjectionCount: number;
    executionErrorCount: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
  };
  byLevel: Record<string, { cases: number; hitRate: number; top1Accuracy: number }>;
  byDifficulty: Record<string, { cases: number; hitRate: number; top1Accuracy: number }>;
  byQueryStyle: Record<string, { cases: number; hitRate: number; top1Accuracy: number }>;
  storeImmutable: boolean;
  failures: MemoryFieldFailure[];
}

export interface BuildMemoryFieldDatasetOptions {
  totalCases?: number;
  positiveCases?: number;
  counterfactualCases?: number;
  unrelatedCases?: number;
  name?: string;
  generatedAt?: string;
}

const UNRELATED_QUERIES = [
  '화성의 대기 조성과 표면 환경을 설명해줘',
  '봄철 장미 가지치기와 비료 주기는 어떻게 돼',
  '마라톤 첫 완주를 위한 12주 훈련 계획을 만들어줘',
  '야경 촬영할 때 카메라 ISO와 셔터 속도 설정을 알려줘',
  '김치찌개에 두부와 돼지고기를 넣는 순서는 뭐야',
  '제주도 2박 3일 가족 여행 동선을 추천해줘',
  '세종대왕의 과학 기술 관련 업적을 요약해줘',
  '심해 열수 분출공 미생물이 에너지를 얻는 방법은 뭐야',
  '실내에서 스웨트 바질을 건강하게 키우는 방법을 알려줘',
  '재생 에너지와 화석 연료의 장단점을 비교해줘',
  '중세 유럽의 길드가 도시 경제에 끼친 영향을 설명해줘',
  '수채화에서 젖은 종이 위에 색이 번지는 효과를 조절하는 법은 뭐야',
  '고양이의 수염이 공간을 인식하는 데 어떤 역할을 해',
  '목성의 대적점이 오랫동안 유지되는 이유를 알려줘',
  '클래식 기타 줄을 교체한 뒤 음정을 안정시키는 방법은 뭐야',
  '발효종으로 사워도우 빵을 만들 때 1차 발효 완료를 판단하는 기준은 뭐야',
  '빙하 코어로 과거 대기 조성을 추정하는 원리를 설명해줘',
  '도시 텃밭에서 토마토 칼슘 결핍을 예방하는 방법을 알려줘',
  '오로라가 극지방에서 주로 보이는 물리적 이유는 무엇이야',
  '재즈 즉흥 연주에서 도리안 모드를 활용하는 연습법을 알려줘',
  '해양 포유류가 잠수 중 산소를 보존하는 생리적 방법은 뭐야',
  '고대 로마의 도로 배수 구조가 어떻게 설계됐는지 설명해줘',
  '천체 사진 여러 장을 스태킹하면 노이즈가 줄어드는 이유는 뭐야',
  '실내 도자기 유약을 바를 때 핀홀 결함을 줄이는 방법을 알려줘',
  'aurora-observatory-47 전파망원경의 극저온 수신기 교정 절차를 정리해줘'
];

const QUERY_STOP_TERMS = new Set([
  '그리고', '그런데', '관련', '내용', '작업', '문제', '확인', '확인하고', '해줘', '해주세요', '알려줘',
  '무엇', '어떤', '어떻게', '당시', '최종', '실제', '다시', '이번', '위해', '대한',
  'the', 'and', 'for', 'with', 'this', 'that', 'please', 'what', 'how', 'check', 'tell'
]);

const CREDENTIAL_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}|\bsk-[A-Za-z0-9_-]{12,}|\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|authorization)\s*[:=]\s*\S+)/i;
const PRIVATE_TAG_PATTERN = /<(?:private|secret)(?:\s[^>]*)?>/i;

export function buildMemoryFieldDataset(
  pairs: MemoryFieldPair[],
  options: BuildMemoryFieldDatasetOptions = {}
): MemoryFieldDataset {
  const totalCases = options.totalCases ?? 200;
  const counterfactualCases = options.counterfactualCases ?? 25;
  const unrelatedCases = options.unrelatedCases ?? 25;
  const positiveCases = options.positiveCases ?? totalCases - counterfactualCases - unrelatedCases;
  if (positiveCases + counterfactualCases + unrelatedCases !== totalCases) {
    throw new Error('memory field dataset case counts must add up to totalCases');
  }
  if (unrelatedCases > UNRELATED_QUERIES.length) {
    throw new Error(`at most ${UNRELATED_QUERIES.length} unrelated cases are available`);
  }

  const eligible = pairs
    .filter(isEligiblePair)
    .sort((a, b) => stableDigest(`${a.promptId}:${a.answerId}`).localeCompare(stableDigest(`${b.promptId}:${b.answerId}`)));
  const promoted = diverseSelect(eligible.filter((pair) => pair.answerLevel !== 'L0'), positiveCases);
  const selectedIds = new Set(promoted.map((pair) => pair.answerId));
  const regular = diverseSelect(
    eligible.filter((pair) => pair.answerLevel === 'L0' && !selectedIds.has(pair.answerId)),
    positiveCases - promoted.length
  );
  const selected = [...promoted, ...regular];
  if (selected.length < positiveCases) {
    throw new Error(`not enough eligible prompt/response pairs: need ${positiveCases}, found ${selected.length}`);
  }

  const positive: MemoryFieldCase[] = selected.slice(0, positiveCases).map((pair, index) => {
    const recall = buildRecallQuery(pair.prompt, index);
    return {
      caseId: `positive-${String(index + 1).padStart(3, '0')}`,
      kind: 'positive',
      query: recall.query,
      expectedEventIds: Array.from(new Set(pair.relatedAnswerIds?.length ? pair.relatedAnswerIds : [pair.answerId])),
      sourceLevel: pair.answerLevel,
      sourceDigest: stableDigest(`${pair.promptId}:${pair.answerId}`),
      difficulty: recall.difficulty,
      queryStyle: recall.queryStyle
    };
  });

  const counterfactualSources = positive.filter((item) => hasIdentifier(item.query));
  const fallbackSources = positive.filter((item) => !hasIdentifier(item.query));
  const counterfactual = [...counterfactualSources, ...fallbackSources]
    .slice(0, counterfactualCases)
    .map((item, index): MemoryFieldCase => ({
      caseId: `counterfactual-${String(index + 1).padStart(3, '0')}`,
      kind: 'counterfactual',
      query: counterfactualQuery(item.query, index + 1),
      expectedEventIds: [],
      sourceLevel: item.sourceLevel,
      sourceDigest: item.sourceDigest,
      difficulty: 'hard',
      queryStyle: 'plausible_counterfactual'
    }));

  const unrelated = UNRELATED_QUERIES.slice(0, unrelatedCases).map((query, index): MemoryFieldCase => ({
    caseId: `unrelated-${String(index + 1).padStart(3, '0')}`,
    kind: 'unrelated',
    query,
    expectedEventIds: [],
    sourceLevel: 'unknown',
    sourceDigest: stableDigest(query),
    difficulty: index < 10 ? 'standard' : 'hard',
    queryStyle: 'unrelated'
  }));

  const cases = [...positive, ...counterfactual, ...unrelated];

  return {
    schemaVersion: 1,
    name: options.name ?? 'local-memory-field-200',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    localOnly: true,
    rawQueryContentIncluded: true,
    generation: {
      requestedCases: totalCases,
      positiveCases: positive.length,
      counterfactualCases: counterfactual.length,
      unrelatedCases: unrelated.length,
      promotedPositiveCases: positive.filter((item) => item.sourceLevel !== 'L0').length,
      sourceSessions: new Set(selected.map((pair) => pair.sessionId)).size,
      difficultyCounts: countBy(cases, (item) => item.difficulty) as Record<MemoryFieldDifficulty, number>,
      queryStyleCounts: countBy(cases, (item) => item.queryStyle)
    },
    cases
  };
}

export function evaluateMemoryFieldExecutions(
  dataset: MemoryFieldDataset,
  executions: MemoryFieldExecution[],
  before: MemoryFieldStoreSnapshot,
  after: MemoryFieldStoreSnapshot,
  evaluatedAt: string = new Date().toISOString()
): MemoryFieldEvaluationReport {
  const executionById = new Map(executions.map((execution) => [execution.caseId, execution]));
  const failures: MemoryFieldFailure[] = [];
  let positiveHits = 0;
  let positiveTop1 = 0;
  let negativeCorrect = 0;
  let unexpectedInjectionCount = 0;
  let executionErrorCount = 0;
  const levelStats = new Map<string, { cases: number; hits: number; top1: number }>();
  const difficultyStats = new Map<string, { cases: number; hits: number; top1: number }>();
  const queryStyleStats = new Map<string, { cases: number; hits: number; top1: number }>();

  for (const item of dataset.cases) {
    const execution = executionById.get(item.caseId);
    const stats = levelStats.get(item.sourceLevel) ?? { cases: 0, hits: 0, top1: 0 };
    const difficulty = item.difficulty ?? 'standard';
    const queryStyle = item.queryStyle ?? (item.kind === 'positive' ? 'contextual' : item.kind);
    const difficultyStat = difficultyStats.get(difficulty) ?? { cases: 0, hits: 0, top1: 0 };
    const styleStat = queryStyleStats.get(queryStyle) ?? { cases: 0, hits: 0, top1: 0 };
    stats.cases += 1;
    difficultyStat.cases += 1;
    styleStat.cases += 1;
    levelStats.set(item.sourceLevel, stats);
    difficultyStats.set(difficulty, difficultyStat);
    queryStyleStats.set(queryStyle, styleStat);
    if (!execution || execution.errorCode) {
      executionErrorCount += 1;
      failures.push({
        caseId: item.caseId,
        kind: item.kind,
        sourceLevel: item.sourceLevel,
        difficulty,
        queryStyle,
        reason: 'execution_error',
        selectedCount: execution?.selectedEventIds.length ?? 0
      });
      continue;
    }

    if (item.kind === 'positive') {
      const expected = new Set(item.expectedEventIds);
      const hit = execution.selectedEventIds.some((eventId) => expected.has(eventId));
      const top1 = execution.selectedEventIds.length > 0 && expected.has(execution.selectedEventIds[0] ?? '');
      if (hit) {
        positiveHits += 1;
        stats.hits += 1;
        difficultyStat.hits += 1;
        styleStat.hits += 1;
      }
      if (top1) {
        positiveTop1 += 1;
        stats.top1 += 1;
        difficultyStat.top1 += 1;
        styleStat.top1 += 1;
      }
      if (!hit) {
        failures.push({
          caseId: item.caseId,
          kind: item.kind,
          sourceLevel: item.sourceLevel,
          difficulty,
          queryStyle,
          reason: execution.selectedEventIds.length > 0 ? 'wrong_top1' : 'miss',
          selectedCount: execution.selectedEventIds.length
        });
      }
    } else if (!execution.hasContext && execution.selectedEventIds.length === 0) {
      negativeCorrect += 1;
      stats.hits += 1;
      stats.top1 += 1;
      difficultyStat.hits += 1;
      difficultyStat.top1 += 1;
      styleStat.hits += 1;
      styleStat.top1 += 1;
    } else {
      unexpectedInjectionCount += 1;
      failures.push({
        caseId: item.caseId,
        kind: item.kind,
        sourceLevel: item.sourceLevel,
        difficulty,
        queryStyle,
        reason: 'unexpected_injection',
        selectedCount: execution.selectedEventIds.length
      });
    }
  }

  const positiveCount = dataset.cases.filter((item) => item.kind === 'positive').length;
  const counterfactualCount = dataset.cases.filter((item) => item.kind === 'counterfactual').length;
  const unrelatedCount = dataset.cases.filter((item) => item.kind === 'unrelated').length;
  const negativeCount = counterfactualCount + unrelatedCount;
  const latencies = executions
    .filter((execution) => !execution.errorCode)
    .map((execution) => execution.latencyMs)
    .sort((a, b) => a - b);
  const correct = positiveHits + negativeCorrect;

  return {
    schemaVersion: 1,
    datasetName: dataset.name,
    evaluatedAt,
    counts: {
      total: dataset.cases.length,
      positive: positiveCount,
      counterfactual: counterfactualCount,
      unrelated: unrelatedCount
    },
    metrics: {
      overallAccuracy: rate(correct, dataset.cases.length),
      positiveHitRate: rate(positiveHits, positiveCount),
      positiveTop1Accuracy: rate(positiveTop1, positiveCount),
      noMatchAccuracy: rate(negativeCorrect, negativeCount),
      unexpectedInjectionCount,
      executionErrorCount,
      latencyP50Ms: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95)
    },
    byLevel: Object.fromEntries(Array.from(levelStats.entries()).map(([level, stats]) => [
      level,
      {
        cases: stats.cases,
        hitRate: rate(stats.hits, stats.cases),
        top1Accuracy: rate(stats.top1, stats.cases)
      }
    ])),
    byDifficulty: summarizeStats(difficultyStats),
    byQueryStyle: summarizeStats(queryStyleStats),
    storeImmutable: JSON.stringify(before) === JSON.stringify(after),
    failures
  };
}

function isEligiblePair(pair: MemoryFieldPair): boolean {
  const prompt = collapseWhitespace(pair.prompt);
  const answer = collapseWhitespace(pair.answer);
  if (prompt.length < 20 || prompt.length > 600 || answer.length < 80 || answer.length > 10000) return false;
  if (CREDENTIAL_PATTERN.test(prompt) || CREDENTIAL_PATTERN.test(answer)) return false;
  if (PRIVATE_TAG_PATTERN.test(prompt) || PRIVATE_TAG_PATTERN.test(answer)) return false;
  if (/^(?:yes|no|ok|okay|네|아니|응|좋아)[.!?\s]*$/iu.test(prompt)) return false;
  return /[A-Za-z가-힣]{2,}/u.test(prompt) && /[A-Za-z가-힣]{2,}/u.test(answer);
}

function diverseSelect(pairs: MemoryFieldPair[], limit: number): MemoryFieldPair[] {
  if (limit <= 0) return [];
  const bySession = new Map<string, MemoryFieldPair[]>();
  for (const pair of pairs) {
    const bucket = bySession.get(pair.sessionId) ?? [];
    bucket.push(pair);
    bySession.set(pair.sessionId, bucket);
  }
  const sessions = Array.from(bySession.keys()).sort((a, b) => stableDigest(a).localeCompare(stableDigest(b)));
  const selected: MemoryFieldPair[] = [];
  let depth = 0;
  while (selected.length < limit) {
    let added = false;
    for (const session of sessions) {
      const candidate = bySession.get(session)?.[depth];
      if (!candidate) continue;
      selected.push(candidate);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
    depth += 1;
  }
  return selected;
}

function buildRecallQuery(
  prompt: string,
  index: number
): { query: string; difficulty: MemoryFieldDifficulty; queryStyle: MemoryFieldQueryStyle } {
  const normalized = collapseWhitespace(prompt).slice(0, 520);
  const style = index % 5;
  if (style === 0) return { query: normalized, difficulty: 'easy', queryStyle: 'exact' };
  if (style === 1) {
    return {
      query: `${normalized} 당시 결론과 해결 방법을 다시 알려줘.`.slice(0, 600),
      difficulty: 'standard',
      queryStyle: 'contextual'
    };
  }
  const clues = selectPromptClues(normalized, style === 2 ? 7 : 6);
  if (style === 2) {
    return {
      query: `${clues.join(' / ')} 이 단서들이 함께 나온 이전 작업의 최종 결과는?`.slice(0, 600),
      difficulty: 'hard',
      queryStyle: 'compressed_clues'
    };
  }
  if (style === 3) {
    return {
      query: `${paraphraseClues(clues).join(' ')} 관련해서 전에 내린 결론과 취한 조치는?`.slice(0, 600),
      difficulty: 'hard',
      queryStyle: 'paraphrased_clues'
    };
  }
  return {
    query: `${addBoundedNoise(clues).join(' ... ')} 이 조각들로 기억나는 검증 결과를 찾아줘`.slice(0, 600),
    difficulty: 'hard',
    queryStyle: 'noisy_clues'
  };
}

function counterfactualQuery(query: string, index: number): string {
  const identifiers = query.match(/[A-Za-z0-9_./:-]+/g) ?? [];
  const strong = new Set(identifiers.filter((term) =>
    /[A-Za-z0-9]/.test(term) && /\d|[_./:-]/.test(term) && term.length >= 2
  ));
  if (strong.size === 0) return `shadow-topic-${8000 + index} ${query}`.slice(0, 600);
  let replacementIndex = 0;
  return query.replace(/[A-Za-z0-9_./:-]+/g, (term) => {
    if (!strong.has(term)) return term;
    replacementIndex += 1;
    return plausibleUnknownIdentifier(term, index, replacementIndex);
  }).slice(0, 600);
}

function selectPromptClues(prompt: string, limit: number): string[] {
  const tokens = prompt.match(/[A-Za-z0-9_./:-]{2,}|[가-힣]{2,}/gu) ?? [];
  const unique = Array.from(new Set(tokens.filter((term) => !QUERY_STOP_TERMS.has(term.toLowerCase()))));
  if (unique.length <= limit) return unique;
  const identifiers = unique.filter(hasIdentifier);
  const words = unique.filter((term) => !hasIdentifier(term));
  const positions = [0, words.length - 1, Math.floor(words.length / 2), 1, words.length - 2, 2]
    .filter((position, offset, all) => position >= 0 && all.indexOf(position) === offset);
  return Array.from(new Set([
    ...identifiers.slice(0, 3),
    ...positions.map((position) => words[position]).filter((term): term is string => Boolean(term))
  ])).slice(0, limit);
}

function paraphraseClues(clues: string[]): string[] {
  const replacements: Array<[RegExp, string]> = [
    [/원인/gu, '이유'], [/해결/gu, '조치'], [/배포/gu, '릴리스'], [/오류/gu, '실패'],
    [/수정/gu, '교정'], [/구현/gu, '적용'], [/검증/gu, '점검'], [/결과/gu, '결론'],
    [/deploy/giu, 'rollout'], [/error/giu, 'failure'], [/fix/giu, 'remedy'],
    [/implement/giu, 'apply'], [/review/giu, 'inspect'], [/test/giu, 'check']
  ];
  return clues.map((clue) => replacements.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), clue));
}

function addBoundedNoise(clues: string[]): string[] {
  let changed = false;
  return clues.map((clue) => {
    if (changed || hasIdentifier(clue) || clue.length < 5) return clue;
    const middle = Math.floor(clue.length / 2);
    changed = true;
    return `${clue.slice(0, middle)}${clue.slice(middle + 1)}`;
  });
}

function plausibleUnknownIdentifier(term: string, caseIndex: number, replacementIndex: number): string {
  if (/^v?\d+(?:\.\d+){1,}$/iu.test(term)) return `v99.${caseIndex}.${replacementIndex}`;
  if (/^(?:pr|issue)[-_:#]?\d+$/iu.test(term)) return `PR-${90000 + caseIndex * 10 + replacementIndex}`;
  if (/^[a-f0-9]{7,40}$/iu.test(term)) return `dead${String(caseIndex).padStart(4, '0')}${replacementIndex}beef`;
  return `shadow-svc-${String(caseIndex).padStart(3, '0')}-${replacementIndex}`;
}

function hasIdentifier(value: string): boolean {
  return /[A-Za-z0-9][A-Za-z0-9_./:-]*[\d_./:-][A-Za-z0-9_./:-]*/.test(value);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stableDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function summarizeStats(
  statsByKey: Map<string, { cases: number; hits: number; top1: number }>
): Record<string, { cases: number; hitRate: number; top1Accuracy: number }> {
  return Object.fromEntries(Array.from(statsByKey.entries()).map(([key, stats]) => [
    key,
    {
      cases: stats.cases,
      hitRate: rate(stats.hits, stats.cases),
      top1Accuracy: rate(stats.top1, stats.cases)
    }
  ]));
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function percentile(sortedValues: number[], quantile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * quantile) - 1);
  return Number((sortedValues[index] ?? 0).toFixed(1));
}
