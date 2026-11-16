/**
 * Builds the FTS5 MATCH expression shared by the keyword lanes.
 *
 * Query cost grows with the number of OR-ed prefix terms: on a 110k-event
 * store the 444 terms of a 2,500-character prompt took 31s, which is past the
 * host's hook timeout, against ~2s for 96. The expression is therefore bounded.
 */

// Above an ordinary follow-up query (previous turn + current prompt, ~85
// terms), so only unusually long prompts are shortened.
export const MAX_FTS_QUERY_TERMS = 96;

export function buildFtsMatchQuery(query: string): string {
  let terms = query
    .replace(/['"(){}[\]^~*?:\\/-]/g, ' ')  // Remove special chars
    .split(/\s+/)
    .filter(term => term.length > 1);  // Filter short terms

  // A query within the limit is searched exactly as written: a repeated word
  // is a repeated clause, which is how bm25 weights what the prompt dwells on.
  if (terms.length > MAX_FTS_QUERY_TERMS) {
    // The unicode61 tokenizer folds case, so "The" and "the" are one term.
    const seen = new Set<string>();
    terms = terms.filter((term) => {
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (terms.length > MAX_FTS_QUERY_TERMS) {
    // A long prompt is usually a short request wrapped around pasted context,
    // with the request at the start or the end; keep both ends.
    const half = MAX_FTS_QUERY_TERMS / 2;
    terms = [...terms.slice(0, half), ...terms.slice(-half)];
  }

  return terms
    .map(term => `"${term}"*`)  // Prefix matching
    .join(' OR ');
}
