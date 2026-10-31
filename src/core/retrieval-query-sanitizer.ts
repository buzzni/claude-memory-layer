/**
 * Recover the request from a long prompt before it becomes a retrieval query.
 *
 * A pasted log or spec buries the actual question: the FTS lane ORs every
 * token, and the embedder keeps only the head of its input (2000 chars, then
 * 512 tokens), so a question at the end never reaches the vector at all.
 * Ported from MemPalace `query_sanitizer.py`, in four steps:
 *
 * 1. passthrough: 200 chars or less is used as is.
 * 2. question: the last sentence ending with `?`, else the last sentence with
 *    a Korean question or request ending (`…까`, `…나요`, `…해줘`, `…주세요`).
 *    Korean asks without `?` as often as with it, but a pasted Korean log or
 *    UI message can end the same way, so an explicit `?` wins.
 * 3. tail_sentence: the last sentence of at least 10 chars.
 * 4. tail_truncation: the last 250 chars.
 *
 * Sentences split only at punctuation followed by whitespace, so paths and
 * versions (`hooks/user-prompt-submit.ts`, `v2.4.17`) stay whole. Paths,
 * `#123` references, and commit SHAs found only in the dropped part are
 * appended, since they are the exact-match terms the FTS lane needs most.
 */

export type RetrievalQuerySanitizeMethod =
  | 'passthrough'
  | 'question'
  | 'korean_intent'
  | 'tail_sentence'
  | 'tail_truncation';

export interface SanitizedRetrievalQuery {
  query: string;
  method: RetrievalQuerySanitizeMethod;
}

const SAFE_QUERY_LENGTH = 200;
const MAX_QUERY_LENGTH = 250;
const MIN_QUERY_LENGTH = 10;
const MAX_PRESERVED_IDENTIFIERS = 8;

const SENTENCE_BOUNDARY = /(?<=[.!?。！？])\s+/;
const QUESTION_END = /[?？]["'”’)\]]*$/;
const KOREAN_INTENT_END = /(?:까요?|나요|가요|냐|니|줘요?|주세요|주십시오|부탁(?:해요?|합니다|드립니다|드려요))[.!~…\s]*$/;
const MAX_IDENTIFIER_LENGTH = 200;
// Leading brackets/quotes and trailing punctuation or Korean particles
// (`src/a.ts를`, `#122에서`) are not part of the identifier.
const IDENTIFIER_EDGES = /^[^\w~@./#]+|[^\w~@-]+$/g;
// A path needs a file extension or at least two separators, so `A/B`,
// `src/core`, and slash commands like `/role-context` are not identifiers.
const IDENTIFIER = new RegExp([
  /[A-Za-z][\w+.-]*:\/\/\S+/.source,
  /[\w.~@/-]*\/[\w.@-]*[\w-]\.[A-Za-z]\w{0,7}(?::\d+)*/.source,
  /[\w.~@-]*(?:\/[\w.@-]+){2,}\/?/.source,
  /#\d+/.source,
  /(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}/.source
].map((source) => `^(?:${source})$`).join('|'));
const LONE_TAG = /^<[^>]*>$/;

export function sanitizeRetrievalQuery(text: string): SanitizedRetrievalQuery {
  const trimmed = text.trim();
  if (trimmed.length <= SAFE_QUERY_LENGTH) return { query: trimmed, method: 'passthrough' };

  const sentences = trimmed
    .split('\n')
    .flatMap((line) => line.split(SENTENCE_BOUNDARY))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= MIN_QUERY_LENGTH && !LONE_TAG.test(sentence));
  const lastMatching = (pattern: RegExp) => sentences.filter((sentence) => pattern.test(sentence)).pop();

  const question = lastMatching(QUESTION_END);
  if (question) return withIdentifiers(trimmed, question, 'question');
  const koreanIntent = lastMatching(KOREAN_INTENT_END);
  if (koreanIntent) return withIdentifiers(trimmed, koreanIntent, 'korean_intent');
  const lastSentence = sentences.pop();
  if (lastSentence) return withIdentifiers(trimmed, lastSentence, 'tail_sentence');
  return withIdentifiers(trimmed, trimmed, 'tail_truncation');
}

function withIdentifiers(
  original: string,
  candidate: string,
  method: RetrievalQuerySanitizeMethod
): SanitizedRetrievalQuery {
  const kept = candidate.length > MAX_QUERY_LENGTH ? tail(candidate) : candidate;
  const dropped = [...new Set(identifiers(original))]
    .filter((identifier) => !kept.includes(identifier))
    .slice(0, MAX_PRESERVED_IDENTIFIERS);
  return { query: [kept, ...dropped].join(' '), method };
}

/** Whitespace tokens only, so cost stays linear on a pasted blob. */
function identifiers(text: string): string[] {
  return text
    .split(/\s+/)
    .filter((token) => token.length <= MAX_IDENTIFIER_LENGTH)
    .map((token) => token.replace(IDENTIFIER_EDGES, ''))
    .filter((token) => IDENTIFIER.test(token));
}

/** Last MAX_QUERY_LENGTH chars, starting at a token boundary when there is one. */
function tail(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_QUERY_LENGTH) return text;
  const cut = chars.slice(-MAX_QUERY_LENGTH).join('');
  if (/\s/.test(chars[chars.length - MAX_QUERY_LENGTH - 1])) return cut.trim();
  const boundary = cut.search(/\s/);
  return boundary === -1 ? cut : cut.slice(boundary).trim();
}
