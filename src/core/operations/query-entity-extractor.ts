import { sqliteAll, type SQLiteDatabase } from '../sqlite-wrapper.js';
import type { EntityType } from '../types.js';

export type QueryEntityCandidateSource =
  | 'entity_alias'
  | 'quoted'
  | 'file_path'
  | 'package_identifier'
  | 'capitalized_term';

export interface QueryEntityCandidate {
  text: string;
  normalized: string;
  source: QueryEntityCandidateSource;
  confidence: number;
  start: number;
  end: number;
  entityId?: string;
  entityType?: EntityType;
  canonicalKey?: string;
  matchedAlias?: string;
}

export interface QueryEntityExtractionOptions {
  maxCandidates?: number;
  includeAliases?: boolean;
}

export interface QueryEntityExtractionResult {
  query: string;
  candidates: QueryEntityCandidate[];
}

interface AliasRow {
  entity_id: string;
  entity_type: string;
  entity_canonical_key: string;
  alias_key: string;
  title: string;
}

interface CandidateDraft extends QueryEntityCandidate {
  priority: number;
}

interface TokenMatch {
  text: string;
  start: number;
  end: number;
}

const DEFAULT_MAX_CANDIDATES = 20;
const MAX_CANDIDATES = 100;
const MAX_CANDIDATE_TEXT_LENGTH = 200;

const SOURCE_PRIORITY: Record<QueryEntityCandidateSource, number> = {
  entity_alias: 0,
  quoted: 1,
  file_path: 2,
  package_identifier: 3,
  capitalized_term: 4
};

const SOURCE_CONFIDENCE: Record<QueryEntityCandidateSource, number> = {
  entity_alias: 0.95,
  quoted: 0.85,
  file_path: 0.8,
  package_identifier: 0.75,
  capitalized_term: 0.6
};

const SENTENCE_START_STOPWORDS = new Set([
  'A',
  'An',
  'And',
  'Are',
  'Can',
  'Compare',
  'Does',
  'Explain',
  'Find',
  'How',
  'I',
  'If',
  'In',
  'Is',
  'List',
  'Please',
  'Should',
  'Show',
  'Tell',
  'The',
  'This',
  'Use',
  'What',
  'When',
  'Where',
  'Which',
  'Why',
  'With'
]);

export class QueryEntityExtractor {
  constructor(private db?: SQLiteDatabase) {}

  extract(query: string, options: QueryEntityExtractionOptions = {}): QueryEntityExtractionResult {
    const maxCandidates = normalizeMaxCandidates(options.maxCandidates);
    const candidates: CandidateDraft[] = [];
    const quotedRanges = this.extractQuoted(query, candidates);

    if (options.includeAliases !== false) {
      this.extractKnownAliases(query, candidates);
    }

    this.extractFilePaths(query, candidates);
    this.extractPackageIdentifiers(query, candidates);
    this.extractCapitalizedTerms(query, candidates, quotedRanges);

    return {
      query,
      candidates: dedupeAndSort(candidates).slice(0, maxCandidates).map(stripPriority)
    };
  }

  private extractQuoted(query: string, candidates: CandidateDraft[]): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    const regex = /(["'`])((?:(?!\1)[^\n]){2,200})\1/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(query)) !== null) {
      const text = cleanCandidateText(match[2] ?? '');
      if (!isUsefulCandidate(text)) continue;
      const start = match.index + 1;
      const end = start + text.length;
      ranges.push([match.index, match.index + match[0].length]);
      pushCandidate(candidates, {
        text,
        source: 'quoted',
        start,
        end
      });
    }
    return ranges;
  }

