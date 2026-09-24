/**
 * Usefulness Evidence
 *
 * Pure content-grounding analysis between an injected memory and the
 * assistant responses that followed it. Answers "did the answer actually
 * use this memory?" with a 0..1 grounding score plus the matched snippet
 * pairs that justify it, so the dashboard can show evidence per question.
 *
 * Handles both space-delimited text and CJK-heavy text (character bigrams).
 */

export interface ResponseDocument {
  id: string;
  content: string;
}

export interface EvidenceMatch {
  /** Snippet of the memory that was found in a response */
  memorySnippet: string;
  /** The region of the response where the match occurred */
  responseSnippet: string;
  /** Event id of the matching agent_response */
  responseEventId: string;
  /** 0..1 similarity of this snippet match */
  similarity: number;
  matchType: 'exact' | 'term-overlap';
}

export interface MemoryUsageEvidence {
  /** 0..1 — how strongly the responses are grounded in this memory */
  contentOverlapScore: number;
  /** Fraction of memory snippets that matched some response (0..1) */
  coverage: number;
  /** Best matches, strongest first */
  matches: EvidenceMatch[];
}

const MAX_SNIPPETS = 40;
const MAX_MATCHES = 5;
const MIN_SNIPPET_LENGTH = 12;
const MAX_SNIPPET_LENGTH = 300;
const RESPONSE_CONTEXT_CHARS = 160;
const STRONG_MATCH_THRESHOLD = 0.55;
// A snippet must carry at least this many informative tokens before any
// match counts as evidence — otherwise a single generic word shared with the
// answer (e.g. a "## Configuration" heading) scores as full grounding.
const MIN_SNIPPET_TOKENS = 3;

/** Words too generic to signal grounding on their own. */
const STOP_TOKENS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has',
  'was', 'were', 'are', 'not', 'but', 'you', 'your', 'can', 'will',
  'should', 'would', 'could', 'when', 'what', 'which', 'their', 'there',
  'then', 'than', 'into', 'over', 'also', 'only', 'some', 'such', 'use',
  'used', 'using'
]);

/**
 * Lowercase and strip punctuation/markdown so the same phrasing matches even
 * when only punctuation differs. Applied consistently to memory snippets and
 * responses, so exact-containment stays valid.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣一-鿿぀-ヿ\s_/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Latin/numeric identifiers (3+ chars) or runs of Hangul / CJK / kana.
const TOKEN_PATTERN = /[a-z0-9_/-]{3,}|[가-힣一-鿿぀-ヿ]+/g;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const wordMatches = text.match(TOKEN_PATTERN) || [];
  for (const rawMatch of wordMatches) {
    const raw = rawMatch.replace(/^[/-]+|[/-]+$/g, '');
    if (raw.length < 1) continue;
    if (/^[a-z0-9_/-]+$/.test(raw)) {
      if (raw.length >= 3 && !STOP_TOKENS.has(raw)) tokens.push(raw);
      continue;
    }
    // CJK run: split into character bigrams so partial phrasing still matches.
    if (raw.length === 1) {
      tokens.push(raw);
      continue;
    }
    for (let i = 0; i < raw.length - 1; i++) {
      tokens.push(raw.slice(i, i + 2));
    }
  }
  return tokens;
}

/**
 * Split memory content into candidate snippets worth searching for in
 * responses: lines and sentence-ish fragments of meaningful length.
 */
export function extractMemorySnippets(content: string): string[] {
  const seen = new Set<string>();
  const snippets: string[] = [];

  const push = (raw: string) => {
    const trimmed = raw.replace(/^[-*>\d.\s]+/, '').trim();
    if (trimmed.length < MIN_SNIPPET_LENGTH) return;
    const clipped = trimmed.slice(0, MAX_SNIPPET_LENGTH);
    const key = normalizeText(clipped);
    if (!key || key.length < MIN_SNIPPET_LENGTH || seen.has(key)) return;
    seen.add(key);
    snippets.push(clipped);
  };

  for (const line of content.split(/\n+/)) {
    if (snippets.length >= MAX_SNIPPETS) break;
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    // Markdown headings are structural labels, not facts — a heading word
    // reappearing in an answer says nothing about memory reuse.
    if (/^#{1,6}\s/.test(trimmedLine)) continue;
    if (trimmedLine.length <= MAX_SNIPPET_LENGTH) {
      push(trimmedLine);
      continue;
    }
    // Long line: fall back to sentence-ish fragments.
    for (const sentence of trimmedLine.split(/(?<=[.!?。])\s+|;\s+/)) {
      if (snippets.length >= MAX_SNIPPETS) break;
      push(sentence);
    }
  }

  return snippets;
}

function findResponseWindow(
  normalizedResponse: string,
  originalResponse: string,
  needle: string
): string {
  const index = normalizedResponse.indexOf(needle);
  if (index < 0) {
    return originalResponse.slice(0, RESPONSE_CONTEXT_CHARS);
  }
  // The normalized text is not position-aligned with the original, so
  // approximate by proportional position — good enough for a preview snippet.
  const ratio = normalizedResponse.length > 0 ? index / normalizedResponse.length : 0;
  const approxStart = Math.max(0, Math.floor(originalResponse.length * ratio) - 40);
  return originalResponse.slice(approxStart, approxStart + RESPONSE_CONTEXT_CHARS).trim();
}

function findTermWindow(originalResponse: string, terms: string[]): string {
  const lower = originalResponse.toLowerCase();
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0) {
      const start = Math.max(0, index - 40);
      return originalResponse.slice(start, start + RESPONSE_CONTEXT_CHARS).trim();
    }
  }
  return originalResponse.slice(0, RESPONSE_CONTEXT_CHARS).trim();
}

