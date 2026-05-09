/**
 * Retrieval quality guards.
 *
 * These are deliberately small deterministic heuristics used to avoid injecting
 * obviously irrelevant memories. They are not a second source of truth; they
 * only filter candidate retrieval results before context assembly.
 */

const COMMAND_ARTIFACT_PATTERNS = [
  /<\/?(?:local-command-(?:stdout|stderr)|command-(?:name|message))\b/i,
  /<command-name>[\s\S]*?<\/command-name>/i,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/i,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/i
];

const LOW_SIGNAL_CONTEXT_PATTERNS = [
  /<environment_context\b[\s\S]*<\/environment_context>/i,
  /<turn_aborted>/i,
  /^#\s*AGENTS\.md\s+instructions\b[\s\S]*<INSTRUCTIONS>/i,
  /^\s*(?:understood[,\s.]*)?(?:stopping|stopped|pausing|paused)\s+here\b[\s\S]{0,180}\blet\s+me\s+know\s+when\s+you(?:'d|\s+would)?\s+like\s+to\s+continue\b/i,
  /^➜\s+\S+\s+git:\([^)]*\)\s+/i,
  /^\$\s+\S+/i
];

const CONTINUATION_QUERY_PATTERNS = [
  /^\s*(?:continue|resume|next|what(?:'s| is)? next|next\s+(?:step|task|action)|recommended\s+(?:next\s+)?(?:step|task|action)|what should (?:we|i) do next)\??\s*$/i,
  /^\s*(?:응\s*)?(?:이어서(?:\s*진행(?:해줘)?)?|계속(?:\s*해줘)?|다음\s*(?:단계|작업|추천\s*작업|추천|할\s*일)?(?:은|는)?(?:\s*(?:뭐야|진행(?:해줘)?))?\??|남은\s*(?:추가(?:로)?\s*)?(?:(?:할\s*만한\s*)?(?:작업|일)|할\s*일)?(?:은|는)?\s*(?:있어|있나|있나요|뭐야)\??|추천\s*작업(?:은|는)?(?:\s*뭐야)?\??|진행해줘)\s*$/i
];

const SHORT_REPAIR_FOLLOW_UP_PATTERNS = [
  /^\s*(?:fix\s+(?:it|that)|repair\s+(?:it|that)|resolve\s+(?:it|that)|that\s+bug|same\s+issue)\s*$/i,
  /^\s*(?:그거|그것|이거|이것)?\s*(?:고쳐줘|수정해줘|해결해줘|처리해줘)\s*$/i
];

const CURRENT_STATE_QUERY_PATTERNS = [
  /\bcurrent\b.*\b(?:state|status|deployment|blocker|pr|pull request)\b/i,
  /\b(?:still|as current|current)\b.*\b(?:unresolved|open|pending|not completed)\b/i,
  /\b(?:old|obsolete|stale|resolved|already resolved)\b.*\b(?:current|still|unresolved|open|state|status)\b/i,
  /(?:현재|아직|이전|오래된|해결된).*(?:상태|미해결|열린|블로커|PR|풀리퀘스트)/i
];

const STALE_CONTENT_PATTERNS = [
  /\b(?:obsolete|superseded|outdated)\b/i,
  /\bstale\s+(?:operational\s+)?state\b/i,
  /\bstale\s+after\b/i,
  /\bno\s+longer\s+(?:valid|current|applies?)\b/i,
  /\bearlier\s+(?:pull request|pr)\b[\s\S]{0,160}\b(?:open|not completed|had not completed)\b/i,
  /\bshould\s+not\s+be\s+injected\s+as\s+current\s+context\b/i,
  /(?:오래된|더 이상 유효하지|현재 상태가 아님)/i
];

const CONTINUATION_EXPANSION = 'current next step plan roadmap status validation replay rerank memory usefulness continuation';
const REPAIR_FOLLOW_UP_EXPANSION = 'review blocker fix pattern dashboard error state metrics bucket validation sanitize rerun unresolved';
const RETRIEVAL_PRIVACY_DECISION_EXPANSION = 'retrieval telemetry privacy public api dashboard dashboards rawQueryText queryText raw query text expose safe trace metadata trace id reason strategy rewrite kind aggregate count counts candidate selected public panel';

const DECISION_RECALL_TERMS = new Set([
  'decide',
  'decided',
  'decision',
  'agreed',
  'policy',
  'constraint'
]);

const RETRIEVAL_PRIVACY_SURFACE_TERMS = new Set([
  'retrieval',
  'dashboard',
  'telemetry',
  'trace'
]);

const DECISION_TOPIC_WEAK_TERMS = new Set([
  'api',
  'dashboard',
  'retrieval',
  'trace',
  'telemetry',
  'query',
  'raw',
  'count',
  'counts'
]);

const GENERIC_TECHNICAL_TERMS = new Set([
  'api',
  'cli',
  'ui',
  'json',
  'jsonl',
  'html',
  'http',
  'https',
  'url',
  'uri',
  'id',
  'ids',
  'uuid',
  'db',
  'sql'
]);

const LOW_INFORMATION_QUERY_TERMS = new Set([
  'the',
  'and',
  'or',
  'for',
  'from',
  'with',
  'without',
  'about',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'how',
  'did',
  'does',
  'do',
  'we',
  'i',
  'in',
  'to',
  'of',
  'on',
  'as',
  'be',
  'was',
  'were',
  'decide',
  'decided',
  'decision',
  'agreed',
  'policy',
  'constraint',
  'showing',
  'can',
  'you',
  'me',
  'show',
  'tell',
  'please',
  'should',
  'would',
  'could',
  'this',
  'that',
  'these',
  'those',
  'use',
  'using',
  'treat',
  'continue',
  'resume',
  'next',
  'step',
  'task',
  'action',
  'current',
  'state',
  'status',
  'old',
  'already',
  'still',
  'near',
  'today',
  '응',
  '그거',
  '그것',
  '이거',
  '이것',
  '다음',
  '단계',
  '진행',
  '진행해줘',
  '계속',
  '이어서',
  '고쳐줘',
  '수정해줘',
  '해결해줘'
]);

export function isCommandArtifactQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  const normalized = trimmed.toLowerCase();
  if (normalized.includes('local-command-stdout') || normalized.includes('local-command-stderr')) return true;
  if (normalized.includes('command-name') || normalized.includes('command-message')) return true;
  return COMMAND_ARTIFACT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isCommandArtifactContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  const normalized = trimmed.toLowerCase();
  if (normalized.includes('local-command-stdout') || normalized.includes('local-command-stderr')) return true;
  if (normalized.includes('command-name') || normalized.includes('command-message')) return true;
  return COMMAND_ARTIFACT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isLowSignalContextContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  if (isCommandArtifactContent(trimmed)) return true;
  if (LOW_SIGNAL_CONTEXT_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  return false;
}

export function isGenericContinuationQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  if (!CONTINUATION_QUERY_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
  if (extractTechnicalQueryTerms(trimmed).length > 0) return false;

  const tokens = trimmed.match(/[A-Za-z0-9가-힣#._/-]+/g) ?? [];
  if (tokens.length > 10) return false;

  return !/[A-Za-z0-9_-]+\.[A-Za-z0-9]+/.test(trimmed) &&
    !/(?:^|\s)(?:feat|fix|chore|refactor|docs)\/[A-Za-z0-9._-]+/.test(trimmed) &&
    !/[A-Za-z]:?[\\/]|\/Users\/|\.\/|\.\.\//.test(trimmed);
}

export function isShortRepairFollowUpQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  if (extractTechnicalQueryTerms(trimmed).length > 0) return false;
  const tokens = trimmed.match(/[A-Za-z0-9가-힣#._/-]+/g) ?? [];
  if (tokens.length > 8) return false;
  return SHORT_REPAIR_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isCurrentStateQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  return CURRENT_STATE_QUERY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isStaleOrSupersededContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return STALE_CONTENT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function buildRetrievalQualityQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return query;
  if (isRetrievalPrivacyDecisionQuery(trimmed)) {
    return `${trimmed} ${RETRIEVAL_PRIVACY_DECISION_EXPANSION}`;
  }
  if (isGenericContinuationQuery(trimmed)) {
    return `${trimmed} ${CONTINUATION_EXPANSION}`;
  }
  if (isShortRepairFollowUpQuery(trimmed)) {
    return `${trimmed} ${REPAIR_FOLLOW_UP_EXPANSION}`;
  }
  return query;
}

export function isRetrievalPrivacyDecisionQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;

  const terms = new Set(tokenizeQualityText(trimmed));
  const hasDecisionSignal = hasAnyTerm(terms, DECISION_RECALL_TERMS) || /(?:결정|정책|원칙)/i.test(trimmed);
  if (!hasDecisionSignal) return false;

  const hasRawQuerySignal = terms.has('raw') && terms.has('query');
  const hasPrivacySignal = terms.has('privacy') || terms.has('expose') || terms.has('redacted');
  const hasRetrievalSurface = hasAnyTerm(terms, RETRIEVAL_PRIVACY_SURFACE_TERMS) ||
    (terms.has('api') && terms.has('query'));
  const hasQuerySurface = terms.has('query') && (
    terms.has('dashboard') ||
    terms.has('trace') ||
    terms.has('telemetry') ||
    terms.has('api')
  );
  const hasKoreanRetrievalSurface = /(?:검색|리트리벌|retrieval|대시보드|트레이스|텔레메트리|telemetry)/i.test(trimmed);
  const hasKoreanPrivacySurface = /(?:원문|쿼리|프라이버시|개인정보|노출|트레이스|메타데이터)/i.test(trimmed);

  return (hasRetrievalSurface || (hasKoreanRetrievalSurface && hasKoreanPrivacySurface)) &&
    (hasRawQuerySignal || hasPrivacySignal || hasQuerySurface || hasKoreanPrivacySurface);
}

export function extractTechnicalQueryTerms(query: string): string[] {
  const matches = query.match(/[A-Za-z][A-Za-z0-9_.:-]{2,}/g) ?? [];
  const terms = matches.filter((term) => {
    const lower = term.toLowerCase();
    if (GENERIC_TECHNICAL_TERMS.has(lower)) return false;
    return /[._:-]/.test(term) || /[a-z][A-Z]/.test(term) || /[A-Z]{2,}/.test(term) || /\d/.test(term);
  });

  return Array.from(new Set(terms.map((term) => term.toLowerCase())));
}

export function hasTechnicalTermOverlap(query: string, content: string): boolean {
  const terms = extractTechnicalQueryTerms(query);
  if (terms.length === 0) return true;

  const normalizedContent = content.toLowerCase();
  return terms.some((term) => normalizedContent.includes(term));
}

export function hasDiscriminativeTermOverlap(query: string, content: string): boolean {
  const queryTerms = extractDiscriminativeQueryTerms(query);
  const contentTerms = new Set(tokenizeQualityText(content));
  if (isRetrievalPrivacyDecisionQuery(query) && hasRetrievalPrivacyDecisionContent(contentTerms)) {
    return true;
  }
  if (shouldRequireDecisionTopicOverlap(query)) {
    const topicTerms = queryTerms.filter((term) => !DECISION_TOPIC_WEAK_TERMS.has(term));
    if (topicTerms.length > 0) {
      return topicTerms.some((term) => contentTerms.has(term));
    }
  }
  if (queryTerms.length < 3) return true;
  const requiredHits = queryTerms.length >= 3 ? 2 : 1;
  let hits = 0;
  for (const term of queryTerms) {
    if (contentTerms.has(term)) hits += 1;
    if (hits >= requiredHits) return true;
  }
  return false;
}

export function shouldApplyTechnicalGuard(query: string): boolean {
  return extractTechnicalQueryTerms(query).length > 0;
}

function hasAnyTerm(terms: Set<string>, expectedTerms: Set<string>): boolean {
  let found = false;
  expectedTerms.forEach((term) => {
    if (terms.has(term)) found = true;
  });
  return found;
}

function shouldRequireDecisionTopicOverlap(query: string): boolean {
  if (isRetrievalPrivacyDecisionQuery(query)) return false;
  const trimmed = query.trim();
  if (!trimmed) return false;
  const terms = new Set(tokenizeQualityText(trimmed));
  return hasAnyTerm(terms, DECISION_RECALL_TERMS) || /(?:결정|정책|원칙)/i.test(trimmed);
}

function extractDiscriminativeQueryTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of tokenizeQualityText(query)) {
    if (LOW_INFORMATION_QUERY_TERMS.has(token)) continue;
    if (GENERIC_TECHNICAL_TERMS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms;
}

function hasRetrievalPrivacyDecisionContent(contentTerms: Set<string>): boolean {
  const hasDashboardTraceMetadata = contentTerms.has('dashboard') &&
    (contentTerms.has('trace') || contentTerms.has('metadata')) &&
    (
      contentTerms.has('safe') ||
      contentTerms.has('strategy') ||
      contentTerms.has('rewrite') ||
      contentTerms.has('candidate') ||
      contentTerms.has('selected') ||
      contentTerms.has('count') ||
      contentTerms.has('reason')
    );
  const hasRawQueryPrivacyPolicy = contentTerms.has('retrieval') &&
    (
      contentTerms.has('privacy') ||
      contentTerms.has('expose') ||
      (
        contentTerms.has('raw') &&
        contentTerms.has('query') &&
        (
          contentTerms.has('dashboard') ||
          contentTerms.has('telemetry') ||
          contentTerms.has('api') ||
          contentTerms.has('public')
        )
      )
    );
  return hasDashboardTraceMetadata || hasRawQueryPrivacyPolicy;
}

function tokenizeQualityText(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^A-Za-z0-9가-힣\s_.:-]/g, ' ')
    .split(/\s+/)
    .flatMap((token) => token.split(/(?=[._:-])|(?<=[._:-])/g))
    .map((token) => normalizeQualityToken(token.replace(/^[._:-]+|[._:-]+$/g, '')))
    .filter((token) => token.length >= 2);
}

function normalizeQualityToken(token: string): string {
  if (token === 'apis') return 'api';
  if (token === 'ids') return 'id';
  if (LOW_INFORMATION_QUERY_TERMS.has(token) || GENERIC_TECHNICAL_TERMS.has(token)) return token;
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (
    token.length > 3 &&
    token.endsWith('s') &&
    !token.endsWith('ss') &&
    !token.endsWith('us') &&
    !token.endsWith('is')
  ) {
    return token.slice(0, -1);
  }
  return token;
}