  private extractKnownAliases(query: string, candidates: CandidateDraft[]): void {
    if (!this.db) return;
    const rows = sqliteAll<AliasRow>(
      this.db,
      `SELECT
         a.entity_id,
         a.entity_type,
         a.canonical_key AS alias_key,
         e.canonical_key AS entity_canonical_key,
         e.title
       FROM entity_aliases a
       JOIN entities e ON e.entity_id = a.entity_id
       WHERE e.status = 'active'
       ORDER BY e.title COLLATE NOCASE, a.canonical_key COLLATE NOCASE`
    );
    const normalizedQuery = normalizeForContainment(query);
    const seenAliases = new Set<string>();

    for (const row of rows) {
      const aliasLabels = uniqueStrings([
        row.title,
        aliasLabelFromCanonicalKey(row.alias_key),
        aliasLabelFromCanonicalKey(row.entity_canonical_key)
      ]).filter(isUsefulCandidate);

      for (const alias of aliasLabels) {
        const normalizedAlias = normalizeForContainment(alias);
        if (!normalizedAlias || !containsPhrase(normalizedQuery, normalizedAlias)) continue;
        const aliasKey = `${row.entity_id}:${normalizedAlias}`;
        if (seenAliases.has(aliasKey)) continue;
        seenAliases.add(aliasKey);
        const range = findRange(query, alias);
        pushCandidate(candidates, {
          text: row.title,
          source: 'entity_alias',
          start: range.start,
          end: range.end,
          entityId: row.entity_id,
          entityType: row.entity_type as EntityType,
          canonicalKey: row.entity_canonical_key,
          matchedAlias: normalizedAlias
        });
      }
    }
  }

