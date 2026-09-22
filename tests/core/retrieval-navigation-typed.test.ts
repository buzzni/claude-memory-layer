import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteGet, sqliteRun } from '../../src/core/sqlite-wrapper.js';

const roots: string[] = [];

function databasePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-nav-typed-'));
  roots.push(root);
  return path.join(root, 'events.sqlite');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('typed reference navigation (specs R1/R3)', () => {
  it('keeps an earlier open separate from an already-recorded future open', async () => {
    const store = new SQLiteEventStore(databasePath());
    try {
      const now = Date.now();
      const input = { targetEventId: 'unresolved', targetKind: 'lesson' as const,
        action: 'expand' as const, navigationClient: 'mcp' };
      await store.recordReferenceNavigation({ ...input, openedAt: new Date(now + 60_000) });
      expect(await store.recordReferenceNavigation({ ...input, openedAt: new Date(now) }))
        .toMatchObject({ repeated: false });
      expect(sqliteGet(store.getDatabase(),
        'SELECT COUNT(*) AS invalid FROM retrieval_navigation_events WHERE julianday(first_opened_at) > julianday(last_opened_at)'))
        .toEqual({ invalid: 0 });
    } finally {
      await store.close();
    }
  });

  it.each([false, true])('checks matches beyond the first 500 traces (second match: %s)', async (secondMatch) => {
    const store = new SQLiteEventStore(databasePath());
    try {
      const now = Date.now();
      for (let index = 0; index <= 500; index++) {
        const id = index === 0 || (secondMatch && index === 500) ? 'target' : 'other';
        const traceId = `page-${index}`;
        await store.recordRetrievalTrace({ traceId, queryText: 'q', presentationMode: 'reference',
          candidateEventIds: [id], selectedEventIds: [id],
          items: [{ kind: 'lesson', id, selected: true }] });
        sqliteRun(store.getDatabase(), 'UPDATE retrieval_traces SET created_at = ? WHERE trace_id = ?',
          [new Date(now - 60_000 + index).toISOString(), traceId]);
        await store.recordRetrieval(id, 's', 0.8, 'q', {
          traceId, memoryKind: 'lesson', presentationMode: 'reference',
          deliveryStatus: 'emitted', deliveryEvidence: 'mcp_tool_result'
        });
      }
      expect(await store.recordReferenceNavigation({
        targetEventId: 'target', targetKind: 'lesson', action: 'expand', navigationClient: 'mcp'
      })).toMatchObject(secondMatch
        ? { outcome: 'ambiguous', traceId: null }
        : { outcome: 'attributed', traceId: 'page-0' });
    } finally {
      await store.close();
    }
  });

  it.each([
    { selectedOffset: -20 * 60_000, deliveredOffset: -60_000, expected: 'attributed' },
    { selectedOffset: -60_000, deliveredOffset: 60_000, expected: 'unattributed' }
  ])('uses delivery time for attribution: %j', async ({ selectedOffset, deliveredOffset, expected }) => {
    const store = new SQLiteEventStore(databasePath());
    try {
      const now = Date.now();
      await store.recordRetrievalTrace({
        traceId: 'delayed', queryText: 'q', presentationMode: 'reference',
        candidateEventIds: ['lesson'], selectedEventIds: ['lesson'],
        items: [{ kind: 'lesson', id: 'lesson', selected: true }]
      });
      await store.recordRetrieval('lesson', 's', 0.8, 'q', {
        traceId: 'delayed', memoryKind: 'lesson', presentationMode: 'reference'
      });
      sqliteRun(store.getDatabase(), 'UPDATE retrieval_traces SET created_at = ? WHERE trace_id = ?',
        [new Date(now + selectedOffset).toISOString(), 'delayed']);
      await store.recordDeliveryOutcome({ traceId: 'delayed', status: 'emitted', evidence: 'hook_stdout',
        deliveredAt: new Date(now + deliveredOffset) });
      expect(await store.recordReferenceNavigation({
        targetEventId: 'lesson', targetKind: 'lesson', action: 'expand', navigationClient: 'mcp',
        openedAt: new Date(now)
      })).toMatchObject({ outcome: expected });
    } finally {
      await store.close();
    }
  });

  it('requires delivery evidence and keeps same-id opens in separate project scopes', async () => {
    const store = new SQLiteEventStore(databasePath());
    for (const projectId of ['a', 'b']) {
      await store.recordRetrievalTrace({
        traceId: `trace-${projectId}`, queryText: 'q', presentationMode: 'reference',
        candidateEventIds: ['same'], selectedEventIds: ['same'],
        items: [{ kind: 'lesson', id: 'same', projectId, selected: true }]
      });
    }
    const open = { targetEventId: 'same', targetKind: 'lesson' as const, targetProjectId: 'b', action: 'expand' as const, navigationClient: 'mcp' };
    expect((await store.recordReferenceNavigation(open)).outcome).toBe('unattributed');
    for (const projectId of ['a', 'b']) {
      await store.recordRetrieval('same', 's', 0.8, 'q', {
        traceId: `trace-${projectId}`, memoryKind: 'lesson', memoryProjectId: projectId,
        deliveryStatus: 'emitted', deliveryEvidence: 'mcp_tool_result', presentationMode: 'reference'
      });
    }
    expect(await store.recordReferenceNavigation(open)).toMatchObject({ outcome: 'attributed', traceId: 'trace-b' });
    expect(await store.recordReferenceNavigation({ ...open, targetProjectId: 'a' })).toMatchObject({ outcome: 'attributed', traceId: 'trace-a', repeated: false });
    await store.close();
  });
  it('attributes a lesson open to the lesson delivery, not to a same-id event delivery', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const sharedId = 'shared-identifier';

    await store.recordRetrievalTrace({
      traceId: 'trace-event-reference',
      sessionId: 'session-1',
      queryText: 'event reference index',
      candidateEventIds: [sharedId],
      selectedEventIds: [sharedId],
      items: [{ kind: 'event', id: sharedId, selected: true }],
      presentationMode: 'reference',
      triggerType: 'user_prompt'
    });
    await store.recordRetrievalTrace({
      traceId: 'trace-lesson-reference',
      sessionId: 'session-1',
      queryText: 'lesson index',
      candidateEventIds: [sharedId],
      selectedEventIds: [sharedId],
      items: [{ kind: 'lesson', id: sharedId, selected: true }],
      presentationMode: 'reference',
      triggerType: 'session_start'
    });

    await store.recordRetrieval(sharedId, 'session-1', 0.8, 'q', { traceId: 'trace-lesson-reference', memoryKind: 'lesson', deliveryStatus: 'emitted', deliveryEvidence: 'mcp_tool_result', presentationMode: 'reference' });
    const result = await store.recordReferenceNavigation({
      targetEventId: sharedId,
      targetKind: 'lesson',
      action: 'expand',
      navigationClient: 'mcp'
    });

    // Without the kind both traces would match and the open would be ambiguous.
    expect(result.outcome).toBe('attributed');
    expect(result.traceId).toBe('trace-lesson-reference');
    expect(sqliteGet<{ memory_kind: string }>(
      store.getDatabase(),
      'SELECT memory_kind FROM retrieval_navigation_events WHERE target_event_id = ?',
      [sharedId]
    )?.memory_kind).toBe('lesson');
    await store.close();
  });

  it('leaves an open ambiguous when two deliveries of the same typed memory match', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    for (const traceId of ['trace-one', 'trace-two']) {
      await store.recordRetrievalTrace({
        traceId,
        sessionId: 'session-amb',
        queryText: 'lesson index',
        candidateEventIds: ['lesson-amb'],
        selectedEventIds: ['lesson-amb'],
        items: [{ kind: 'lesson', id: 'lesson-amb', selected: true }],
        presentationMode: 'reference',
        triggerType: 'session_start'
      });
      await store.recordRetrieval('lesson-amb', 'session-amb', 0.8, 'q', { traceId, memoryKind: 'lesson', deliveryStatus: 'emitted', deliveryEvidence: 'mcp_tool_result', presentationMode: 'reference' });
    }

    const result = await store.recordReferenceNavigation({
      targetEventId: 'lesson-amb',
      targetKind: 'lesson',
      action: 'expand',
      navigationClient: 'mcp'
    });
    expect(result.outcome).toBe('ambiguous');
    expect(result.traceId).toBeNull();
    await store.close();
  });
});
