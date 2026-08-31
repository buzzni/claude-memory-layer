import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  REFERENCE_ATTRIBUTION_WINDOW_MS,
  SQLiteEventStore
} from '../../src/core/sqlite-event-store.js';
import {
  createSQLiteDatabase,
  sqliteAll,
  sqliteClose,
  sqliteGet,
  sqliteRun
} from '../../src/core/sqlite-wrapper.js';

describe('retrieval presentation and navigation telemetry', () => {
  let tempDir: string;
  let dbPath: string;
  let store: SQLiteEventStore;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'retrieval-telemetry-'));
    dbPath = join(tempDir, 'events.sqlite');
    store = new SQLiteEventStore(dbPath);
    await store.initialize();
  });

  afterEach(() => {
    try { store.close(); } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function appendEvent(sessionId: string, content: string): Promise<string> {
    const result = await store.append({
      eventType: 'agent_response',
      sessionId,
      timestamp: new Date(),
      content
    });
    if (!result.success) throw new Error('failed to append fixture event');
    return result.eventId;
  }

  it('reports evidence, reference, and core deliveries with source-specific denominators', async () => {
    const evidenceId = await appendEvent('delivery-session', 'Use port 37777 for the dashboard.');
    const referenceId = await appendEvent('delivery-session', 'Reference-only deployment notes.');

    await store.recordRetrievalTrace({
      traceId: 'trace-evidence',
      sessionId: 'delivery-session',
      queryText: 'dashboard port',
      candidateEventIds: [evidenceId],
      selectedEventIds: [evidenceId],
      presentationMode: 'evidence',
      triggerType: 'user_prompt',
      deliveryClient: 'claude-hook'
    });
    await store.recordRetrieval(evidenceId, 'delivery-session', 0.9, 'dashboard port', {
      traceId: 'trace-evidence',
      presentationMode: 'evidence',
      triggerType: 'user_prompt',
      deliveryClient: 'claude-hook'
    });
    await store.recordRetrievalTrace({
      traceId: 'trace-reference',
      sessionId: 'delivery-session',
      queryText: '[session-start] recent project context',
      candidateEventIds: [referenceId],
      selectedEventIds: [referenceId],
      presentationMode: 'reference',
      triggerType: 'session_start',
      deliveryClient: 'claude-hook'
    });
    await store.recordRetrieval(referenceId, 'delivery-session', 0.5, '[session-start]', {
      traceId: 'trace-reference',
      presentationMode: 'reference',
      triggerType: 'session_start',
      deliveryClient: 'claude-hook'
    });
    await store.recordRetrievalTrace({
      traceId: 'trace-core',
      sessionId: 'delivery-session',
      queryText: '[session-start] core memory',
      candidateEventIds: ['core:project'],
      selectedEventIds: ['core:project'],
      presentationMode: 'core',
      triggerType: 'session_start',
      deliveryClient: 'claude-hook'
    });

    const db = createSQLiteDatabase(dbPath);
    sqliteRun(
      db,
      `UPDATE memory_helpfulness
       SET content_overlap_score = 0.6, measured_at = datetime('now')
       WHERE trace_id = 'trace-evidence'`
    );
    sqliteClose(db);

    const firstOpen = await store.recordReferenceNavigation({
      targetEventId: referenceId,
      action: 'source_ref',
      navigationClient: 'mcp'
    });
    const repeatedOpen = await store.recordReferenceNavigation({
      targetEventId: referenceId,
      action: 'source_ref',
      navigationClient: 'mcp'
    });

    expect(firstOpen).toEqual({ outcome: 'attributed', traceId: 'trace-reference', repeated: false });
    expect(repeatedOpen).toEqual({ outcome: 'attributed', traceId: 'trace-reference', repeated: true });

    const stats = await store.getRetrievalTelemetryStats();
    expect(stats.deliveries.byPresentation).toEqual([
      { presentationMode: 'core', traceCount: 1, deliveredItemCount: 1 },
      { presentationMode: 'evidence', traceCount: 1, deliveredItemCount: 1 },
      { presentationMode: 'reference', traceCount: 1, deliveredItemCount: 1 }
    ]);
    expect(stats.deliveries.byTrigger).toEqual([
      { triggerType: 'session_start', traceCount: 2, deliveredItemCount: 2 },
      { triggerType: 'user_prompt', traceCount: 1, deliveredItemCount: 1 }
    ]);
    expect(stats.evidenceGrounding).toEqual({
      evaluatedDeliveries: 1,
      groundedDeliveries: 1,
      groundingRate: 1,
      averageContentOverlap: 0.6
    });
    expect(stats.referenceNavigation).toEqual({
      eligibleTraces: 1,
      navigatedTraces: 1,
      navigationRate: 1,
      attributedOpenCount: 2,
      ambiguousOpenCount: 0,
      unattributedOpenCount: 0
    });
    await expect(store.getRetrievalTraceStats()).resolves.toMatchObject({ totalQueries: 1 });
    await expect(store.getRecentRetrievalTraces(10)).resolves.toEqual([
      expect.objectContaining({ traceId: 'trace-evidence', triggerType: 'user_prompt' })
    ]);

    const privacyDb = createSQLiteDatabase(dbPath, { readonly: true, walMode: false });
    const columns = sqliteAll<{ name: string }>(privacyDb, `PRAGMA table_info(retrieval_navigation_events)`)
      .map((column) => column.name);
    sqliteClose(privacyDb);
    expect(columns).not.toContain('content');
    expect(columns).not.toContain('query_text');
    expect(columns).not.toContain('source_path');
  });

  it('fails closed for ambiguous, expired, and cross-session attribution', async () => {
    const eventId = await appendEvent('source-session', 'A reference target');
    for (const [traceId, sessionId] of [['trace-a', 'delivery-a'], ['trace-b', 'delivery-b']] as const) {
      await store.recordRetrievalTrace({
        traceId,
        sessionId,
        queryText: 'reference delivery',
        candidateEventIds: [eventId],
        selectedEventIds: [eventId],
        presentationMode: 'reference',
        triggerType: 'user_prompt'
      });
    }

    await expect(store.recordReferenceNavigation({
      targetEventId: eventId,
      action: 'details',
      navigationClient: 'mcp'
    })).resolves.toMatchObject({ outcome: 'ambiguous', traceId: null });

    await expect(store.recordReferenceNavigation({
      targetEventId: eventId,
      action: 'details',
      navigationClient: 'mcp',
      attributionSessionId: 'delivery-a'
    })).resolves.toMatchObject({ outcome: 'attributed', traceId: 'trace-a' });

    await expect(store.recordReferenceNavigation({
      targetEventId: eventId,
      action: 'expand',
      navigationClient: 'cli',
      attributionSessionId: 'different-session'
    })).resolves.toMatchObject({ outcome: 'unattributed', traceId: null });

    await expect(store.recordReferenceNavigation({
      targetEventId: eventId,
      action: 'source',
      navigationClient: 'cli',
      attributionSessionId: 'delivery-a',
      openedAt: new Date(Date.now() + REFERENCE_ATTRIBUTION_WINDOW_MS + 60_000)
    })).resolves.toMatchObject({ outcome: 'unattributed', traceId: null });
  });

  it('keeps unopened references neutral and labels omitted legacy fields unknown', async () => {
    const eventId = await appendEvent('evaluation-session', 'Reference text that is not copied.');
    await store.recordRetrievalTrace({
      traceId: 'reference-evaluation',
      sessionId: 'evaluation-session',
      queryText: 'reference query',
      candidateEventIds: [eventId],
      selectedEventIds: [eventId],
      presentationMode: 'reference',
      triggerType: 'user_prompt'
    });
    await store.recordRetrieval(eventId, 'evaluation-session', 0.1, 'reference query', {
      traceId: 'reference-evaluation',
      injectedContent: 'reference navigation hint',
      presentationMode: 'reference',
      triggerType: 'user_prompt'
    });
    await store.recordRetrievalTrace({
      traceId: 'legacy-trace',
      sessionId: 'legacy-session',
      queryText: 'legacy query',
      candidateEventIds: [eventId],
      selectedEventIds: [eventId]
    });
    await store.recordRetrieval(eventId, 'legacy-session', 0.5, 'legacy query', { traceId: 'legacy-trace' });

    await store.evaluateSessionHelpfulness('evaluation-session');

    const db = createSQLiteDatabase(dbPath, { readonly: true, walMode: false });
    const row = sqliteGet<Record<string, unknown>>(
      db,
      `SELECT helpfulness_score, content_overlap_score, presentation_mode
       FROM memory_helpfulness WHERE trace_id = 'reference-evaluation'`
    );
    sqliteClose(db);
    expect(row).toMatchObject({ helpfulness_score: 0.5, content_overlap_score: null, presentation_mode: 'reference' });

    const traces = await store.getRecentRetrievalTraces(10);
    expect(traces.find((trace) => trace.traceId === 'legacy-trace')).toMatchObject({
      presentationMode: 'unknown',
      triggerType: 'unknown',
      deliveryClient: 'unknown'
    });
    await expect(store.getRetrievalTelemetryStats()).resolves.toMatchObject({
      deliveries: { legacyUnknownRows: 1 }
    });
  });

  it('persists bounded outcome diagnostics and drops unapproved cardinality keys', async () => {
    await store.recordRetrievalTrace({
      traceId: 'diagnostic-trace',
      queryText: 'bounded diagnostics',
      candidateEventIds: [],
      selectedEventIds: [],
      triggerType: 'user_prompt',
      outcomeDiagnostics: {
        outcomeReason: 'scope_filtered',
        laneCandidateCounts: { keyword: 4, '/private/path': 999 } as Record<string, number>,
        filteredCounts: { scope: 4, arbitrary: 10 } as Record<string, number>,
        topScore: 0.77,
        threshold: 0.7,
        freshnessState: 'fresh'
      }
    });

    const trace = (await store.getRecentRetrievalTraces(5)).find((item) => item.traceId === 'diagnostic-trace');
    expect(trace?.outcomeDiagnostics).toEqual({
      outcomeReason: 'scope_filtered',
      laneCandidateCounts: { keyword: 4 },
      filteredCounts: { scope: 4 },
      topScore: 0.77,
      threshold: 0.7,
      freshnessState: 'fresh'
    });
    expect(JSON.stringify(trace)).not.toContain('/private/path');
  });
});
