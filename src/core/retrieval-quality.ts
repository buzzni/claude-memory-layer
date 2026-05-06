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
  /^\s*(?:이어서(?:\s*진행해줘)?|계속(?:\s*해줘)?|다음\s*(?:단계|작업|추천\s*작업|추천|할\s*일)?(?:은|는)?(?:\s*뭐야)?\??|추천\s*작업(?:은|는)?(?:\s*뭐야)?\??|진행해줘)\s*$/i
];

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

export function shouldApplyTechnicalGuard(query: string): boolean {
  return extractTechnicalQueryTerms(query).length > 0;
}
