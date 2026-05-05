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