  private extractFilePaths(query: string, candidates: CandidateDraft[]): void {
    const regex = /(^|[\s([{<])((?:\.{1,2}\/|~\/|\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9._-]*)(?=$|[\s)\]},>`.,;:!?])/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(query)) !== null) {
      const text = cleanCandidateText(match[2] ?? '');
      if (!isUsefulCandidate(text)) continue;
      const start = match.index + (match[1]?.length ?? 0);
      pushCandidate(candidates, {
        text,
        source: 'file_path',
        start,
        end: start + text.length
      });
    }
  }

  private extractPackageIdentifiers(query: string, candidates: CandidateDraft[]): void {
    const regex = /(^|[\s([{<`])(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._]*[-_][a-z0-9._-]*)(?=$|[\s)\]},>`.,;:!?])/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(query)) !== null) {
      const text = cleanCandidateText(match[2] ?? '');
      if (!isUsefulCandidate(text) || text.includes('/.') || text.includes('./')) continue;
      const start = match.index + (match[1]?.length ?? 0);
      pushCandidate(candidates, {
        text,
        source: 'package_identifier',
        start,
        end: start + text.length
      });
    }
  }

  private extractCapitalizedTerms(query: string, candidates: CandidateDraft[], ignoredRanges: Array<[number, number]>): void {
    const tokens = collectCapitalizedTokens(query)
      .filter(token => !isInsideAnyRange(token.start, ignoredRanges))
      .filter(token => !SENTENCE_START_STOPWORDS.has(token.text));
    const groups: TokenMatch[][] = [];
    let current: TokenMatch[] = [];

    for (const token of tokens) {
      const previous = current[current.length - 1];
      if (previous && query.slice(previous.end, token.start).match(/^\s+$/)) {
        current.push(token);
      } else {
        if (current.length > 0) groups.push(current);
        current = [token];
      }
    }
    if (current.length > 0) groups.push(current);

    for (const group of groups) {
      if (group.length === 1 && !isStrongSingleCapitalized(group[0].text)) continue;
      const start = group[0].start;
      const end = group[group.length - 1].end;
      const text = query.slice(start, end);
      if (!isUsefulCandidate(text)) continue;
      pushCandidate(candidates, {
        text,
        source: 'capitalized_term',
        start,
        end
      });
    }
  }
}

function collectCapitalizedTokens(query: string): TokenMatch[] {
  const regex = /\b(?:[A-Z]{2,}[A-Z0-9]*|[A-Z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*)\b/g;
  const tokens: TokenMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(query)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function pushCandidate(
  candidates: CandidateDraft[],
  input: Omit<CandidateDraft, 'normalized' | 'confidence' | 'priority'> & Partial<Pick<CandidateDraft, 'confidence'>>
): void {
  const text = cleanCandidateText(input.text);
  if (!isUsefulCandidate(text)) return;
  const source = input.source;
  candidates.push({
    ...input,
    text,
    normalized: normalizeCandidate(text),
    confidence: input.confidence ?? SOURCE_CONFIDENCE[source],
    priority: SOURCE_PRIORITY[source]
  });
}

function dedupeAndSort(candidates: CandidateDraft[]): CandidateDraft[] {
  const sorted = [...candidates].sort(compareCandidates);
  const seenAliasKeys = new Set<string>();
  const seenNormalized = new Set<string>();
  const result: CandidateDraft[] = [];

  for (const candidate of sorted) {
    if (candidate.source === 'entity_alias') {
      const aliasKey = `alias:${candidate.entityId ?? ''}:${normalizeCandidate(candidate.matchedAlias ?? candidate.text)}`;
      if (seenAliasKeys.has(aliasKey)) continue;
      seenAliasKeys.add(aliasKey);
      seenNormalized.add(candidate.normalized);
      result.push(candidate);
      continue;
    }

    if (seenNormalized.has(candidate.normalized)) continue;
    seenNormalized.add(candidate.normalized);
    result.push(candidate);
  }

  return result.sort(compareCandidates);
}

function compareCandidates(a: CandidateDraft, b: CandidateDraft): number {
  return a.priority - b.priority
    || a.start - b.start
    || a.end - b.end
    || compareStrings(a.text, b.text)
    || compareStrings(a.entityId ?? '', b.entityId ?? '')
    || compareStrings(a.matchedAlias ?? '', b.matchedAlias ?? '');
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function stripPriority(candidate: CandidateDraft): QueryEntityCandidate {
  const { priority: _priority, ...publicCandidate } = candidate;
  return publicCandidate;
}

function normalizeMaxCandidates(maxCandidates?: number): number {
  if (maxCandidates === undefined) return DEFAULT_MAX_CANDIDATES;
  if (!Number.isFinite(maxCandidates)) return DEFAULT_MAX_CANDIDATES;
  return Math.min(Math.max(0, Math.trunc(maxCandidates)), MAX_CANDIDATES);
}

function cleanCandidateText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/[.,;:!?]+$/g, '');
}

function normalizeCandidate(text: string): string {
  return cleanCandidateText(text).toLowerCase();
}

function normalizeForContainment(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@/._-]+/gu, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsPhrase(normalizedHaystack: string, normalizedNeedle: string): boolean {
  return (` ${normalizedHaystack} `).includes(` ${normalizedNeedle} `);
}

function aliasLabelFromCanonicalKey(canonicalKey: string): string {
  const raw = canonicalKey.includes(':') ? canonicalKey.slice(canonicalKey.lastIndexOf(':') + 1) : canonicalKey;
  return raw.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function findRange(query: string, alias: string): { start: number; end: number } {
  const normalizedAlias = normalizeForContainment(alias);
  const directIndex = query.toLowerCase().indexOf(alias.toLowerCase());
  if (directIndex >= 0) return { start: directIndex, end: directIndex + alias.length };

  const normalizedQuery = normalizeForContainment(query);
  const normalizedIndex = normalizedQuery.indexOf(normalizedAlias);
  if (normalizedIndex < 0) return { start: 0, end: 0 };

  const queryLower = query.toLowerCase();
  const words = normalizedAlias.split(' ').filter(Boolean);
  if (words.length === 0) return { start: 0, end: 0 };
  const first = queryLower.indexOf(words[0]);
  const lastWord = words[words.length - 1];
  const last = queryLower.indexOf(lastWord, first >= 0 ? first : 0);
  if (first >= 0 && last >= 0) return { start: first, end: last + lastWord.length };
  return { start: normalizedIndex, end: normalizedIndex + normalizedAlias.length };
}

function isUsefulCandidate(text: string): boolean {
  const cleaned = cleanCandidateText(text);
  return cleaned.length >= 2
    && cleaned.length <= MAX_CANDIDATE_TEXT_LENGTH
    && /[\p{L}\p{N}]/u.test(cleaned);
}

function isInsideAnyRange(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function isStrongSingleCapitalized(text: string): boolean {
  if (/^[A-Z]{2,}[A-Z0-9]*$/.test(text)) return true;
  if (/^[A-Z][a-z]+[A-Z][A-Za-z0-9]*$/.test(text)) return true;
  return text.length >= 4 && !SENTENCE_START_STOPWORDS.has(text);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = normalizeForContainment(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
