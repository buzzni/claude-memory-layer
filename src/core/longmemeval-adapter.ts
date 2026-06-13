import type {
  ReplayEvaluationFixture,
  ReplayEvaluationMemory,
  ReplayEvaluationQuery
} from './replay-evaluator.js';

export type LongMemEvalGranularity = 'session' | 'turn';

export interface LongMemEvalTurn {
  role?: string;
  content?: string;
  has_answer?: boolean;
  [key: string]: unknown;
}

export interface LongMemEvalEntry {
  question_id?: string;
  question_type?: string;
  question?: string;
  answer?: string;
  question_date?: string;
  haystack_session_ids?: string[];
  haystack_dates?: string[];
  haystack_sessions?: LongMemEvalTurn[][];
  answer_session_ids?: string[];
  [key: string]: unknown;
}

export interface LongMemEvalAdapterOptions {
  name?: string;
  description?: string;
  ks?: number[];
  granularity?: LongMemEvalGranularity;
  maxEntries?: number;
  includeAbstention?: boolean;
  sourceFileCount?: number;
  generatedAt?: string;
  expandUserFacts?: boolean;
}

interface BuiltEntry {
  memories: ReplayEvaluationMemory[];
  query: ReplayEvaluationQuery;
}

const DEFAULT_KS = [1, 5, 10] as const;

export function longMemEvalEntriesToReplayFixture(
  entries: LongMemEvalEntry[],
  options: LongMemEvalAdapterOptions = {}
): ReplayEvaluationFixture {
  const granularity = options.granularity ?? 'session';
  const selectedEntries = selectEntries(entries, options);
  const builtEntries = selectedEntries.map((entry, index) => buildEntry(entry, index, granularity, options));

  const fixture: ReplayEvaluationFixture = {
    name: options.name ?? `longmemeval-${granularity}-retrieval`,
    ks: normalizeKs(options.ks ?? [...DEFAULT_KS]),
    queries: builtEntries.map((entry) => entry.query),
    memories: builtEntries.flatMap((entry) => entry.memories),
    metadata: {
      sourceFileCount: options.sourceFileCount ?? 1,
      rawContentIncluded: true,
      ...(options.generatedAt ? { generatedAt: options.generatedAt } : {})
    }
  };

  if (options.description !== undefined) {
    fixture.description = options.description;
  }

  return fixture;
}

export function isLongMemEvalAbstention(entry: Pick<LongMemEvalEntry, 'question_id'>): boolean {
  return String(entry.question_id ?? '').endsWith('_abs');
}

function selectEntries(entries: LongMemEvalEntry[], options: LongMemEvalAdapterOptions): LongMemEvalEntry[] {
  const includeAbstention = options.includeAbstention ?? true;
  const filtered = includeAbstention
    ? entries
    : entries.filter((entry) => !isLongMemEvalAbstention(entry));

  if (options.maxEntries === undefined) {
    return filtered;
  }
  if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 0) {
    throw new Error(`Invalid maxEntries: expected a non-negative integer, got ${options.maxEntries}`);
  }
  return filtered.slice(0, options.maxEntries);
}

function buildEntry(
  entry: LongMemEvalEntry,
  index: number,
  granularity: LongMemEvalGranularity,
  options: LongMemEvalAdapterOptions
): BuiltEntry {
  const questionId = requiredString(entry.question_id, `entry[${index}].question_id`);
  const question = requiredString(entry.question, `entry[${index}].question`);
  const questionType = optionalString(entry.question_type) ?? 'unknown';
  const answer = optionalString(entry.answer);
  const isAbstention = isLongMemEvalAbstention(entry);
  const answerSessionIds = normalizeStringArray(entry.answer_session_ids ?? []);

  const sessionIds = normalizeStringArray(requiredArray(entry.haystack_session_ids, `entry[${index}].haystack_session_ids`));
  const dates = normalizeStringArray(entry.haystack_dates ?? []);
  const sessions = requiredArray<LongMemEvalTurn[]>(entry.haystack_sessions, `entry[${index}].haystack_sessions`);
  if (sessions.length !== sessionIds.length) {
    throw new Error(
      `Invalid LongMemEval entry ${questionId}: haystack_sessions length ${sessions.length} does not match haystack_session_ids length ${sessionIds.length}`
    );
  }

  const memories = granularity === 'session'
    ? buildSessionMemories(questionId, questionType, sessionIds, dates, sessions, options.expandUserFacts === true)
    : buildTurnMemories(questionId, questionType, sessionIds, dates, sessions, options.expandUserFacts === true);

  const expectedIds = isAbstention
    ? []
    : determineExpectedIds(granularity, questionId, answerSessionIds, memories);
  const expectedRelevance = Object.fromEntries(expectedIds.map((id) => [id, 3]));
  const category = isAbstention ? `${questionType}:abstention` : questionType;

  const query: ReplayEvaluationQuery = {
    queryId: questionId,
    query: question,
    expectedIds,
    expectedRelevance,
    expectation: isAbstention ? 'no_match' : 'match',
    category
  };

  if (isAbstention) {
    query.forbiddenIds = memories.map((memory) => memory.id);
  }
  if (answer !== undefined) {
    query.knownAnswer = answer;
  }

  return { memories, query };
}

