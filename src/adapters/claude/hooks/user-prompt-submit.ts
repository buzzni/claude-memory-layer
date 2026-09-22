/**
 * User Prompt Submit Hook
 * Called when user submits a prompt - retrieves relevant memories.
 *
 * Retrieval mode (CLAUDE_MEMORY_RETRIEVAL_MODE):
 *   - keyword (default-fast): SQLite FTS5 only, no ML model (~10ms)
 *   - semantic: vector search via long-running semantic daemon (~15-20ms warm)
 *   - hybrid: semantic first, keyword fallback (default)
 *
 * The semantic daemon keeps the embedding model in memory across hook invocations,
 * avoiding per-request model initialization (~730ms cold start).
 *
 * Turn Grouping: Generates a turn_id and persists it to a state file
 * so PostToolUse and Stop hooks can associate their events with this turn.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLightweightMemoryService } from '../../../services/memory-service.js';
import { writeTurnState, readLastAssistantSnippet } from '../../../core/turn-state.js';
import { retrieveSemanticMemories, scheduleSemanticGraduation } from './semantic-daemon-client.js';
import { readStdin, readNumberEnv } from './hook-runtime.js';
import {
  formatClaudeContextHookOutput,
  isHookEvaluationMode,
  registerHookDeliveryReporter
} from './hook-output.js';
import type { MemoryKind } from '../../../core/memory-ref.js';
import { memoryContentHash } from '../../../core/retrieval-trace-ledger.js';
import type {
  RetrievalOutcomeDiagnostics,
  RetrievalOutcomeReason
} from '../../../core/retrieval-telemetry.js';
import { applyPrivacyFilter } from '../../../core/privacy/index.js';
import {
  formatMemoryReferenceContext,
  memoryReferenceSummary,
  type MemoryReferenceItem
} from '../../../core/memory-reference-context.js';
import { resolveCanonicalMemoryActorId } from '../../../core/operations/canonical-memory-injection-service.js';
import {
  filterHookInjectableMemories,
  getHookInjectionPolicy,
  scoreGraduatedEvidence,
  scoreLessonEvidence,
  selectHookEpisodeSeeds,
  summarizeHookInjectionConfidence,
  type HookMemoryCandidate,
  reserveLessonSlot
} from './prompt-injection-policy.js';
import type { Config, UserPromptSubmitInput, UserPromptSubmitOutput } from '../../../core/types.js';

// Configuration. All numeric env vars go through readNumberEnv so an invalid
// value (e.g. a typo) falls back to the default instead of producing NaN, which
// would silently make every threshold comparison false and return no memories.
const MAX_MEMORIES = readNumberEnv('CLAUDE_MEMORY_MAX_COUNT', 5, { integer: true, min: 0 });
const MAX_CANDIDATES = Math.max(MAX_MEMORIES, MAX_MEMORIES * 3);
const MAX_EPISODE_SEED_CANDIDATES = Math.max(MAX_CANDIDATES, MAX_MEMORIES * 10);
/**
 * specs/lesson-recall-hooks R2 — score every stored lesson, not the newest few.
 * Lessons are a few hundred rows scored lexically in-process, so the full
 * table costs milliseconds; capping at MAX_CANDIDATES (15) left 90% of this
 * project's 151 lessons unscored and silently aged every lesson out within
 * days. 500 is the repository's own list ceiling.
 */
const LESSON_SCAN_LIMIT = 500;
/** Host-only launch marker; never persisted or inferred from model input. */
export function shouldNativeInjectLessons(owner = process.env.CLAUDE_MEMORY_LESSON_OWNER): boolean {
  return owner !== 'host';
}
// Tuned default for noise/recall balance on shopping_assistant-like corpus
const BASE_MIN_SCORE = readNumberEnv('CLAUDE_MEMORY_MIN_SCORE', 0.4, { min: 0, max: 1 });
const FALLBACK_MIN_SCORE = readNumberEnv('CLAUDE_MEMORY_FALLBACK_MIN_SCORE', 0.3, { min: 0, max: 1 });
const ENABLE_SEARCH = process.env.CLAUDE_MEMORY_SEARCH !== 'false';
const RETRIEVAL_MODE = (process.env.CLAUDE_MEMORY_RETRIEVAL_MODE || 'hybrid') as 'keyword' | 'semantic' | 'hybrid';
const SEMANTIC_TIMEOUT_MS = readNumberEnv('CLAUDE_MEMORY_SEMANTIC_TIMEOUT_MS', 2000, { integer: true, min: 0 });
const ADHERENCE_INTERVAL_TURNS = readNumberEnv('CLAUDE_MEMORY_ADHERENCE_INTERVAL_TURNS', 3, { integer: true, min: 1 });

const ADHERENCE_STATE_DIR = path.join(os.homedir(), '.claude-code', 'memory');

