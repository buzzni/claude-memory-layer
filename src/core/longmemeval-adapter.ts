import type {
  ReplayEvaluationFixture,
  ReplayEvaluationMemory,
  ReplayEvaluationQuery,
  ReplayTemporalDateBoost
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
  expandUserFactsToSearchContent?: boolean;
  expandPreferenceQueries?: boolean;
  expandTemporalQueries?: boolean;
  temporalDateBoost?: boolean;
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
      ...(options.expandUserFactsToSearchContent === true ? { userFactSearchExpansion: true } : {}),
      ...(options.expandPreferenceQueries === true ? { preferenceQueryExpansion: true } : {}),
      ...(options.expandTemporalQueries === true ? { temporalQueryExpansion: true } : {}),
      ...(options.temporalDateBoost === true ? { temporalDateBoost: true } : {}),
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
    ? buildSessionMemories(questionId, questionType, sessionIds, dates, sessions, {
        expandUserFacts: options.expandUserFacts === true,
        expandUserFactsToSearchContent: options.expandUserFactsToSearchContent === true
      })
    : buildTurnMemories(questionId, questionType, sessionIds, dates, sessions, {
        expandUserFacts: options.expandUserFacts === true,
        expandUserFactsToSearchContent: options.expandUserFactsToSearchContent === true
      });

  const expectedIds = isAbstention
    ? []
    : determineExpectedIds(granularity, questionId, answerSessionIds, memories);
  const expectedRelevance = Object.fromEntries(expectedIds.map((id) => [id, 3]));
  const category = isAbstention ? `${questionType}:abstention` : questionType;

  const query: ReplayEvaluationQuery = {
    queryId: questionId,
    query: expandLongMemEvalQuery(question, questionType, optionalString(entry.question_date), isAbstention, options),
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
  if (options.temporalDateBoost === true && !isAbstention && questionType === 'temporal-reasoning') {
    const temporalDateBoost = buildTemporalDateBoost(question, optionalString(entry.question_date));
    if (temporalDateBoost !== undefined) {
      query.temporalDateBoost = temporalDateBoost;
    }
  }

  return { memories, query };
}

function expandLongMemEvalQuery(
  question: string,
  questionType: string,
  questionDate: string | undefined,
  isAbstention: boolean,
  options: LongMemEvalAdapterOptions
): string {
  let expanded = question;

  if (options.expandPreferenceQueries === true && !isAbstention && questionType === 'single-session-preference') {
    const hint = 'user preference personal context interests goals prior details';
    expanded = expanded.toLowerCase().includes(hint) ? expanded : `${expanded} ${hint}`;
  }

  if (options.expandTemporalQueries === true && !isAbstention && questionType === 'temporal-reasoning') {
    const normalizedDate = normalizeLongMemEvalQuestionDate(questionDate);
    const hint = `${normalizedDate ? `question date ${normalizedDate} ` : ''}temporal order before after earlier later elapsed days weeks months ago latest earliest timeline`;
    expanded = expanded.toLowerCase().includes(hint.toLowerCase()) ? expanded : `${expanded} ${hint}`;
  }

  return expanded;
}

function normalizeLongMemEvalQuestionDate(questionDate: string | undefined): string | undefined {
  if (questionDate === undefined) return undefined;
  const match = /\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/.exec(questionDate);
  if (!match) return undefined;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}


function buildTemporalDateBoost(
  question: string,
  questionDate: string | undefined
): ReplayTemporalDateBoost | undefined {
  const referenceDate = normalizeLongMemEvalQuestionDate(questionDate);
  if (referenceDate === undefined) return undefined;

  const relative = parseExplicitRelativeDate(question, referenceDate);
  const boost: ReplayTemporalDateBoost = {
    referenceDate,
    entityTerms: extractTemporalEntityTerms(question)
  };
  if (relative !== undefined) {
    boost.targetDate = relative.targetDate;
    boost.toleranceDays = relative.toleranceDays;
  }
  return boost;
}

function parseExplicitRelativeDate(
  question: string,
  referenceDate: string
): { targetDate: string; toleranceDays: number } | undefined {
  const match = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|days|week|weeks|month|months|year|years)\s+ago\b/i.exec(question);
  if (!match) return undefined;
  const amount = parseTemporalAmount(match[1]);
  if (amount === undefined) return undefined;
  const unit = match[2].toLowerCase();
  const reference = parseDateOnlyUtc(referenceDate);
  if (reference === undefined) return undefined;
  const target = new Date(reference);
  let toleranceDays = 1;
  if (unit.startsWith('day')) {
    target.setUTCDate(target.getUTCDate() - amount);
    toleranceDays = 1;
  } else if (unit.startsWith('week')) {
    target.setUTCDate(target.getUTCDate() - amount * 7);
    toleranceDays = 3;
  } else if (unit.startsWith('month')) {
    target.setUTCMonth(target.getUTCMonth() - amount);
    toleranceDays = 7;
  } else if (unit.startsWith('year')) {
    target.setUTCFullYear(target.getUTCFullYear() - amount);
    toleranceDays = 14;
  }
  return { targetDate: formatDateOnly(target), toleranceDays };
}