function buildSessionMemories(
  questionId: string,
  questionType: string,
  sessionIds: string[],
  dates: string[],
  sessions: LongMemEvalTurn[][],
  expandUserFacts: boolean
): ReplayEvaluationMemory[] {
  return sessions.map((session, index) => {
    const sessionId = sessionIds[index] ?? `session_${index}`;
    const date = dates[index];
    const userFactLines = expandUserFacts ? extractUserFactLines(session) : [];
    const memory: ReplayEvaluationMemory = {
      id: makeSessionMemoryId(questionId, sessionId),
      content: appendUserFactExpansion(formatSessionContent(date, sessionId, session), userFactLines),
      sourceSessionId: sessionId,
      metadata: {
        questionId,
        questionType,
        ...(userFactLines.length > 0 ? { userFactExpansion: true } : {})
      }
    };
    if (date !== undefined) {
      memory.timestamp = date;
    }
    return memory;
  });
}

function buildTurnMemories(
  questionId: string,
  questionType: string,
  sessionIds: string[],
  dates: string[],
  sessions: LongMemEvalTurn[][],
  expandUserFacts: boolean
): ReplayEvaluationMemory[] {
  const memories: ReplayEvaluationMemory[] = [];
  sessions.forEach((session, sessionIndex) => {
    const sessionId = sessionIds[sessionIndex] ?? `session_${sessionIndex}`;
    const date = dates[sessionIndex];
    session.forEach((turn, turnIndex) => {
      const userFactLines = expandUserFacts ? extractUserFactLines([turn]) : [];
      const memory: ReplayEvaluationMemory = {
        id: makeTurnMemoryId(questionId, sessionId, turnIndex),
        content: appendUserFactExpansion(formatTurnContent(date, sessionId, turnIndex, turn), userFactLines),
        sourceSessionId: sessionId,
        sourceTurnIndex: turnIndex,
        metadata: {
          questionId,
          questionType,
          ...(turn.has_answer === true ? { hasAnswer: true } : {}),
          ...(userFactLines.length > 0 ? { userFactExpansion: true } : {})
        }
      };
      if (date !== undefined) {
        memory.timestamp = date;
      }
      memories.push(memory);
    });
  });
  return memories;
}

function determineExpectedIds(
  granularity: LongMemEvalGranularity,
  questionId: string,
  answerSessionIds: string[],
  memories: ReplayEvaluationMemory[]
): string[] {
  if (granularity === 'session') {
    return answerSessionIds.map((sessionId) => makeSessionMemoryId(questionId, sessionId));
  }

  const answerSessionIdSet = new Set(answerSessionIds);
  const labeledTurnIds = memories
    .filter((memory) => answerSessionIdSet.has(memory.sourceSessionId ?? ''))
    .filter((memory) => memory.sourceTurnIndex !== undefined)
    .filter((memory) => memory.id.includes('::turn::'))
    .filter((memory) => isAnswerTurn(memory))
    .map((memory) => memory.id);

  if (labeledTurnIds.length > 0) {
    return labeledTurnIds;
  }

  return memories
    .filter((memory) => answerSessionIdSet.has(memory.sourceSessionId ?? ''))
    .map((memory) => memory.id);
}