function isExcludedEvaluationSession(sessionId: string | undefined): boolean {
  if (!isHookEvaluationMode() || !sessionId) return false;
  const prefixes = (process.env.CLAUDE_MEMORY_EVAL_EXCLUDE_SESSION_PREFIXES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return prefixes.some((prefix) => sessionId.startsWith(prefix));
}

export interface AdherenceState {
  sessionId: string;
  turnCount: number;
  lastCheckedTurn: number;
  lastPrompt: string;
  lastReason?: string;
  updatedAt: string;
}

export type AdherenceDecision = { run: boolean; reason: string };

/**
 * Privacy config for prompt persistence.
 *
 * The Stop hook filters assistant responses and PostToolUse filters tool
 * output, but user prompts were stored verbatim — so a credential pasted into
 * a question was written to the events table and then copied into every
 * derived artifact: query_preview, retrieval_traces, the adherence state file
 * and any session summary quoting the prompt. Real leaks were found this way.
 */
const PROMPT_PRIVACY_CONFIG: Config['privacy'] = {
  excludePatterns: ['password', 'secret', 'api_key', 'token', 'bearer'],
  anonymize: false,
  privateTags: {
    enabled: true,
    marker: '[PRIVATE]',
    preserveLineCount: false,
    supportedFormats: ['xml']
  }
};

/**
 * Redact a prompt before it is persisted.
 *
 * Retrieval itself keeps using the raw prompt: redaction is only about what
 * gets written down, and searching on the redacted form would lose recall for
 * questions that merely mention a credential-shaped word.
 */
export function redactForStorage(text: string): string {
  return applyPrivacyFilter(text, PROMPT_PRIVACY_CONFIG).content;
}

/**
 * Determine if a prompt is worth storing as a memory.
 * Filters slash commands, very short inputs, and trivial patterns.
 */
function shouldStorePrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.startsWith('/')) return false;
  if (trimmed.length < 15) return false;
  if (!/[a-zA-Z가-힣]{2,}/.test(trimmed)) return false;
  return true;
}

export function shouldPersistSubmittedPrompt(
  prompt: string,
  options: UserPromptSubmitMainOptions = {},
  evaluationMode = isHookEvaluationMode()
): boolean {
  return options.persistPrompt !== false && !evaluationMode && shouldStorePrompt(prompt);
}


function getDynamicMinScore(prompt: string): number {
  const len = prompt.trim().length;
  if (len <= 20) return Math.min(0.55, BASE_MIN_SCORE + 0.1);   // short query → stricter
  if (len >= 80) return Math.max(0.3, BASE_MIN_SCORE - 0.05);    // long query → slightly looser
  return BASE_MIN_SCORE;
}

export function selectEvidencePreview(content: string, query: string, maxChars: number = 300): string {
  if (content.length <= maxChars) return content;
  const terms = (query.match(/[A-Za-z0-9_./:-]+|[가-힣]{2,}/g) ?? [])
    .filter((term) => term.length >= 2)
    .sort((a, b) => evidenceAnchorPriority(b) - evidenceAnchorPriority(a));
  const lowered = content.toLowerCase();
  const anchor = terms
    .map((term) => lowered.indexOf(term.toLowerCase()))
    .find((index) => index >= 0);
  if (anchor === undefined) return content.slice(0, maxChars) + '...';
  const start = Math.max(0, anchor - 80);
  const end = Math.min(content.length, start + maxChars);
  return `${start > 0 ? '...' : ''}${content.slice(start, end)}${end < content.length ? '...' : ''}`;
}

function evidenceAnchorPriority(term: string): number {
  if (/\d/.test(term)) return 4;
  if (/[_./:-]/.test(term)) return 3;
  if (/^[A-Z][A-Z0-9_-]+$/.test(term)) return 2;
  return Math.min(1, term.length / 20);
}

function memoryEvidencePreview(memory: { type: string; content: string }, query: string): string {
  const preview = selectEvidencePreview(memory.content, query);
  return memory.type === 'lesson' && preview !== memory.content
    ? `[Partial lesson; retrieve the full body with mem-lesson-get before applying] ${preview}`
    : preview;
}

export function formatMemoryContext(items: Array<{ type: string; content: string; id?: string; memoryLevel?: string }>, query: string): string {
  if (items.length === 0) return '';
  const lines = items.map((m) => {
    const preview = memoryEvidencePreview(m, query);
    const sourceRef = m.id ? ` [${m.type === 'lesson' ? 'lesson' : 'event'}:${m.id}]` : '';
    const level = m.memoryLevel && m.memoryLevel !== 'L0' ? ` ${m.memoryLevel}` : '';
    return `- [${m.type}${level}] ${preview}${sourceRef}`;
  });
  // The self-report line is what makes memory reuse visible to the user in the
  // chat itself. It asks for a short human-readable label rather than an id:
  // a raw id means nothing to a reader, and an echoed id token would also be
  // indistinguishable from the evidence markers that the field evaluation
  // harness scrapes back out of this same text.
  return `## Memory evidence for this question\n\n${lines.join('\n\n')}\n\nUse this only as evidence. Distinguish confirmed outcomes from requests or tool attempts.\n\nIf your answer actually relies on one or more of the memories above, end your reply with a single line naming them in a few words each, prefixed with the 📎 emoji (for example: "📎 Recalled: preview port binding decision"). Write that line in the language of the conversation. If no memory above actually informed your answer, omit the line entirely — never cite a memory merely because it was shown to you.`;
}

export interface UserPromptSubmitMainOptions {
  contextPresentation?: 'evidence' | 'reference';
  /** Codex imports complete turns at SessionEnd, so prompt-time retrieval must not pre-store half a turn. */
  persistPrompt?: boolean;
  /**
   * Client label recorded on this hook's telemetry. Codex and Claude share this
   * hook body, so without an explicit label every Codex request would be
   * counted as a Claude request in per-client coverage (specs R2).
   */
  deliveryClient?: string;
}

