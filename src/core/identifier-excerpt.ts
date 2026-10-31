/**
 * Identifier-anchored excerpts (CLAUDE_MEMORY_IDENTIFIER_EXCERPT_EXPERIMENT).
 *
 * Injected memories are cut to a fixed character budget, and the cut used to
 * keep the head. Grounding comes from concrete identifiers — file paths,
 * PR/issue numbers, commit SHAs, branch names, versions: full agent_response
 * text scored content_overlap 0.53-0.94 while abstract summaries scored about
 * 0. So when nothing in the query anchors the excerpt, the window that holds
 * the most distinct identifiers is used instead of the head.
 *
 * Extraction is regex-only, as in MemPalace `palace/closets.py`
 * `build_closet_lines`. Text is split into tokens first and each token is
 * matched whole, so cost stays linear on a pasted blob.
 */

const IDENTIFIER_TOKEN = /[^\s,;()[\]{}"'`<>|]+/g;
// Leading brackets/markup and trailing punctuation or Korean particles
// (`src/a.ts를`, `#122에서`) are not part of the identifier.
const LEADING_EDGE = /^[^\w~@./#]+/;
const TRAILING_EDGE = /[^\w~@-]+$/;
const MAX_IDENTIFIER_LENGTH = 200;
// A path needs a file extension or at least two separators, so `A/B`,
// `and/or`, `src/core`, and slash commands like `/role-context` are not
// identifiers; a one-separator branch needs a conventional prefix.
const IDENTIFIER = new RegExp([
  /[A-Za-z][\w+.-]*:\/\/\S+/.source,
  /[\w.~@/-]*\/[\w.@-]*[\w-]\.[A-Za-z]\w{0,7}(?::\d+)*/.source,
  /[\w.@-]*[\w-]\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|sql|sh|ya?ml|toml|sqlite)(?::\d+)*/.source,
  /[\w.~@-]*(?:\/[\w.@-]+){2,}\/?/.source,
  /(?:feat|fix|chore|docs|refactor|test|perf|ci|build|release|hotfix|feature|bugfix|origin|upstream)\/[\w.\/-]*\w/.source,
  /(?:#|PR#?|pr#?)\d+/.source,
  /(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}/.source,
  /v?\d+\.\d+\.\d+(?:-[\w.]+)?/.source
].map((source) => `^(?:${source})$`).join('|'));
const REFERENCE_PREFIX = /^(?:PR|pr|issue|issues|이슈)$/;
const CODE_BLOCK = /```[\s\S]*?```/g;
const MAX_CODE_BLOCK_IDENTIFIERS = 5;
/** How far before an identifier a window may start, to pick up its sentence. */
const LEAD_IN_RATIO = 0.25;
const SENTENCE_START = /[.!?]\s+|\s\/\s|다\s+|\n+/;

export interface IdentifierSpan {
  value: string;
  start: number;
  end: number;
}

export const identifierExcerptEnabled = () => process.env.CLAUDE_MEMORY_IDENTIFIER_EXCERPT_EXPERIMENT === 'true';

export function findIdentifiers(text: string): IdentifierSpan[] {
  const spans: IdentifierSpan[] = [];
  let previous = '';
  for (const match of text.matchAll(IDENTIFIER_TOKEN)) {
    const raw = match[0];
    const lead = raw.match(LEADING_EDGE)?.[0].length ?? 0;
    const value = raw.slice(lead).replace(TRAILING_EDGE, '');
    const isReference = /^\d+$/.test(value) && REFERENCE_PREFIX.test(previous);
    previous = value;
    if (!value || value.length > MAX_IDENTIFIER_LENGTH) continue;
    if (!isReference && !IDENTIFIER.test(value)) continue;
    const start = match.index + lead;
    spans.push({ value, start, end: start + value.length });
  }
  return spans;
}

/**
 * Offset of the `budget`-long window holding the most distinct identifiers.
 * The head (0) wins ties, so a memory whose head is already as dense as any
 * other window is excerpted exactly as before.
 */
export function identifierWindowStart(text: string, budget: number): number {
  if (text.length <= budget) return 0;
  const spans = findIdentifiers(text);
  let best = 0;
  let bestCount = distinctIn(spans, 0, budget);
  for (const span of spans) {
    const start = sentenceStartBefore(text, span.start, budget);
    if (start <= best) continue;
    const count = distinctIn(spans, start, start + budget);
    if (count > bestCount) {
      best = start;
      bestCount = count;
    }
  }
  return best;
}

/** Replaces each fenced code block with the identifiers it contained. */
export function keepCodeBlockIdentifiers(text: string): string {
  return text.replace(CODE_BLOCK, (block) => {
    const kept = [...new Set(findIdentifiers(block).map((span) => span.value))].slice(0, MAX_CODE_BLOCK_IDENTIFIERS);
    return kept.length > 0 ? `[code: ${kept.join(' ')}]` : '[code]';
  });
}

function distinctIn(spans: IdentifierSpan[], from: number, to: number): number {
  const seen = new Set<string>();
  for (const span of spans) {
    if (span.start >= to) break;
    if (span.start >= from && span.end <= to) seen.add(span.value);
  }
  return seen.size;
}

function sentenceStartBefore(text: string, at: number, budget: number): number {
  const from = Math.max(0, at - Math.floor(budget * LEAD_IN_RATIO));
  if (from === 0) return 0;
  const region = text.slice(from, at);
  const boundary = region.match(SENTENCE_START);
  if (boundary?.index !== undefined) return from + boundary.index + boundary[0].length;
  const space = region.search(/\s/);
  return space >= 0 ? from + space + 1 : at;
}