function isAnswerTurn(memory: ReplayEvaluationMemory): boolean {
  return memory.metadata?.hasAnswer === true;
}

function appendUserFactExpansion(content: string, userFactLines: string[]): string {
  if (userFactLines.length === 0) return content;
  return `${content}\nExtracted user facts:\n${userFactLines.map((line) => `- ${line}`).join('\n')}`;
}

function extractUserFactLines(session: LongMemEvalTurn[]): string[] {
  const facts: string[] = [];
  for (const turn of session) {
    const role = typeof turn.role === 'string' ? turn.role.trim().toLowerCase() : '';
    if (role !== 'user') continue;
    const content = normalizeFactText(turn.content);
    if (!content) continue;
    facts.push(...extractPreferenceFactsFromText(content));
  }
  return uniqueStrings(facts).slice(0, 8);
}

function extractPreferenceFactsFromText(content: string): string[] {
  const facts: string[] = [];
  const patterns: Array<(text: string) => string | undefined> = [
    (text) => firstCapture(text, /\bmy\s+((?:favorite|favourite|go-to|default)\s+[^.?!,;]{1,50}?)\s+(?:is|are)\s+([^.?!;]{1,100})/i,
      ([subject, value]) => `user preference: ${subject.trim()} is ${stripTrailing(value)}.`),
    (text) => firstCapture(text, /\bi\s+(?:really\s+)?(?:prefer|like|love|enjoy)\s+([^.?!;]{1,100})/i,
      ([value]) => `user preference: prefers ${stripTrailing(value)}.`),
    (text) => firstCapture(text, /\bi\s+(?:usually|always|often)\s+(?:choose|pick|order|drink|eat|use|wear)\s+([^.?!;]{1,100})/i,
      ([value]) => `user habit: usually chooses ${stripTrailing(value)}.`)
  ];

  for (const pattern of patterns) {
    const fact = pattern(content);
    if (fact !== undefined) facts.push(fact);
  }
  return facts;
}

function firstCapture(
  text: string,
  pattern: RegExp,
  render: (captures: string[]) => string
): string | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;
  return render(match.slice(1).filter((value): value is string => typeof value === 'string'));
}

function normalizeFactText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function stripTrailing(value: string): string {
  return value.trim().replace(/[.?!,;:]+$/g, '').trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function formatSessionContent(date: string | undefined, sessionId: string, session: LongMemEvalTurn[]): string {
  const header = date === undefined ? `session ${sessionId}` : `[${date}] session ${sessionId}`;
  return [header, ...session.map(formatTurnLine)].join('\n');
}

function formatTurnContent(
  date: string | undefined,
  sessionId: string,
  turnIndex: number,
  turn: LongMemEvalTurn
): string {
  const header = date === undefined
    ? `session ${sessionId} turn ${turnIndex}`
    : `[${date}] session ${sessionId} turn ${turnIndex}`;
  return `${header}\n${formatTurnLine(turn)}`;
}

function formatTurnLine(turn: LongMemEvalTurn): string {
  const role = typeof turn.role === 'string' && turn.role.trim() ? turn.role.trim() : 'unknown';
  const content = typeof turn.content === 'string' ? turn.content : '';
  return `${role}: ${content}`;
}

function makeSessionMemoryId(questionId: string, sessionId: string): string {
  return `${questionId}::session::${sessionId}`;
}

function makeTurnMemoryId(questionId: string, sessionId: string, turnIndex: number): string {
  return `${makeSessionMemoryId(questionId, sessionId)}::turn::${turnIndex}`;
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid LongMemEval input: ${fieldName} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function requiredArray<T = unknown>(value: unknown, fieldName: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid LongMemEval input: ${fieldName} must be an array`);
  }
  return value as T[];
}

function normalizeStringArray(values: unknown[]): string[] {
  return values.map((value) => String(value));
}

function normalizeKs(ks: number[]): number[] {
  const normalized = [...new Set(ks)]
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .sort((a, b) => a - b);
  if (normalized.length === 0) {
    throw new Error('At least one positive integer k value is required');
  }
  return normalized;
}