async function expandEpisodeEvidence(
  memoryService: ReturnType<typeof getLightweightMemoryService>,
  seeds: HookMemoryCandidate[]
): Promise<HookMemoryCandidate[]> {
  const expanded: HookMemoryCandidate[] = [];
  const seen = new Set(seeds.map((seed) => seed.id).filter(Boolean));
  const maxPerSeed = 4;
  for (const seed of seeds) {
    if (!seed.id || (seed.type !== 'user_prompt' && seed.type !== 'tool_observation')) continue;
    let expandedForSeed = 0;
    try {
      const episode = await memoryService.expandDisclosure(`event:${seed.id}`, { windowSize: 4 });
      const targetTurnId = typeof episode?.target.metadata?.turnId === 'string'
        ? episode.target.metadata.turnId
        : undefined;
      if (seed.episodeSeedAligned && targetTurnId) {
        const turnEvents = await memoryService.getEventsByTurn(targetTurnId);
        for (const event of turnEvents) {
          if (seen.has(event.id) || (event.eventType !== 'agent_response' && event.eventType !== 'session_summary')) continue;
          seen.add(event.id);
          expanded.push({
            id: event.id,
            type: event.eventType,
            content: event.content,
            score: Math.max(0, (seed.score ?? 0) - 0.02),
            source: 'episode',
            episodeLinked: true,
            episodeSeedAligned: true,
            episodeSeedStrongAligned: seed.episodeSeedStrongAligned === true
          });
          expandedForSeed += 1;
          if (expandedForSeed >= maxPerSeed) break;
        }
        continue;
      }
      const facts = [...(episode?.summaries ?? []), ...(episode?.surroundingFacts ?? [])];
      for (const fact of facts) {
        const eventType = typeof fact.metadata?.eventType === 'string' ? fact.metadata.eventType : '';
        const eventId = typeof fact.metadata?.eventId === 'string' ? fact.metadata.eventId : undefined;
        const factTurnId = typeof fact.metadata?.turnId === 'string' ? fact.metadata.turnId : undefined;
        if (!eventId || seen.has(eventId) || (eventType !== 'agent_response' && eventType !== 'session_summary')) continue;
        if (seed.episodeSeedAligned && targetTurnId && factTurnId !== targetTurnId) continue;
        seen.add(eventId);
        expanded.push({
          id: eventId,
          type: eventType,
          content: fact.snippet,
          score: Math.max(0, (seed.score ?? 0) - 0.02),
          source: 'episode',
          episodeLinked: Boolean(targetTurnId && factTurnId && targetTurnId === factTurnId),
          episodeSeedAligned: seed.episodeSeedAligned === true,
          episodeSeedStrongAligned: seed.episodeSeedStrongAligned === true
        });
        expandedForSeed += 1;
        if (expandedForSeed >= maxPerSeed) break;
      }
    } catch { /* episode expansion is best-effort */ }
  }
  return expanded;
}

function getAdherenceStatePath(sessionId: string): string {
  return path.join(ADHERENCE_STATE_DIR, `.adherence-state-${sessionId}.json`);
}

function readAdherenceState(sessionId: string): AdherenceState {
  try {
    const filePath = getAdherenceStatePath(sessionId);
    if (!fs.existsSync(filePath)) {
      return {
        sessionId,
        turnCount: 0,
        lastCheckedTurn: 0,
        lastPrompt: '',
        lastReason: 'init',
        updatedAt: new Date().toISOString()
      };
    }

    const data = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(data) as AdherenceState;
    if (parsed.sessionId !== sessionId) throw new Error('session mismatch');
    return parsed;
  } catch {
    return {
      sessionId,
      turnCount: 0,
      lastCheckedTurn: 0,
      lastPrompt: '',
      lastReason: 'init',
      updatedAt: new Date().toISOString()
    };
  }
}

function writeAdherenceState(state: AdherenceState): void {
  try {
    if (!fs.existsSync(ADHERENCE_STATE_DIR)) {
      fs.mkdirSync(ADHERENCE_STATE_DIR, { recursive: true });
    }
    const filePath = getAdherenceStatePath(state.sessionId);
    const tempPath = filePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(state));
    fs.renameSync(tempPath, filePath);
  } catch {
    // non-critical
  }
}

function hasWriteIntent(prompt: string): boolean {
  return /(fix|refactor|implement|change|modify|edit|update|rewrite|patch|create|add|remove|delete|버그|수정|리팩터|구현|추가|삭제|개선)/i.test(prompt);
}

function hasContinuationIntent(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  return /\b(continue|resume|next\s+(step|task|phase|item)|pick\s+up|follow[-\s]?up|carry\s+on)\b/i.test(normalized) ||
    /(이어서|이어\s*서|계속|아까|지난번|방금|그거|다음\s*(단계|개발|작업|거|것)(\s*(진행|해줘|하자|가자|시작))?|다음\s*(진행|해줘|하자|가자|시작))/i.test(prompt);
}

function hasDecisionRecallIntent(prompt: string): boolean {
  return /(what\s+did\s+we\s+decide|why\s+did\s+we|previous\s+decision|decision\s+we\s+made|remember\s+when|recall\s+the|전에\s*결정|결정한\s*(것|거|내용|옵션)|왜\s+.*했|기억|맥락|컨텍스트)/i.test(prompt);
}