/**
 * Compute how strongly a set of assistant responses is grounded in a
 * memory's content, with per-snippet match evidence.
 */
export function computeMemoryUsageEvidence(
  memoryContent: string,
  responses: ResponseDocument[]
): MemoryUsageEvidence {
  const snippets = extractMemorySnippets(memoryContent);
  if (snippets.length === 0 || responses.length === 0) {
    return { contentOverlapScore: 0, coverage: 0, matches: [] };
  }

  const preparedResponses = responses
    .map((response) => ({
      id: response.id,
      original: response.content,
      normalized: normalizeText(response.content),
      tokenSet: new Set(tokenize(normalizeText(response.content)))
    }))
    .filter((response) => response.normalized.length > 0);

  if (preparedResponses.length === 0) {
    return { contentOverlapScore: 0, coverage: 0, matches: [] };
  }

  const matches: EvidenceMatch[] = [];
  let matchedSnippets = 0;
  let bestSimilarity = 0;

  let comparableSnippets = 0;
  for (const snippet of snippets) {
    const normalizedSnippet = normalizeText(snippet);
    const snippetTokens = tokenize(normalizedSnippet);
    if (snippetTokens.length < MIN_SNIPPET_TOKENS) continue;
    comparableSnippets++;

    let best: EvidenceMatch | null = null;

    for (const response of preparedResponses) {
      // 1) Exact normalized containment — the strongest possible signal.
      if (normalizedSnippet.length >= MIN_SNIPPET_LENGTH && response.normalized.includes(normalizedSnippet)) {
        best = {
          memorySnippet: snippet,
          responseSnippet: findResponseWindow(response.normalized, response.original, normalizedSnippet),
          responseEventId: response.id,
          similarity: 1,
          matchType: 'exact'
        };
        break;
      }

      // 2) Term containment — what fraction of the snippet's tokens appear
      //    in the response. Discriminative for facts, robust to rephrasing.
      let hit = 0;
      const matchedTerms: string[] = [];
      for (const token of snippetTokens) {
        if (response.tokenSet.has(token)) {
          hit++;
          if (matchedTerms.length < 5 && token.length >= 3) matchedTerms.push(token);
        }
      }
      const containment = hit / snippetTokens.length;
      const similarity = containment * 0.9; // cap below exact-match confidence
      if (similarity >= STRONG_MATCH_THRESHOLD && (!best || similarity > best.similarity)) {
        best = {
          memorySnippet: snippet,
          responseSnippet: findTermWindow(response.original, matchedTerms),
          responseEventId: response.id,
          similarity: Math.round(similarity * 100) / 100,
          matchType: 'term-overlap'
        };
      }
    }

    if (best) {
      matchedSnippets++;
      bestSimilarity = Math.max(bestSimilarity, best.similarity);
      matches.push(best);
    }
  }

  if (comparableSnippets === 0) {
    return { contentOverlapScore: 0, coverage: 0, matches: [] };
  }

  const coverage = matchedSnippets / comparableSnippets;
  // Grounding blends "at least one strong reuse" with "how much of the
  // memory was reused". A single exact quote should already score well.
  const contentOverlapScore = Math.min(1, 0.65 * bestSimilarity + 0.35 * coverage);

  matches.sort((a, b) => b.similarity - a.similarity);

  return {
    contentOverlapScore: Math.round(contentOverlapScore * 100) / 100,
    coverage: Math.round(coverage * 100) / 100,
    matches: matches.slice(0, MAX_MATCHES)
  };
}
