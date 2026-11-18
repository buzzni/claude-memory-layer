import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-summary-supersede-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function visibleSummaries(store: SQLiteEventStore, sessionId: string): Promise<string[]> {
  return (await store.getSessionEvents(sessionId))
    .filter((event) => event.eventType === 'session_summary')
    .map((event) => event.content);
}

// Issue #254: sessions summarized before the refresh (#221) hold two or more
// visible summaries, so retrieval returned both. Runs against a real store so
// "hidden" is proven on the read paths retrieval uses.
describe('SQLiteEventStore.supersedeDuplicateSessionSummaries', () => {
  async function setup() {
    const dbPath = tempDbPath();
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();
    const at = (iso: string) => new Date(`2026-08-01T${iso}.000Z`);
    await store.append({ eventType: 'user_prompt', sessionId: 'legacy', timestamp: at('00:00:00'), content: '질문' });
    const oldest = await store.append({ eventType: 'session_summary', sessionId: 'legacy', timestamp: at('00:01:00'), content: '- oldestneedle 요약', metadata: { generated: 'rule' } });
    const middle = await store.append({ eventType: 'session_summary', sessionId: 'legacy', timestamp: at('00:02:00'), content: '- middleneedle 요약' });
    const newest = await store.append({ eventType: 'session_summary', sessionId: 'legacy', timestamp: at('00:03:00'), content: '- newestneedle 요약', metadata: { generated: 'llm' } });
    const single = await store.append({ eventType: 'session_summary', sessionId: 'single', timestamp: at('00:00:30'), content: '- singleneedle 요약' });
    return { dbPath, store, oldest: oldest.eventId!, middle: middle.eventId!, newest: newest.eventId!, single: single.eventId! };
  }

  it('keeps only the newest summary of each session visible to retrieval', async () => {
    const { store, oldest, middle, newest } = await setup();

    const result = await store.supersedeDuplicateSessionSummaries({ now: new Date('2026-11-18T00:00:00.000Z') });

    expect(result).toEqual({
      dryRun: false,
      sessions: 1,
      superseded: 2,
      samples: [{ sessionId: 'legacy', keptEventId: newest, supersededEventIds: [middle, oldest] }]
    });
    expect(await visibleSummaries(store, 'legacy')).toEqual(['- newestneedle 요약']);
    expect(await visibleSummaries(store, 'single')).toEqual(['- singleneedle 요약']);
    expect(await store.getEvent(oldest)).toBeNull();
    expect(await store.keywordSearch('oldestneedle')).toHaveLength(0);
    expect(await store.keywordSearch('middleneedle')).toHaveLength(0);
    expect(await store.keywordSearch('newestneedle')).toHaveLength(1);

    // Hidden, not deleted: the row and its previous state stay recoverable.
    const hidden = await store.getEvent(oldest, { includeQuarantined: true });
    expect(hidden?.metadata).toMatchObject({
      generated: 'rule',
      quarantine: {
        status: 'active',
        category: 'superseded',
        supersededBy: newest,
        detectedAt: '2026-11-18T00:00:00.000Z'
      }
    });
    expect(hidden?.metadata?.tags).toContain('quarantine:superseded');

    await store.close();
  });

  it('records a governance audit row for every summary it hides', async () => {
    const { store, oldest, middle, newest } = await setup();

    await store.supersedeDuplicateSessionSummaries();

    const rows = sqliteAll<{ operation: string; target_type: string; target_id: string; source_event_ids: string; after_json: string }>(
      (store as unknown as { db: Parameters<typeof sqliteAll>[0] }).db,
      `SELECT operation, target_type, target_id, source_event_ids, after_json FROM memory_governance_audit ORDER BY target_id`
    );
    expect(rows.map((row) => row.target_id).sort()).toEqual([middle, oldest].sort());
    for (const row of rows) {
      expect(row.operation).toBe('quarantine');
      expect(row.target_type).toBe('event');
      expect(JSON.parse(row.source_event_ids)).toEqual([newest]);
      expect(JSON.parse(row.after_json)).toMatchObject({ quarantine: { category: 'superseded', supersededBy: newest } });
    }

    await store.close();
  });

  it('changes nothing in a dry run, even on a read-only store', async () => {
    const { dbPath, store, newest, middle, oldest } = await setup();
    await store.close();

    const readonly = new SQLiteEventStore(dbPath, { readonly: true });
    const preview = await readonly.supersedeDuplicateSessionSummaries({ dryRun: true });
    await readonly.close();

    expect(preview).toEqual({
      dryRun: true,
      sessions: 1,
      superseded: 2,
      samples: [{ sessionId: 'legacy', keptEventId: newest, supersededEventIds: [middle, oldest] }]
    });
    const reopened = new SQLiteEventStore(dbPath);
    expect(await visibleSummaries(reopened, 'legacy')).toHaveLength(3);
    await reopened.close();
  });

  it('is idempotent and ignores summaries that are already hidden', async () => {
    const { store } = await setup();

    await store.supersedeDuplicateSessionSummaries();
    await expect(store.supersedeDuplicateSessionSummaries()).resolves.toEqual({
      dryRun: false, sessions: 0, superseded: 0, samples: []
    });

    await store.close();
  });

  it('keeps an LLM summary over a later template summary of the same session', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const llm = await store.append({ eventType: 'session_summary', sessionId: 'mixed', timestamp: new Date('2026-08-01T01:43:13.000Z'), content: '- 결정: llmneedle 설정 추가', metadata: { generated: 'llm' } });
    const template = await store.append({ eventType: 'session_summary', sessionId: 'mixed', timestamp: new Date('2026-08-01T02:02:59.000Z'), content: 'Session with 2 user prompts and 2 responses.' });

    const result = await store.supersedeDuplicateSessionSummaries();

    expect(result.samples).toEqual([{ sessionId: 'mixed', keptEventId: llm.eventId, supersededEventIds: [template.eventId] }]);
    expect(await visibleSummaries(store, 'mixed')).toEqual(['- 결정: llmneedle 설정 추가']);

    await store.close();
  });

  it('breaks a timestamp tie by insertion order, so the summary written last stays', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const at = new Date('2026-08-01T00:00:00.000Z');
    const first = await store.append({ eventType: 'session_summary', sessionId: 'tie', timestamp: at, content: '- first' });
    const second = await store.append({ eventType: 'session_summary', sessionId: 'tie', timestamp: at, content: '- second' });

    const result = await store.supersedeDuplicateSessionSummaries();

    expect(result.samples).toEqual([{ sessionId: 'tie', keptEventId: second.eventId, supersededEventIds: [first.eventId] }]);
    expect(await visibleSummaries(store, 'tie')).toEqual(['- second']);

    await store.close();
  });
});