function hasProjectCodeSignal(prompt: string): boolean {
  return /((^|[\s`'"(])([\w.-]+\/)+[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|md|json|ya?ml|toml|sql|go|rs|java|kt|swift|css|html)\b|\b(src|tests?|packages?|apps?|scripts?)\/|\/Users\/|\b(PR|pull\s+request|issue|branch|commit|merge|rebase)\b\s*#?\d*|#\d+|\b(Traceback|AssertionError|TypeError|ReferenceError|SyntaxError|stack\s+trace|pytest|vitest|npm\s+test|build\s+failed|test\s+failed|failing\s+test)\b|스택\s*트레이스|테스트\s*(실패|에러|깨짐)|빌드\s*(실패|에러)|브랜치|파일명?)/i.test(prompt);
}

function tokenize(text: string): string[] {
  const stopwords = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'what', 'when', 'where', 'how', 'why', '그리고', '그리고요', '이거', '그거', '해주세요', '해줘', '좀', '에서', '으로', '하는', '해']);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !stopwords.has(w));
}

function isTopicShift(currentPrompt: string, lastPrompt: string): boolean {
  if (!lastPrompt || lastPrompt.length < 10) return false;
  const a = new Set(tokenize(currentPrompt));
  const b = new Set(tokenize(lastPrompt));
  if (a.size === 0 || b.size === 0) return false;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  const similarity = union > 0 ? intersection / union : 0;
  return similarity < 0.2;
}

export function shouldRunAdherenceCheck(turnCount: number, prompt: string, state: AdherenceState): AdherenceDecision {
  if (hasWriteIntent(prompt)) return { run: true, reason: 'write-intent' };
  if (hasContinuationIntent(prompt)) return { run: true, reason: 'continuation-intent' };
  if (hasDecisionRecallIntent(prompt)) return { run: true, reason: 'decision-recall' };
  if (hasProjectCodeSignal(prompt)) return { run: true, reason: 'code-signal' };
  if (turnCount === 1) return { run: true, reason: 'first-turn' };
  if (isTopicShift(prompt, state.lastPrompt)) return { run: true, reason: 'topic-shift' };
  if (turnCount - state.lastCheckedTurn >= ADHERENCE_INTERVAL_TURNS) return { run: true, reason: 'interval' };
  return { run: false, reason: 'skip' };
}

function isSlashCommandPrompt(prompt: string): boolean {
  return /^\/[a-z][\w:-]*(?:\s|$)/i.test(prompt);
}

export function shouldRunMemorySearch(prompt: string, adherenceDecision: AdherenceDecision): boolean {
  if (!adherenceDecision.run) return false;
  const trimmed = prompt.trim();
  if (isSlashCommandPrompt(trimmed)) return false;

  const strongIntentReasons = new Set([
    'write-intent',
    'continuation-intent',
    'decision-recall',
    'code-signal'
  ]);
  return trimmed.length > 10 || strongIntentReasons.has(adherenceDecision.reason);
}

const MAX_RETRIEVAL_CONTEXT_CHARS = 500;

export interface RetrievalQueryInput {
  prompt: string;
  currentTurn: number;
  previousUserPrompt?: string | null;
  lastAssistantSnippet?: string | null;
  adherenceDecision: AdherenceDecision;
}

function compactRetrievalContext(text: string | null | undefined): string {
  const compacted = (text || '').replace(/\s+/g, ' ').trim();
  if (compacted.length <= MAX_RETRIEVAL_CONTEXT_CHARS) return compacted;
  return `${compacted.slice(0, MAX_RETRIEVAL_CONTEXT_CHARS)}…`;
}

function shouldEnrichRetrievalQuery(input: RetrievalQueryInput): boolean {
  if (input.currentTurn <= 1) return false;
  if (!input.adherenceDecision.run) return false;
  if (input.adherenceDecision.reason === 'topic-shift' || input.adherenceDecision.reason === 'first-turn') {
    return false;
  }

  const hasPriorContext = Boolean(compactRetrievalContext(input.previousUserPrompt)) ||
    Boolean(compactRetrievalContext(input.lastAssistantSnippet));
  if (!hasPriorContext) return false;

  const reason = input.adherenceDecision.reason;
  if (reason === 'continuation-intent' || reason === 'decision-recall') return true;
  if (reason === 'write-intent' && input.prompt.trim().length <= 40) return true;
  return false;
}

export function buildRetrievalQuery(input: RetrievalQueryInput): string {
  const currentPrompt = input.prompt.trim();
  if (!shouldEnrichRetrievalQuery(input)) return currentPrompt;

  const previousUser = compactRetrievalContext(input.previousUserPrompt);
  const previousAssistant = compactRetrievalContext(input.lastAssistantSnippet);
  const parts: string[] = [];
  if (previousUser) parts.push(`Previous user: ${previousUser}`);
  if (previousAssistant) parts.push(`Previous assistant: ${previousAssistant}`);
  parts.push(`Current user: ${currentPrompt}`);
  return parts.join('\n\n');
}

function logAdherenceDecision(sessionId: string, turn: number, run: boolean, reason: string): void {
  if (!process.env.CLAUDE_MEMORY_DEBUG) return;
  const mode = run ? 'enforced' : 'skipped';
  console.error(`[adherence] session=${sessionId} turn=${turn} mode=${mode} reason=${reason}`);
}

export function getRetrievalQueryRewriteKind(prompt: string, retrievalQuery: string): 'none' | 'follow-up-context' {
  return retrievalQuery === prompt.trim() ? 'none' : 'follow-up-context';
}

/**
 * Typed reference for an injected candidate (specs R1).
 *
 * The lesson lane puts `memory_lessons.lesson_id` values in the same list as
 * event ids. Without the kind, every downstream join treated them as events:
 * lessons vanished from event-joined metrics and their access-count updates
 * matched no row.
 */
export function hookMemoryRefKind(candidate: { source?: string; type?: string }): MemoryKind {
  return candidate.source === 'lesson' || candidate.type === 'lesson' ? 'lesson' : 'event';
}

export interface HookRetrievalLaneCounts {
  semantic: number;
  keyword: number;
  graduated: number;
  lesson: number;
  thresholdFiltered: number;
  qualityFiltered: number;
  selected: number;
  minScore: number;
  topScore: number | null;
  projectHasEvents: boolean | null;
}

/**
 * Classify why a prompt-time retrieval selected nothing (specs R2).
 *
 * An empty selection is not a runtime failure. `runtime_error` is reserved for
 * a caught exception, so the 154 empty traces in the 2026-09-06 sample would
 * now be recorded as the distinct reasons below instead of a false failure
 * rate.
 */
export function classifyHookOutcomeReason(counts: HookRetrievalLaneCounts): RetrievalOutcomeReason {
  if (counts.selected > 0) return 'selected';
  const candidates = counts.semantic + counts.keyword + counts.graduated + counts.lesson;
  if (counts.projectHasEvents === false) return 'no_project_events';
  if (candidates === 0) {
    if (counts.thresholdFiltered > 0) return 'below_score_threshold';
    return 'no_keyword_candidates';
  }
  if (counts.qualityFiltered > 0) return 'quality_filtered';
  return 'below_score_threshold';
}

export function buildHookOutcomeDiagnostics(counts: HookRetrievalLaneCounts): RetrievalOutcomeDiagnostics {
  return {
    outcomeReason: classifyHookOutcomeReason(counts),
    laneCandidateCounts: {
      vector: counts.semantic,
      keyword: counts.keyword,
      summary: counts.graduated
    },
    filteredCounts: {
      threshold: counts.thresholdFiltered,
      quality: counts.qualityFiltered
    },
    topScore: counts.topScore,
    threshold: counts.minScore,
    freshnessState: 'unknown'
  };
}

export async function main(options: UserPromptSubmitMainOptions = {}): Promise<string> {
  try {
    // Read input from stdin (parse inside try so malformed JSON still emits a safe envelope)
    const input: UserPromptSubmitInput = JSON.parse(await readStdin());

    // Generate a new turn_id for this user prompt
    // This groups the prompt with subsequent tool calls and the final agent response
    const turnId = randomUUID();

    // Persist turn state so PostToolUse and Stop hooks can read it
    if (options.persistPrompt !== false && !isHookEvaluationMode()) {
      writeTurnState(input.session_id, turnId);
    }

    // Use lightweight service (SQLite only, no embedder/vector - FAST!)
    const memoryService = getLightweightMemoryService(input.session_id);

    let context = '';

    const adherenceState = readAdherenceState(input.session_id);
    const currentTurn = adherenceState.turnCount + 1;
    const adherenceDecision = shouldRunAdherenceCheck(currentTurn, input.prompt, adherenceState);
    logAdherenceDecision(input.session_id, currentTurn, adherenceDecision.run, adherenceDecision.reason);

    // On first turn of a new session, backfill helpfulness for sessions
    // that ended without Stop hook (crash, force-close, etc.)
    if (!isHookEvaluationMode() && currentTurn === 1) {
      memoryService.evaluatePendingSessions(input.session_id).catch(() => {});
    }

    // Search strategy: turn-1 always enforce adherence check,
    // then adaptively enforce on write-intent/continuation/decision/code/topic-shift/interval
    if (ENABLE_SEARCH && shouldRunMemorySearch(input.prompt, adherenceDecision)) {
      const minScore = getDynamicMinScore(input.prompt);
      let mergedMemories: HookMemoryCandidate[] = [];
      const episodeSeedCandidates: HookMemoryCandidate[] = [];
      // Lane counters feed the honest outcome reason for an empty selection
      // instead of the old runtime_error default (specs R2).
      let semanticCandidateCount = 0;
      let keywordCandidateCount = 0;
      let graduatedCandidateCount = 0;
      let lessonCandidateCount = 0;
      let thresholdFilteredCount = 0;

      // On turn 2+, enrich ambiguous follow-up retrieval with the previous user prompt
      // and assistant response so short prompts ("그거 고쳐줘") resolve correctly.
      const lastSnippet = currentTurn > 1 ? readLastAssistantSnippet(input.session_id) : null;
      const retrievalQuery = buildRetrievalQuery({
        prompt: input.prompt,
        currentTurn,
        previousUserPrompt: adherenceState.lastPrompt,
        lastAssistantSnippet: lastSnippet,
        adherenceDecision
      });
      const queryRewriteKind = getRetrievalQueryRewriteKind(input.prompt, retrievalQuery);

      const canUseSemantic = RETRIEVAL_MODE === 'semantic' || RETRIEVAL_MODE === 'hybrid';
      if (canUseSemantic) {
        try {
          const semanticMemories = await retrieveSemanticMemories(
            {
              sessionId: input.session_id,
              prompt: retrievalQuery,
              topK: MAX_MEMORIES,
              minScore
            },
            SEMANTIC_TIMEOUT_MS
          );
          mergedMemories = semanticMemories.map((memory) => ({
            ...memory,
            source: 'semantic' as const
          })).filter((memory) => !isExcludedEvaluationSession(memory.sessionId));
          semanticCandidateCount = mergedMemories.length;
        } catch {
          // Semantic retrieval is best-effort; fallback below handles the rest
        }
      }

      // Promotion is useful only if it changes recall. Add a bounded L1+
      // answer lane, but score by lexical/entity coverage before applying the
      // small level/access prior. Prompts and tool output never enter this lane.
      const graduated = await memoryService.searchGraduatedEvidence(
        retrievalQuery,
        Math.max(50, MAX_CANDIDATES * 4)
      );
      const graduatedRanks = graduated.map((result) => result.rank);
      const bestGraduatedRank = graduatedRanks.length > 0 ? Math.min(...graduatedRanks) : 0;
      const worstGraduatedRank = graduatedRanks.length > 0 ? Math.max(...graduatedRanks) : 0;
      const graduatedRankRange = worstGraduatedRank - bestGraduatedRank || 1;
      const existingGraduatedById = new Map(
        mergedMemories
          .map((memory, index) => [memory.id, index] as const)
          .filter((entry): entry is [string, number] => Boolean(entry[0]))
      );
      const scoredGraduated = graduated
        .map((result) => {
          const candidate: HookMemoryCandidate = {
            type: result.event.eventType,
            content: result.event.content,
            id: result.event.id,
            sessionId: result.event.sessionId,
            source: 'graduated',
            memoryLevel: result.level,
            accessCount: result.accessCount,
            retrievalRankScore: (worstGraduatedRank - result.rank) / graduatedRankRange
          };
          return { candidate, score: scoreGraduatedEvidence(retrievalQuery, candidate) };
        })
        .filter((item): item is { candidate: HookMemoryCandidate; score: number } => item.score !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_CANDIDATES);
      graduatedCandidateCount = scoredGraduated.length;
      for (const { candidate, score } of scoredGraduated) {
        const existingIndex = candidate.id ? existingGraduatedById.get(candidate.id) : undefined;
        if (existingIndex !== undefined) {
          // A raw vector score and a graduated lexical score are not on the
          // same calibration scale. Once an event is L1+, use the stricter
          // graduated score so a broad semantic hit cannot hide exact evidence.
          mergedMemories[existingIndex] = { ...mergedMemories[existingIndex], ...candidate, score };
          continue;
        }
        if (mergedMemories.length >= MAX_CANDIDATES) continue;
        mergedMemories.push({ ...candidate, score });
        if (candidate.id) existingGraduatedById.set(candidate.id, mergedMemories.length - 1);
      }

      // Curated lesson lane. Lessons are not events, so no other lane can ever
      // surface them; without this the lesson feature is write-only.
      if (shouldNativeInjectLessons()) { try {
        const lessons = await memoryService.listProjectLessonInjections(
          resolveCanonicalMemoryActorId(input.actor_id),
          LESSON_SCAN_LIMIT
        );
        for (const { value: lesson, injectionMode } of lessons) {
          const injectedLesson = lessonForInjection(lesson, injectionMode);
          const candidate = scoreLessonEvidence(retrievalQuery, {
            lessonId: String(injectedLesson.lessonId ?? ''),
            name: String(injectedLesson.name ?? ''),
            trigger: injectedLesson.trigger ? String(injectedLesson.trigger) : undefined,
            steps: Array.isArray(injectedLesson.steps) ? injectedLesson.steps.map(String) : [],
            failureModes: Array.isArray(injectedLesson.failureModes) ? injectedLesson.failureModes.map(String) : [],
            scope: injectedLesson.scope,
            validation: injectedLesson.validation,
            reconsiderWhen: injectedLesson.reconsiderWhen,
            validVersions: injectedLesson.validVersions,
            confidence: Number(injectedLesson.confidence ?? 0)
          });
          if (candidate) {
            mergedMemories.push(candidate);
            lessonCandidateCount += 1;
          }
        }
      } catch { /* lesson lane is supplementary */ } }

      const shouldUseKeywordFallback =
        RETRIEVAL_MODE === 'keyword' ||
        RETRIEVAL_MODE === 'hybrid' ||
        mergedMemories.length === 0;

      if (shouldUseKeywordFallback) {
        let usedFallbackFloor = false;
        const allKeywordResults = await memoryService.keywordSearch(retrievalQuery, {
          topK: MAX_EPISODE_SEED_CANDIDATES,
          // Episode seeding intentionally accepts tool_observation matches:
          // a tool call from the same turn is often the strongest anchor for
          // finding that turn's answer (selectHookEpisodeSeeds handles the
          // type-aware ranking). This opt-in preserves that behavior now that
          // keywordSearch excludes tool_observation by default.
          includeToolObservations: true
        });
        keywordCandidateCount = allKeywordResults.length;
        let results = allKeywordResults.filter((result) => result.score >= minScore);
        thresholdFilteredCount = allKeywordResults.length - results.length;

        // recall rescue: if nothing found at tuned threshold, retry with fallback floor
        if (results.length === 0 && FALLBACK_MIN_SCORE < minScore) {
          usedFallbackFloor = true;
          results = allKeywordResults.filter((result) => result.score >= FALLBACK_MIN_SCORE);
          thresholdFilteredCount = allKeywordResults.length - results.length;
        }

        for (const result of allKeywordResults) {
          episodeSeedCandidates.push({
            type: result.event.eventType,
            content: result.event.content,
            id: result.event.id,
            sessionId: result.event.sessionId,
            score: result.score,
            source: 'keyword',
            fallback: result.score < minScore
          });
        }

        const existingById = new Map(
          mergedMemories
            .map((memory, index) => [memory.id, index] as const)
            .filter((entry): entry is [string, number] => Boolean(entry[0]))
        );
        for (const r of results) {
          const keywordCandidate: HookMemoryCandidate = {
            type: r.event.eventType,
            content: r.event.content,
            id: r.event.id,
            sessionId: r.event.sessionId,
            score: r.score,
            source: 'keyword',
            fallback: usedFallbackFloor
          };
          const existingIndex = existingById.get(r.event.id);
          if (existingIndex !== undefined) {
            const existing = mergedMemories[existingIndex];
            // Semantic and FTS scores have different calibration. An exact
            // keyword prompt must not keep a weaker semantic score merely
            // because it entered the merged list first; that suppresses the
            // same-turn episode bridge for otherwise exact recall queries.
            if ((existing?.score ?? 0) < r.score) {
              mergedMemories[existingIndex] = {
                ...existing,
                score: r.score,
                source: 'keyword',
                fallback: usedFallbackFloor
              };
            }
            continue;
          }
          mergedMemories.push(keywordCandidate);
          existingById.set(r.event.id, mergedMemories.length - 1);
          // Keep a bounded second lane instead of letting semantic/graduated
          // candidates fill the entire pool before exact FTS prompts arrive.
          if (mergedMemories.length >= MAX_CANDIDATES * 2) break;
        }
      }

      const injectionPolicy = getHookInjectionPolicy();
      const episodeSeedPool = Array.from(new Map(
        [...mergedMemories, ...episodeSeedCandidates]
          .filter((candidate): candidate is HookMemoryCandidate & { id: string } => Boolean(candidate.id))
          .map((candidate) => [candidate.id, candidate])
      ).values());
      const episodeSeeds = selectHookEpisodeSeeds(episodeSeedPool, injectionPolicy, retrievalQuery);
      const episodeEvidence = await expandEpisodeEvidence(memoryService, episodeSeeds);
      const injectableMemories = reserveLessonSlot(
        filterHookInjectableMemories(
          [...mergedMemories, ...episodeEvidence],
          injectionPolicy,
          retrievalQuery
        ),
        mergedMemories,
        injectionPolicy
      );

      // One trace id shared by the query trace and every helpfulness row it
      // produced, so the dashboard can show question -> memories -> evidence.
      const retrievalTraceId = randomUUID();
      // Request identity for this hook invocation. Any other trace written for
      // the same request collapses onto this row instead of double-counting
      // the client's request volume (specs R2).
      const deliveryClient = options.deliveryClient ?? 'claude-hook';
      const retrievalRequestId = `${deliveryClient}:${input.session_id}:${turnId}`;

      if (injectableMemories.length > 0) {
        let referenceItems: MemoryReferenceItem[] = injectableMemories;
        if (options.contextPresentation === 'reference') {
          referenceItems = await Promise.all(injectableMemories.map(async (memory) => {
            if (!memory.id) return memory;
            if (memory.source === 'lesson') {
              return { ...memory, sourceKind: 'lesson' as const };
            }
            try {
              const event = await memoryService.getEvent(memory.id);
              return event
                ? {
                    ...memory,
                    timestamp: event.timestamp,
                    sessionId: event.sessionId,
                    metadata: event.metadata,
                    sourceKind: 'event' as const
                  }
                : { ...memory, sourceKind: 'event' as const };
            } catch {
              return { ...memory, sourceKind: 'event' as const };
            }
          }));
        }

        // Increment access count only for high-confidence memories injected into
        // the prompt, and only for the ones that are actually events: a lesson
        // id never matched a row in events, so those access writes were lost.
        const injectedRefs = injectableMemories
          .filter((m): m is HookMemoryCandidate & { id: string } => Boolean(m.id))
          .map((m) => ({ kind: hookMemoryRefKind(m), id: m.id }));
        if (!isHookEvaluationMode() && injectedRefs.length > 0) {
          await memoryService.incrementMemoryAccess(injectedRefs);
        }

        // Record each injected retrieval for helpfulness tracking.
        for (const m of isHookEvaluationMode() ? [] : injectableMemories) {
          if (!m.id) continue;
          try {
            await memoryService.recordRetrieval(
              m.id,
              input.session_id,
              m.score ?? minScore,
              redactForStorage(input.prompt),
              {
                traceId: retrievalTraceId,
                source: 'user_prompt',
                memoryKind: hookMemoryRefKind(m),
                // Formatted, not delivered. The delivery reporter below raises
                // this to emitted only after stdout actually accepts the write.
                deliveryStatus: 'formatted',
                deliveryEvidence: 'context_formatted',
                presentationMode: options.contextPresentation ?? 'evidence',
                triggerType: 'user_prompt',
                deliveryClient,
                requestId: retrievalRequestId,
                injectedContent: options.contextPresentation === 'reference'
                  ? memoryReferenceSummary(m.content, retrievalQuery)
                  : memoryEvidencePreview(m, retrievalQuery)
              }
            );
          } catch { /* non-critical */ }
        }

        context = options.contextPresentation === 'reference'
          ? formatMemoryReferenceContext(referenceItems, {
              heading: 'Memory index for this question',
              query: retrievalQuery
            })
          : formatMemoryContext(injectableMemories, retrievalQuery);
      }

      // Record query-level trace for dashboard stats (retrieval_traces table)
      const allCandidateIds = mergedMemories.map((m) => m.id).filter((v): v is string => Boolean(v));
      const selectedIds = injectableMemories.map((m) => m.id).filter((v): v is string => Boolean(v));
      const selectedKeys = new Set(injectableMemories
        .filter((m) => Boolean(m.id))
        .map((m) => `${hookMemoryRefKind(m)}:${m.id}`));
      // Typed items keep the event/lesson split that the flat id arrays lose.
      // Only a hash of the delivered excerpt is stored — never the excerpt —
      // so telemetry cannot resurrect the text of a deleted memory (specs R1).
      const traceItems = [...mergedMemories, ...injectableMemories]
        .filter((m): m is HookMemoryCandidate & { id: string } => Boolean(m.id))
        .map((m, index) => {
          const selected = selectedKeys.has(`${hookMemoryRefKind(m)}:${m.id}`);
          return {
            kind: hookMemoryRefKind(m),
            id: m.id,
            rank: index,
            score: m.score ?? null,
            selected,
            contentHash: selected
              ? memoryContentHash(options.contextPresentation === 'reference'
                ? memoryReferenceSummary(m.content, retrievalQuery)
                : selectEvidencePreview(m.content, retrievalQuery))
              : null
          };
        });
      if (!isHookEvaluationMode()) {
        // Only consulted when nothing was selected, so the common path pays
        // nothing for distinguishing "empty project" from "nothing matched".
        let projectHasEvents: boolean | null = null;
        if (injectableMemories.length === 0) {
          try {
            projectHasEvents = (await memoryService.getRecentEvents(1)).length > 0;
          } catch {
            projectHasEvents = null;
          }
        }
        const outcomeDiagnostics = buildHookOutcomeDiagnostics({
          semantic: semanticCandidateCount,
          keyword: keywordCandidateCount,
          graduated: graduatedCandidateCount,
          lesson: lessonCandidateCount,
          thresholdFiltered: thresholdFilteredCount,
          qualityFiltered: Math.max(0, mergedMemories.length - injectableMemories.length),
          selected: injectableMemories.length,
          minScore,
          topScore: mergedMemories.reduce<number | null>(
            (top, memory) => (typeof memory.score === 'number' && (top === null || memory.score > top) ? memory.score : top),
            null
          ),
          projectHasEvents
        });
        try {
          await memoryService.recordQueryTrace({
            traceId: retrievalTraceId,
            sessionId: input.session_id,
            queryText: redactForStorage(retrievalQuery),
            rawQueryText: redactForStorage(input.prompt),
            queryRewriteKind,
            strategy: RETRIEVAL_MODE,
            candidateEventIds: allCandidateIds,
            selectedEventIds: selectedIds,
            items: traceItems,
            confidence: summarizeHookInjectionConfidence(injectableMemories),
            presentationMode: options.contextPresentation ?? 'evidence',
            triggerType: 'user_prompt',
            deliveryClient,
            requestId: retrievalRequestId,
            runtimeVersion: process.env.CLAUDE_MEMORY_LAYER_VERSION,
            outcomeDiagnostics
          });
        } catch { /* non-critical */ }

        // Delivery is proven by the stdout write, not by selection (specs R3).
        if (injectableMemories.length > 0) {
          registerHookDeliveryReporter(async (outcome) => {
            try {
              await memoryService.recordDeliveryOutcome({
                traceId: retrievalTraceId,
                status: outcome.status,
                evidence: outcome.status === 'emitted' ? 'hook_stdout' : 'write_error'
              });
            } catch { /* delivery telemetry is best-effort */ }
          });
        }

        // Access/helpfulness evidence above must be durable before graduation
        // is scheduled. The daemon only acknowledges the schedule here; the
        // bounded pass runs later and never delays this hook with worker work.
        try {
          await scheduleSemanticGraduation(input.session_id);
        } catch { /* non-critical */ }
      }
    }

    // Persist after retrieval so the current prompt cannot be retrieved as an
    // exact keyword match and injected back into the same turn.
    if (shouldPersistSubmittedPrompt(input.prompt, options)) {
      await memoryService.storeUserPrompt(
        input.session_id,
        redactForStorage(input.prompt),
        {
          turnId,
          adherence: {
            checked: adherenceDecision.run,
            reason: adherenceDecision.reason,
            turn: currentTurn
          }
        }
      );
    }

    if (!isHookEvaluationMode()) {
      writeAdherenceState({
        sessionId: input.session_id,
        turnCount: currentTurn,
        lastCheckedTurn: adherenceDecision.run ? currentTurn : adherenceState.lastCheckedTurn,
        // Also redacted: this file feeds the next turn's retrieval-query
        // enrichment, so an unfiltered prompt here would resurface a secret.
        lastPrompt: redactForStorage(input.prompt),
        lastReason: adherenceDecision.reason,
        updatedAt: new Date().toISOString()
      });
    }

    const output: UserPromptSubmitOutput = JSON.parse(formatClaudeContextHookOutput('UserPromptSubmit', context));
    return JSON.stringify(output);
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Memory hook error:', error);
    }
    return formatClaudeContextHookOutput('UserPromptSubmit', '');
  }
}

export function lessonForInjection(
  lesson: { lessonId: string; revision?: number; name: string; trigger: string; steps: string[]; failureModes: string[]; confidence: number; scope?: string; validation?: string[]; reconsiderWhen?: string; validVersions?: string[] },
  injectionMode: 'direct' | 'summary' | 'reference'
) {
  if (injectionMode === 'direct') return lesson;
  if (injectionMode === 'summary') {
    return { ...lesson, steps: [...lesson.steps.slice(0, 2), `[partial lesson; retrieve full body with mem-lesson-get lessonId=${lesson.lessonId} revision=${lesson.revision ?? 1}]`], failureModes: lesson.failureModes };
  }
  return {
    ...lesson,
    name: `[lesson:${lesson.lessonId}] ${lesson.name}`,
    trigger: '',
    scope: undefined, validation: [], reconsiderWhen: undefined, validVersions: [],
    steps: [`[reference only; retrieve with mem-lesson-get lessonId=${lesson.lessonId} revision=${lesson.revision ?? 1}]`],
    failureModes: []
  };
}
