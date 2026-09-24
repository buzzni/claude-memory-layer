import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll, sqliteGet, sqliteRun } from '../../src/core/sqlite-wrapper.js';
import {
  normalizeRetrievalOutcomeDiagnostics,
  normalizeRetrievalOutcomeReason,
  presentedOutcomeReason
} from '../../src/core/retrieval-telemetry.js';
import { classifyHookOutcomeReason } from '../../src/adapters/claude/hooks/user-prompt-submit.js';

const roots: string[] = [];

function databasePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-outcome-reason-'));
  roots.push(root);
  return path.join(root, 'events.sqlite');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('honest retrieval outcome reasons (specs R2)', () => {
  it('records an unclassified empty selection as unknown, not as a runtime failure', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    await store.recordRetrievalTrace({
      traceId: 'trace-empty',
      queryText: 'nothing matches',
      candidateEventIds: [],
      selectedEventIds: []
    });
    const row = sqliteGet<{ outcome_reason: string; telemetry_schema_version: number }>(
      store.getDatabase(),
      'SELECT outcome_reason, telemetry_schema_version FROM retrieval_traces WHERE trace_id = ?',
      ['trace-empty']
    );
    expect(row?.outcome_reason).toBe('unknown');
    expect(Number(row?.telemetry_schema_version)).toBeGreaterThanOrEqual(2);
    await store.close();
  });

  it('preserves an explicitly reported runtime error', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    await store.recordRetrievalTrace({
      traceId: 'trace-error',
      queryText: 'boom',
      candidateEventIds: [],
      selectedEventIds: [],
      outcomeDiagnostics: normalizeRetrievalOutcomeDiagnostics({ outcomeReason: 'runtime_error' })
    });
    expect(sqliteGet<{ outcome_reason: string }>(
      store.getDatabase(),
      'SELECT outcome_reason FROM retrieval_traces WHERE trace_id = ?',
      ['trace-error']
    )?.outcome_reason).toBe('runtime_error');
    await store.close();
  });

  it('presents pre-migration rows as legacy_unclassified without rewriting them', () => {
    expect(presentedOutcomeReason('runtime_error', 0)).toBe('legacy_unclassified');
    expect(presentedOutcomeReason('runtime_error', null)).toBe('legacy_unclassified');
    // A row written by the current schema keeps its recorded reason.
    expect(presentedOutcomeReason('runtime_error', 2)).toBe('runtime_error');
    expect(presentedOutcomeReason('quality_filtered', 0)).toBe('quality_filtered');
    expect(normalizeRetrievalOutcomeReason('nonsense')).toBe('unknown');
  });

  it('distinguishes empty project, lexical miss, quality filter and threshold miss', () => {
    const base = {
      semantic: 0,
      keyword: 0,
      graduated: 0,
      lesson: 0,
      thresholdFiltered: 0,
      qualityFiltered: 0,
      selected: 0,
      minScore: 0.4,
      topScore: null,
      projectHasEvents: true
    };
    expect(classifyHookOutcomeReason({ ...base, projectHasEvents: false })).toBe('no_project_events');
    expect(classifyHookOutcomeReason(base)).toBe('no_keyword_candidates');
    expect(classifyHookOutcomeReason({ ...base, thresholdFiltered: 4 })).toBe('below_score_threshold');
    expect(classifyHookOutcomeReason({ ...base, keyword: 3, qualityFiltered: 3 })).toBe('quality_filtered');
    expect(classifyHookOutcomeReason({ ...base, keyword: 3, selected: 2 })).toBe('selected');
    // No fixture without a caught exception is ever recorded as runtime_error.
    const reasons = [
      classifyHookOutcomeReason({ ...base, projectHasEvents: false }),
      classifyHookOutcomeReason(base),
      classifyHookOutcomeReason({ ...base, thresholdFiltered: 4 }),
      classifyHookOutcomeReason({ ...base, keyword: 3, qualityFiltered: 3 })
    ];
    expect(reasons).not.toContain('runtime_error');
  });

  it('surfaces a pre-migration row as legacy_unclassified through the trace reader', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    // A row as the previous schema wrote it: runtime_error was the default for
    // "no diagnostics", not an observed exception.
    sqliteRun(
      store.getDatabase(),
      `INSERT INTO retrieval_traces (trace_id, query_text, candidate_event_ids, selected_event_ids,
         candidate_count, selected_count, outcome_reason, telemetry_schema_version, created_at)
       VALUES ('trace-legacy-reason', 'q', '[]', '[]', 0, 0, 'runtime_error', 0, ?)`,
      [new Date().toISOString()]
    );

    const traces = await store.getRecentRetrievalTraces(10);
    const legacy = traces.find((trace) => trace.traceId === 'trace-legacy-reason');
    expect(legacy?.outcomeDiagnostics.outcomeReason).toBe('legacy_unclassified');
    // The stored value itself is untouched.
    expect(sqliteGet<{ outcome_reason: string }>(
      store.getDatabase(),
      'SELECT outcome_reason FROM retrieval_traces WHERE trace_id = ?',
      ['trace-legacy-reason']
    )?.outcome_reason).toBe('runtime_error');
    await store.close();
  });

  it('counts one explicitly generated request per client exactly once', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    // The same request traced twice (automatic trace + explicit hook trace).
    await store.recordRetrievalTrace({
      traceId: 'trace-a',
      queryText: 'deploy',
      candidateEventIds: [],
      selectedEventIds: [],
      deliveryClient: 'claude-hook',
      requestId: 'claude-hook:session:turn-1'
    });
    const secondTraceId = await store.recordRetrievalTrace({
      traceId: 'trace-b',
      queryText: 'deploy',
      candidateEventIds: [],
      selectedEventIds: [],
      deliveryClient: 'claude-hook',
      requestId: 'claude-hook:session:turn-1'
    });
    await store.recordRetrievalTrace({
      traceId: 'trace-mcp',
      queryText: 'search',
      candidateEventIds: [],
      selectedEventIds: [],
      deliveryClient: 'mcp',
      requestId: 'mcp-search:1'
    });

    expect(secondTraceId).toBe('trace-a');
    expect(sqliteAll(store.getDatabase(), 'SELECT trace_id FROM retrieval_traces')).toHaveLength(2);

    const coverage = await store.getRetrievalClientCoverage();
    const hook = coverage.find((row) => row.client === 'claude-hook');
    const mcp = coverage.find((row) => row.client === 'mcp');
    expect(hook?.observedRequests).toBe(1);
    expect(hook?.instrumentedRequests).toBe(1);
    expect(mcp?.observedRequests).toBe(1);
    await store.close();
  });

  it('reports coverage as unknown rather than zero when requests carry no id', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    await store.recordRetrievalTrace({
      traceId: 'trace-uninstrumented',
      queryText: 'q',
      candidateEventIds: [],
      selectedEventIds: [],
      deliveryClient: 'legacy-client'
    });
    const coverage = await store.getRetrievalClientCoverage();
    const legacy = coverage.find((row) => row.client === 'legacy-client');
    expect(legacy?.coverage).toBeNull();
    expect(legacy?.coverageState).toBe('unknown');
    await store.close();
  });
});
