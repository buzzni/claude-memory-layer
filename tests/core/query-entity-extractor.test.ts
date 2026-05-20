import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { QueryEntityExtractor } from '../../src/core/operations/query-entity-extractor.js';
import { sqliteRun } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{
  store: SQLiteEventStore;
  extractor: QueryEntityExtractor;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-query-entity-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  const extractor = new QueryEntityExtractor(store.getDatabase());
  return { store, extractor, cleanup: async () => store.close() };
}

function insertEntity(store: SQLiteEventStore, input: {
  entityId: string;
  entityType?: string;
  canonicalKey: string;
  title: string;
  status?: 'active' | 'deprecated';
}): void {
  const now = new Date('2026-05-20T00:00:00Z').toISOString();
  sqliteRun(
    store.getDatabase(),
    `INSERT INTO entities (
      entity_id, entity_type, canonical_key, title, stage, status,
      current_json, title_norm, search_text, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'verified', ?, ?, ?, ?, ?, ?)`,
    [
      input.entityId,
      input.entityType ?? 'task',
      input.canonicalKey,
      input.title,
      input.status ?? 'active',
      JSON.stringify({ fixture: true }),
      input.title.toLowerCase(),
      input.title,
      now,
      now
    ]
  );
}

function insertAlias(store: SQLiteEventStore, input: {
  entityType?: string;
  canonicalKey: string;
  entityId: string;
  primary?: boolean;
}): void {
  sqliteRun(
    store.getDatabase(),
    `INSERT INTO entity_aliases (entity_type, canonical_key, entity_id, is_primary, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [input.entityType ?? 'task', input.canonicalKey, input.entityId, input.primary ? 1 : 0, new Date('2026-05-20T00:00:00Z').toISOString()]
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('QueryEntityExtractor', () => {
  it('extracts quoted strings, file paths, package identifiers, and capitalized technical terms', async () => {
    const { extractor, cleanup } = await createFixture();

    const result = extractor.extract(
      'Compare "Graph expansion" and "Don\'t Repeat Yourself" with src/core/retriever.ts, @huggingface/transformers, better-sqlite3, GraphPathService, and SQLite Event Store.'
    );
    await cleanup();

    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Graph expansion', source: 'quoted', normalized: 'graph expansion' }),
      expect.objectContaining({ text: "Don't Repeat Yourself", source: 'quoted', normalized: "don't repeat yourself" }),
      expect.objectContaining({ text: 'src/core/retriever.ts', source: 'file_path', normalized: 'src/core/retriever.ts' }),
      expect.objectContaining({ text: '@huggingface/transformers', source: 'package_identifier', normalized: '@huggingface/transformers' }),
      expect.objectContaining({ text: 'better-sqlite3', source: 'package_identifier', normalized: 'better-sqlite3' }),
      expect.objectContaining({ text: 'GraphPathService', source: 'capitalized_term', normalized: 'graphpathservice' }),
      expect.objectContaining({ text: 'SQLite Event Store', source: 'capitalized_term', normalized: 'sqlite event store' })
    ]));
    expect(result.candidates.map(candidate => candidate.text)).not.toContain('Compare');
  });

  it('drops oversized heuristic candidates to keep extraction bounded', async () => {
    const { extractor, cleanup } = await createFixture();
    const oversizedPath = `src/${'a'.repeat(220)}.ts`;

    const result = extractor.extract(`open ${oversizedPath} and GraphPathService`);
    await cleanup();

    expect(result.candidates.some(candidate => candidate.text === oversizedPath)).toBe(false);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'GraphPathService', source: 'capitalized_term' })
    ]));
  });

  it('matches active entity aliases case-insensitively from title and canonical alias keys', async () => {
    const { store, extractor, cleanup } = await createFixture();
    insertEntity(store, {
      entityId: 'task-1',
      canonicalKey: 'task:default:retrieval_disclosure_service',
      title: 'Retrieval Disclosure Service'
    });
    insertAlias(store, {
      entityId: 'task-1',
      canonicalKey: 'task:default:retrieval_disclosure'
    });
    insertEntity(store, {
      entityId: 'task-2',
      canonicalKey: 'task:default:stale_dashboard',
      title: 'Stale Dashboard',
      status: 'deprecated'
    });
    insertAlias(store, {
      entityId: 'task-2',
      canonicalKey: 'task:default:stale_dashboard'
    });

    const result = extractor.extract('explain retrieval disclosure and retrieval disclosure service; ignore stale dashboard');
    await cleanup();

    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: 'Retrieval Disclosure Service',
        source: 'entity_alias',
        entityId: 'task-1',
        canonicalKey: 'task:default:retrieval_disclosure_service',
        matchedAlias: 'retrieval disclosure service'
      }),
      expect.objectContaining({
        text: 'Retrieval Disclosure Service',
        source: 'entity_alias',
        entityId: 'task-1',
        canonicalKey: 'task:default:retrieval_disclosure_service',
        matchedAlias: 'retrieval disclosure'
      })
    ]));
    expect(result.candidates.some(candidate => candidate.entityId === 'task-2')).toBe(false);
  });

  it('prefers entity alias candidates over duplicate heuristic candidates and caps results deterministically', async () => {
    const { store, extractor, cleanup } = await createFixture();
    insertEntity(store, {
      entityId: 'task-graph-path',
      canonicalKey: 'task:default:graphpathservice',
      title: 'GraphPathService'
    });
    insertAlias(store, {
      entityId: 'task-graph-path',
      canonicalKey: 'task:default:graphpathservice',
      primary: true
    });

    const result = extractor.extract('GraphPathService GraphPathService uses MCP with src/core/graph-path-service.ts and @scope/pkg', {
      maxCandidates: 3
    });
    await cleanup();

    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]).toEqual(expect.objectContaining({
      text: 'GraphPathService',
      source: 'entity_alias',
      entityId: 'task-graph-path'
    }));
    expect(result.candidates.filter(candidate => candidate.normalized === 'graphpathservice')).toHaveLength(1);
    expect(result.candidates.map(candidate => candidate.text)).toEqual([
      'GraphPathService',
      'src/core/graph-path-service.ts',
      '@scope/pkg'
    ]);
  });
});
