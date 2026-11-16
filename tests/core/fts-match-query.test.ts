/**
 * Regression: the keyword lanes turned every whitespace token of the prompt
 * into its own `"term"*` OR-clause. A 2,500-character prompt became 444 terms
 * (235 unique), and that single FTS query took 31s on a 110k-event store —
 * past the host's 30s hook timeout, so the turn got no memory and the prompt
 * itself was never stored.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { buildFtsMatchQuery, MAX_FTS_QUERY_TERMS } from '../../src/core/fts-match-query.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const termsOf = (matchQuery: string): string[] =>
  matchQuery.split(' OR ').map((clause) => clause.replace(/^"|"\*$/g, ''));

describe('buildFtsMatchQuery', () => {
  it('keeps a short query as one prefix clause per word', () => {
    expect(buildFtsMatchQuery('browser cookie import')).toBe('"browser"* OR "cookie"* OR "import"*');
  });

  it('strips FTS5 syntax characters and drops single-character tokens', () => {
    expect(buildFtsMatchQuery('fix "auth" (a) src/core:42')).toBe('"fix"* OR "auth"* OR "src"* OR "core"* OR "42"*');
  });

  it('returns an empty string when nothing searchable is left', () => {
    expect(buildFtsMatchQuery('  ( ) " * a ')).toBe('');
  });

  it('keeps repeats in a query within the limit, since repetition weights a term', () => {
    expect(buildFtsMatchQuery('ledger rollback ledger')).toBe('"ledger"* OR "rollback"* OR "ledger"*');
  });

  it('caps a long prompt at the term limit', () => {
    const prompt = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ');

    expect(termsOf(buildFtsMatchQuery(prompt))).toHaveLength(MAX_FTS_QUERY_TERMS);
  });

  it('keeps both ends of a long prompt, where the request itself usually sits', () => {
    const prompt = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ');
    const half = MAX_FTS_QUERY_TERMS / 2;

    const terms = termsOf(buildFtsMatchQuery(prompt));

    expect(terms.slice(0, half)).toEqual(Array.from({ length: half }, (_, i) => `word${i}`));
    expect(terms.slice(half)).toEqual(Array.from({ length: half }, (_, i) => `word${500 - half + i}`));
  });

  it('searches each word of an over-long prompt once, ignoring case', () => {
    const repeated = Array.from({ length: 300 }, () => 'The user asked the USER').join(' ');

    expect(buildFtsMatchQuery(`${repeated} quokka`)).toBe('"The"* OR "user"* OR "asked"* OR "quokka"*');
  });
});

describe('keyword lanes with a long prompt', () => {
  let tempDir: string;
  let store: SQLiteEventStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-layer-test-'));
    store = new SQLiteEventStore(path.join(tempDir, 'events.sqlite'));
    await store.initialize();
    await store.append({
      eventType: 'agent_response',
      sessionId: 'session-1',
      timestamp: new Date(),
      content: 'The quokka migration was rolled back because of the lock timeout.'
    });
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const pastedContext = Array.from({ length: 500 }, (_, i) => `filler${i}`).join(' ');

  it('still matches a request that follows a long pasted block', async () => {
    const results = await store.keywordSearch(`${pastedContext} why was the quokka migration rolled back`, 5);

    expect(results.map((r) => r.event.content)).toEqual([
      'The quokka migration was rolled back because of the lock timeout.'
    ]);
  });

  it('still matches a request that precedes a long pasted block', async () => {
    const results = await store.keywordSearch(`why was the quokka migration rolled back ${pastedContext}`, 5);

    expect(results.map((r) => r.event.content)).toEqual([
      'The quokka migration was rolled back because of the lock timeout.'
    ]);
  });
});
