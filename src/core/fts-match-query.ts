/**
 * Builds the FTS5 MATCH expression shared by the keyword lanes.
 */

export function buildFtsMatchQuery(query: string): string {
  return query
    .replace(/['"(){}[\]^~*?:\\/-]/g, ' ')  // Remove special chars
    .split(/\s+/)
    .filter(term => term.length > 1)  // Filter short terms
    .map(term => `"${term}"*`)  // Prefix matching
    .join(' OR ');
}