function parseTemporalAmount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12
  };
  return words[value.toLowerCase()];
}

function extractTemporalEntityTerms(question: string): string[] {
  const stopwords = new Set([
    'what', 'which', 'when', 'where', 'who', 'whom', 'whose', 'how', 'many', 'much',
    'did', 'was', 'were', 'am', 'is', 'are', 'do', 'does', 'have', 'has', 'had',
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'with', 'from', 'between',
    'at', 'on', 'in', 'by', 'ago', 'day', 'days', 'week', 'weeks', 'month', 'months',
    'year', 'years', 'passed', 'pass', 'elapsed', 'happened', 'happen', 'first',
    'last', 'earlier', 'later', 'before', 'after', 'order', 'latest', 'earliest',
    'past', 'recent', 'recently', 'i', 'my', 'me'
  ]);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of question.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/)) {
    const token = raw.replace(/^[-']+|[-']+$/g, '');
    if (token.length < 3 || /^\d+$/.test(token) || stopwords.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms.slice(0, 12);
}

function parseDateOnlyUtc(value: string): Date | undefined {
  const match = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(value);
  if (!match) return undefined;
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function formatDateOnly(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildSessionMemories(
  questionId: string,
  questionType: string,
  sessionIds: string[],
  dates: string[],
  sessions: LongMemEvalTurn[][],
  expansionOptions: { expandUserFacts: boolean; expandUserFactsToSearchContent: boolean }
): ReplayEvaluationMemory[] {
  return sessions.map((session, index) => {
    const sessionId = sessionIds[index] ?? `session_${index}`;
    const date = dates[index];
    const shouldExtractUserFacts = expansionOptions.expandUserFacts || expansionOptions.expandUserFactsToSearchContent;
    const userFactLines = shouldExtractUserFacts ? extractUserFactLines(session) : [];
    const baseContent = formatSessionContent(date, sessionId, session);
    const memory: ReplayEvaluationMemory = {
      id: makeSessionMemoryId(questionId, sessionId),
      content: expansionOptions.expandUserFacts ? appendUserFactExpansion(baseContent, userFactLines) : baseContent,
      sourceSessionId: sessionId,
      metadata: {
        questionId,
        questionType,
        ...(expansionOptions.expandUserFacts && userFactLines.length > 0 ? { userFactExpansion: true } : {}),
        ...(expansionOptions.expandUserFactsToSearchContent && userFactLines.length > 0 ? { userFactSearchExpansion: true } : {})
      }
    };
    if (expansionOptions.expandUserFactsToSearchContent && userFactLines.length > 0) {
      memory.searchContent = appendUserFactExpansion(baseContent, userFactLines);
    }
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
  expansionOptions: { expandUserFacts: boolean; expandUserFactsToSearchContent: boolean }
): ReplayEvaluationMemory[] {
  const memories: ReplayEvaluationMemory[] = [];
  sessions.forEach((session, sessionIndex) => {
    const sessionId = sessionIds[sessionIndex] ?? `session_${sessionIndex}`;
    const date = dates[sessionIndex];
    session.forEach((turn, turnIndex) => {
      const shouldExtractUserFacts = expansionOptions.expandUserFacts || expansionOptions.expandUserFactsToSearchContent;
      const userFactLines = shouldExtractUserFacts ? extractUserFactLines([turn]) : [];
      const baseContent = formatTurnContent(date, sessionId, turnIndex, turn);
      const memory: ReplayEvaluationMemory = {
        id: makeTurnMemoryId(questionId, sessionId, turnIndex),
        content: expansionOptions.expandUserFacts ? appendUserFactExpansion(baseContent, userFactLines) : baseContent,
        sourceSessionId: sessionId,
        sourceTurnIndex: turnIndex,
        metadata: {
          questionId,
          questionType,
          ...(turn.has_answer === true ? { hasAnswer: true } : {}),
          ...(expansionOptions.expandUserFacts && userFactLines.length > 0 ? { userFactExpansion: true } : {}),
          ...(expansionOptions.expandUserFactsToSearchContent && userFactLines.length > 0 ? { userFactSearchExpansion: true } : {})
        }
      };
      if (expansionOptions.expandUserFactsToSearchContent && userFactLines.length > 0) {
        memory.searchContent = appendUserFactExpansion(baseContent, userFactLines);
      }
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
    (text) => firstCapture(text, /\bi(?:\s+am|'m)\s+trying\s+to\s+learn\s+([^.?!,;]{3,140}),\s+which\s+i\s+(?:enjoy|like|love|prefer)\s+to\s+use\b/i,
      ([value]) => `user preference: enjoys using ${stripTrailing(value)}.`),
    (text) => firstCapture(text, /\bi(?:\s+am|'m)\s+looking\s+to\s+([^.?!;]{1,120})/i,
      ([value]) => `user goal: looking to ${stripTrailing(value)}.`),
    (text) => firstCapture(text, /\bi\s+(?:want|would\s+like)\s+to\s+((?:know|learn|try|find|improve|use|make|get)\s+[^.?!;]{1,120})/i,
      ([value]) => renderUserGoalFact('wants to', value)),
    (text) => firstCapture(text, /\bi(?:\s+am|'m)\s+trying\s+to\s+((?:learn|find|get|improve|use|make)\s+[^.?!;]{1,120})/i,
      ([value]) => renderUserGoalFact('trying to', value)),
    (text) => firstCapture(text, /\bi(?:'d|\s+would)\s+love\s+to\s+([^.?!;]{1,120})/i,
      ([value]) => `user preference: would love to ${stripTrailing(value)}.`),
    (text) => firstCapture(text, /\bi\s+(?:also\s+|really\s+)?(?:prefer|like|love|enjoy)\s+([^.?!;]{1,120})/i,
      ([value]) => renderPreferenceVerbFact(value)),
    (text) => firstCapture(text, /\bi\s+(?:usually|always|often)\s+(?:choose|pick|order|drink|eat|use|wear)\s+([^.?!;]{1,100})/i,
      ([value]) => `user habit: usually chooses ${stripTrailing(value)}.`),
    (text) => firstCapture(text, /\bi(?:\s+have|'ve)\s+been\s+([^.?!;]{1,160})/i,
      ([value]) => `user context: has been ${stripTrailing(value)}.`),
    (text) => firstCapture(text, /\b(?:i\s+recently|recently\s+i)\s+([^.?!;]{1,140})/i,
      ([value]) => `user context: recently ${stripTrailing(value)}.`)
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
  render: (captures: string[]) => string | undefined
): string | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;
  return render(match.slice(1).filter((value): value is string => typeof value === 'string'));
}

function renderPreferenceVerbFact(value: string): string | undefined {
  const normalized = stripTrailing(value);
  if (!normalized || /^to\s+\w+$/i.test(normalized)) return undefined;
  return `user preference: prefers ${normalized}.`;
}

function renderUserGoalFact(prefix: 'wants to' | 'trying to', value: string): string | undefined {
  const normalized = stripTrailing(value);
  if (!normalized || /\bwhich\s+i\s+(?:enjoy|like|love|prefer)\s+to\s+use\b/i.test(normalized)) return undefined;
  if (/^(?:make\s+sure|ensure)\b/i.test(normalized)) return undefined;
  return `user goal: ${prefix} ${normalized}.`;
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
