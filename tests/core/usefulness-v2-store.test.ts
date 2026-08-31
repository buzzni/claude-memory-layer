import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { MemoryUsefulnessObservationV2 } from '../../src/core/retrieval-telemetry.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteGet, sqliteRun } from '../../src/core/sqlite-wrapper.js';

const roots: string[] = [];

function databasePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-usefulness-v2-'));
  roots.push(root);
  return path.join(root, 'events.sqlite');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('usefulness v2 persistence and aggregation', () => {
  it('rejects non-finite observation scores and normalizes the minimum sample boundary', async () => {
    const store = new SQLiteEventStore(databasePath());
    const observation: MemoryUsefulnessObservationV2 = {
      traceId: 'trace-invalid-number',
      eventId: 'event-invalid-number',
      observationKind: 'outcome',
      presentationMode: 'evidence',
      triggerType: 'user_prompt',
      selected: true,
      delivered: true,
      adoption: 'grounded',
      contentOverlapScore: Number.NaN,
      taskOutcome: 'unknown',
      reaskOutcome: 'none',
      explicitFeedback: null,
      confidence: 0.8,
      evaluatedAt: '2026-08-31T00:00:00.000Z',
      evaluatorVersion: 'v2'
    };

    await expect(store.upsertUsefulnessObservationV2(observation)).rejects.toThrow('finite numbers');
    await expect(store.upsertUsefulnessObservationV2({
      ...observation,
      contentOverlapScore: 0.8,
      confidence: Number.POSITIVE_INFINITY
    })).rejects.toThrow('finite numbers');

    const defaulted = await store.getUsefulnessAggregateV2({ minimumSample: Number.NaN });
    const rounded = await store.getUsefulnessAggregateV2({ minimumSample: 2.9 });
    expect(defaulted.minimumSample).toBe(20);
    expect(rounded.minimumSample).toBe(2);
    await store.close();
  });

  it('dual-writes grounded evidence while leaving unparseable tool outcome unknown', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const memory = await store.append({
      eventType: 'agent_response',
      sessionId: 'source',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      content: 'Production deploys use port 37777 and scripts/release-npm.sh.'
    });
    if (!memory.success) throw new Error('fixture append failed');
    const retrievalTime = Date.now();
    await store.recordRetrieval(memory.eventId, 'session-v2', 0.9, 'how do I deploy?', {
      traceId: 'trace-v2',
      injectedContent: 'Production deploys use port 37777 and scripts/release-npm.sh.',
      presentationMode: 'evidence',
      triggerType: 'user_prompt'
    });
    await store.append({
      eventType: 'agent_response',
      sessionId: 'session-v2',
      timestamp: new Date(retrievalTime + 60_000),
      content: 'Use port 37777 and run scripts/release-npm.sh for production.'
    });
    await store.append({
      eventType: 'tool_observation',
      sessionId: 'session-v2',
      timestamp: new Date(retrievalTime + 120_000),
      content: 'plain unparseable tool output'
    });

    await store.evaluateSessionHelpfulness('session-v2');
    const db = store.getDatabase();
    const row = sqliteGet<Record<string, unknown>>(
      db,
      `SELECT adoption, task_outcome, reask_outcome, content_overlap_score
       FROM memory_usefulness_observations_v2 WHERE trace_id = 'trace-v2'`
    );
    const legacy = sqliteGet<Record<string, unknown>>(
      db,
      `SELECT tool_success_count, tool_total_count FROM memory_helpfulness WHERE trace_id = 'trace-v2'`
    );
    const aggregate = await store.getUsefulnessAggregateV2({ minimumSample: 2 });

    expect(row).toMatchObject({ adoption: 'grounded', task_outcome: 'unknown', reask_outcome: 'none' });
    expect(Number(row?.content_overlap_score)).toBeGreaterThanOrEqual(0.3);
    expect(legacy).toMatchObject({ tool_success_count: 0, tool_total_count: 0 });
    expect(aggregate).toMatchObject({
      eligible: 1,
      evidenceEvaluated: 1,
      evidenceGrounded: 1,
      taskOutcomesEvaluated: 0,
      taskOutcomesSuccessful: 0,
      sampleState: 'insufficient_sample'
    });
    expect(aggregate.rates.taskSuccess.value).toBeNull();
    expect(aggregate.rates.taskSuccess.unknown).toBe(1);
    await store.close();
  });

  it('waits for v2 outcome persistence before session evaluation resolves', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const memory = await store.append({
      eventType: 'agent_response',
      sessionId: 'source-awaited-write',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      content: 'The awaited write fixture uses port 37777.'
    });
    if (!memory.success) throw new Error('fixture append failed');
    await store.recordRetrieval(memory.eventId, 'session-awaited-write', 0.9, 'which port?', {
      traceId: 'trace-awaited-write',
      injectedContent: 'The awaited write fixture uses port 37777.',
      presentationMode: 'evidence',
      triggerType: 'user_prompt'
    });

    let releaseWrite: (() => void) | undefined;
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const upsert = vi.spyOn(store, 'upsertUsefulnessObservationV2')
      .mockImplementation(async () => pendingWrite);
    let evaluationResolved = false;
    const evaluation = store.evaluateSessionHelpfulness('session-awaited-write');
    void evaluation.then(() => {
      evaluationResolved = true;
    });

    await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(evaluationResolved).toBe(false);
    releaseWrite?.();
    await evaluation;
    expect(evaluationResolved).toBe(true);
    await store.close();
  });

  it('uses retrieval candidates for selection yield and does not inflate sample sufficiency', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    await store.recordRetrievalTrace({
      traceId: 'trace-funnel',
      sessionId: 'session-funnel',
      queryText: 'deploy',
      candidateEventIds: ['a', 'b', 'c', 'd'],
      selectedEventIds: ['a'],
      presentationMode: 'evidence',
      triggerType: 'user_prompt'
    });
    await store.upsertUsefulnessObservationV2({
      traceId: 'trace-funnel',
      eventId: 'a',
      observationKind: 'outcome',
      presentationMode: 'evidence',
      triggerType: 'user_prompt',
      selected: true,
      delivered: true,
      adoption: 'grounded',
      contentOverlapScore: 0.8,
      taskOutcome: 'success',
      reaskOutcome: 'none',
      explicitFeedback: null,
      confidence: 0.8,
      evaluatedAt: new Date().toISOString(),
      evaluatorVersion: 'v2'
    });

    const aggregate = await store.getUsefulnessAggregateV2({ minimumSample: 2 });
    expect(aggregate).toMatchObject({ eligible: 4, selected: 1, sampleState: 'insufficient_sample' });
    expect(aggregate.rates.selectionYield).toEqual({ numerator: 1, denominator: 4, unknown: 0, value: 0.25 });
    expect(aggregate.rates.deliveryRate).toEqual({ numerator: 1, denominator: 1, unknown: 0, value: 1 });
    await store.close();
  });

  it('does not attribute outcome evidence outside the v2 evaluation window', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const memory = await store.append({
      eventType: 'agent_response',
      sessionId: 'source-window',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      content: 'The service uses port 37777.'
    });
    if (!memory.success) throw new Error('fixture append failed');
    const retrievalTime = Date.now();
    await store.recordRetrieval(memory.eventId, 'session-window', 0.8, 'which port?', {
      traceId: 'trace-window',
      injectedContent: 'The service uses port 37777.',
      presentationMode: 'evidence',
      triggerType: 'user_prompt'
    });
    await store.append({
      eventType: 'agent_response',
      sessionId: 'session-window',
      timestamp: new Date(retrievalTime + 31 * 60_000),
      content: 'The service uses port 37777.'
    });
    await store.append({
      eventType: 'tool_observation',
      sessionId: 'session-window',
      timestamp: new Date(retrievalTime + 32 * 60_000),
      content: JSON.stringify({ success: true })
    });

    await store.evaluateSessionHelpfulness('session-window');
    const observation = sqliteGet<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT adoption, content_overlap_score, task_outcome FROM memory_usefulness_observations_v2 WHERE trace_id = 'trace-window'`
    );
    expect(observation).toMatchObject({ adoption: 'unknown', content_overlap_score: null, task_outcome: 'unknown' });
    await store.close();
  });

  it('uses one retrieval-time cohort for selection and outcome window filters', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    await store.recordRetrievalTrace({
      traceId: 'trace-window-cohort',
      sessionId: 'session-window-cohort',
      queryText: 'cohort',
      candidateEventIds: ['event-cohort'],
      selectedEventIds: ['event-cohort'],
      presentationMode: 'evidence',
      triggerType: 'user_prompt'
    });
    sqliteRun(
      store.getDatabase(),
      `UPDATE retrieval_traces SET created_at = ? WHERE trace_id = ?`,
      ['2026-01-15T00:00:00.000Z', 'trace-window-cohort']
    );
    await store.upsertUsefulnessObservationV2({
      traceId: 'trace-window-cohort',
      eventId: 'event-cohort',
      observationKind: 'outcome',
      presentationMode: 'evidence',
      triggerType: 'user_prompt',
      selected: true,
      delivered: true,
      adoption: 'grounded',
      contentOverlapScore: 0.8,
      taskOutcome: 'success',
      reaskOutcome: 'none',
      explicitFeedback: null,
      confidence: 0.8,
      evaluatedAt: '2027-01-15T00:00:00.000Z',
      evaluatorVersion: 'v2'
    });

    const retrievalWindow = await store.getUsefulnessAggregateV2({
      since: new Date('2026-01-01T00:00:00.000Z'),
      until: new Date('2026-02-01T00:00:00.000Z'),
      minimumSample: 1
    });
    const evaluationOnlyWindow = await store.getUsefulnessAggregateV2({
      since: new Date('2027-01-01T00:00:00.000Z'),
      until: new Date('2027-02-01T00:00:00.000Z'),
      minimumSample: 1
    });
    expect(retrievalWindow).toMatchObject({ eligible: 1, selected: 1, evidenceGrounded: 1, sampleState: 'sufficient' });
    expect(evaluationOnlyWindow).toMatchObject({ eligible: 0, selected: 0, evidenceGrounded: 0, sampleState: 'insufficient_sample' });
    await store.close();
  });

  it('excludes unknown reference adoption from the navigation denominator', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const base: MemoryUsefulnessObservationV2 = {
      traceId: 'trace-reference-measured',
      eventId: 'event-reference-measured',
      observationKind: 'outcome',
      presentationMode: 'reference',
      triggerType: 'explicit_search',
      selected: true,
      delivered: true,
      adoption: 'navigated',
      contentOverlapScore: null,
      taskOutcome: 'unknown',
      reaskOutcome: 'none',
      explicitFeedback: null,
      confidence: 0.9,
      evaluatedAt: '2026-08-31T00:00:00.000Z',
      evaluatorVersion: 'v2'
    };
    await store.upsertUsefulnessObservationV2(base);
    await store.upsertUsefulnessObservationV2({
      ...base,
      traceId: 'trace-reference-unknown',
      eventId: 'event-reference-unknown',
      adoption: 'unknown'
    });

    const aggregate = await store.getUsefulnessAggregateV2({ minimumSample: 1 });
    expect(aggregate.referencesEligible).toBe(2);
    expect(aggregate.rates.referenceNavigation).toEqual({
      numerator: 1,
      denominator: 1,
      unknown: 1,
      value: 1
    });
    await store.close();
  });

  it('is idempotent within an evaluator version and keeps re-evaluation versions separate', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const observation: MemoryUsefulnessObservationV2 = {
      traceId: 'trace-versioned',
      eventId: 'event-versioned',
      observationKind: 'outcome',
      presentationMode: 'reference',
      triggerType: 'explicit_search',
      selected: true,
      delivered: true,
      adoption: 'navigated',
      contentOverlapScore: null,
      taskOutcome: 'success',
      reaskOutcome: 'none',
      explicitFeedback: 'positive',
      confidence: 0.9,
      evaluatedAt: '2026-08-31T00:00:00.000Z',
      evaluatorVersion: 'v2'
    };
    await store.upsertUsefulnessObservationV2(observation);
    await store.upsertUsefulnessObservationV2({ ...observation, confidence: 0.95 });
    await store.upsertUsefulnessObservationV2({ ...observation, evaluatorVersion: 'v3', taskOutcome: 'failure' });
    await store.upsertUsefulnessObservationV2({
      ...observation,
      traceId: 'trace-session-start',
      eventId: 'event-core',
      presentationMode: 'core',
      triggerType: 'session_start',
      adoption: 'unknown',
      taskOutcome: 'unknown',
      explicitFeedback: null
    });

    const db = store.getDatabase();
    expect(Number(sqliteGet<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM memory_usefulness_observations_v2')?.count)).toBe(3);
    const aggregate = await store.getUsefulnessAggregateV2({ minimumSample: 1 });
    expect(aggregate).toMatchObject({
      eligible: 1,
      referencesEligible: 1,
      referencesNavigated: 1,
      taskOutcomesEvaluated: 1,
      taskOutcomesSuccessful: 1,
      explicitPositive: 1,
      sampleState: 'sufficient',
      evaluatorVersion: 'v2',
      excludesSessionStart: true
    });
    expect(aggregate.rates.explicitPositive).toEqual({ numerator: 1, denominator: 1, unknown: 0, value: 1 });
    const withCore = await store.getUsefulnessAggregateV2({ minimumSample: 1, includeSessionStart: true });
    expect(withCore.eligible).toBe(2);
    expect(withCore.unknownByDimension.adoption).toBe(1);
    await store.close();
  });
});
