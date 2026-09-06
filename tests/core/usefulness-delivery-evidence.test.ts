import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteGet, sqliteRun } from '../../src/core/sqlite-wrapper.js';
import { CURRENT_USEFULNESS_EVALUATOR_VERSION } from '../../src/core/retrieval-telemetry.js';
import { USEFULNESS_V2_EVALUATION_WINDOW_MS } from '../../src/core/usefulness-outcome-v2.js';

const roots: string[] = [];

function databasePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-delivery-evidence-'));
  roots.push(root);
  return path.join(root, 'events.sqlite');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function observation(store: SQLiteEventStore, traceId: string, eventId: string) {
  return sqliteGet<Record<string, unknown>>(
    store.getDatabase(),
    `SELECT * FROM memory_usefulness_observations_v2
     WHERE trace_id = ? AND COALESCE(memory_id, event_id) = ? AND evaluator_version = ?`,
    [traceId, eventId, CURRENT_USEFULNESS_EVALUATOR_VERSION]
  );
}

async function seedDelivery(store: SQLiteEventStore, options: {
  traceId: string;
  sessionId: string;
  retrievalTime: Date;
  responseAt?: Date;
  responseText?: string;
  /** Record an observed stdout emission, pinned to the same instant. */
  emitted?: boolean;
}): Promise<string> {
  const memory = await store.append({
    eventType: 'agent_response',
    sessionId: 'source',
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    content: 'Production deploys use port 37777 and scripts/release-npm.sh.'
  });
  if (!memory.success) throw new Error('fixture append failed');
  await store.recordRetrievalTrace({
    traceId: options.traceId,
    sessionId: options.sessionId,
    queryText: 'how do I deploy?',
    candidateEventIds: [memory.eventId],
    selectedEventIds: [memory.eventId],
    items: [{ kind: 'event', id: memory.eventId, selected: true }],
    presentationMode: 'evidence',
    triggerType: 'user_prompt'
  });
  await store.recordRetrieval(memory.eventId, options.sessionId, 0.9, 'how do I deploy?', {
    traceId: options.traceId,
    injectedContent: 'Production deploys use port 37777 and scripts/release-npm.sh.',
    memoryKind: 'event',
    presentationMode: 'evidence',
    triggerType: 'user_prompt'
  });
  if (options.emitted) {
    await store.recordDeliveryOutcome({
      traceId: options.traceId,
      status: 'emitted',
      evidence: 'hook_stdout',
      deliveredAt: options.retrievalTime
    });
  }
  // recordRetrieval stamps created_at with now(); pin it so window boundaries
  // are deterministic.
  sqliteRun(
    store.getDatabase(),
    `UPDATE memory_helpfulness SET created_at = ? WHERE trace_id = ?`,
    [options.retrievalTime.toISOString(), options.traceId]
  );
  if (options.responseAt) {
    await store.append({
      eventType: 'agent_response',
      sessionId: options.sessionId,
      timestamp: options.responseAt,
      content: options.responseText ?? 'Use port 37777 and run scripts/release-npm.sh for production.'
    });
  }
  return memory.eventId;
}

describe('delivery evidence and bounded re-evaluation (specs R3)', () => {
  it('does not use a future-dated response beyond the recorded evaluation cutoff', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const retrievalTime = new Date(Date.now() - 60_000);
    await seedDelivery(store, {
      traceId: 'future-trace', sessionId: 'future-session', retrievalTime, emitted: true,
      responseAt: new Date(Date.now() + 60_000)
    });
    await store.evaluateSessionHelpfulness('future-session');
    expect(sqliteGet(store.getDatabase(), `SELECT adoption FROM memory_usefulness_observations_v2 WHERE trace_id='future-trace'`))
      .toEqual({ adoption: 'unknown' });
    await store.close();
  });
  it('starts a selection undelivered and never assumes delivery at evaluation time', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const retrievalTime = new Date('2026-09-01T10:00:00.000Z');
    const eventId = await seedDelivery(store, {
      traceId: 'trace-formatted',
      sessionId: 'session-formatted',
      retrievalTime,
      responseAt: new Date(retrievalTime.getTime() + 60_000)
    });

    const selection = sqliteGet<{ delivery_status: string; delivery_evidence: string }>(
      store.getDatabase(),
      'SELECT delivery_status, delivery_evidence FROM memory_helpfulness WHERE trace_id = ?',
      ['trace-formatted']
    );
    expect(selection).toMatchObject({ delivery_status: 'formatted', delivery_evidence: 'context_formatted' });

    await store.evaluateSessionHelpfulness('session-formatted');
    const row = observation(store, 'trace-formatted', eventId);
    // Formatted but never observed leaving the process: delivered stays null.
    expect(row?.delivered).toBeNull();
    expect(row?.delivery_status).toBe('formatted');
    await store.close();
  });

  it('marks delivery true only on emitted output and false on a write failure', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const retrievalTime = new Date('2026-09-01T10:00:00.000Z');
    const emittedEvent = await seedDelivery(store, {
      traceId: 'trace-emitted',
      sessionId: 'session-emitted',
      retrievalTime,
      responseAt: new Date(retrievalTime.getTime() + 60_000)
    });
    await store.recordDeliveryOutcome({ traceId: 'trace-emitted', status: 'emitted', evidence: 'hook_stdout' });
    await store.evaluateSessionHelpfulness('session-emitted');
    expect(Number(observation(store, 'trace-emitted', emittedEvent)?.delivered)).toBe(1);

    const failedEvent = await seedDelivery(store, {
      traceId: 'trace-failed',
      sessionId: 'session-failed',
      retrievalTime,
      responseAt: new Date(retrievalTime.getTime() + 60_000)
    });
    await store.recordDeliveryOutcome({ traceId: 'trace-failed', status: 'failed', evidence: 'write_error' });
    await store.evaluateSessionHelpfulness('session-failed');
    const failed = observation(store, 'trace-failed', failedEvent);
    // Output failed after selection: this must never read as delivered.
    expect(Number(failed?.delivered)).toBe(0);
    expect(failed?.delivery_evidence).toBe('write_error');
    expect(sqliteGet<{ delivered_at: string | null }>(
      store.getDatabase(),
      `SELECT delivered_at FROM memory_helpfulness WHERE trace_id = 'trace-failed'`
    )?.delivered_at).toBeNull();
    await store.close();
  });

  it('anchors the evaluation window at the first positive delivery', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const firstDelivery = new Date('2026-09-01T10:00:00.000Z');
    await seedDelivery(store, {
      traceId: 'trace-ack', sessionId: 'session-ack', retrievalTime: firstDelivery
    });
    await store.recordDeliveryOutcome({
      traceId: 'trace-ack', status: 'emitted', evidence: 'hook_stdout', deliveredAt: firstDelivery
    });
    await store.recordDeliveryOutcome({
      traceId: 'trace-ack', status: 'acknowledged', evidence: 'consumer_ack',
      deliveredAt: new Date(firstDelivery.getTime() + 5 * 60_000)
    });
    expect(sqliteGet<{ delivered_at: string; delivery_status: string }>(
      store.getDatabase(),
      `SELECT delivered_at, delivery_status FROM memory_helpfulness WHERE trace_id = 'trace-ack'`
    )).toEqual({ delivered_at: firstDelivery.toISOString(), delivery_status: 'acknowledged' });
    await store.close();
  });

  it('records the evaluation window and cutoff so a truncated window is visible', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const retrievalTime = new Date(Date.now() - 60_000);
    const eventId = await seedDelivery(store, {
      traceId: 'trace-window',
      sessionId: 'session-window',
      retrievalTime,
      responseAt: new Date(retrievalTime.getTime() + 10_000)
    });
    await store.evaluateSessionHelpfulness('session-window');
    const row = observation(store, 'trace-window', eventId);
    expect(Number(row?.evaluation_window_ms)).toBe(USEFULNESS_V2_EVALUATION_WINDOW_MS);
    // Evaluated well before the window closed.
    expect(new Date(String(row?.evaluation_cutoff)).getTime())
      .toBeLessThan(retrievalTime.getTime() + USEFULNESS_V2_EVALUATION_WINDOW_MS);
    await store.close();
  });

  it('re-evaluates a late response once the observation window has actually elapsed', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    // Recent enough that the first evaluation happens while the 30-minute
    // adoption window is still open — the case that used to freeze a delivery
    // as "not observed" forever.
    const retrievalTime = new Date(Date.now() - 60_000);
    const eventId = await seedDelivery(store, {
      traceId: 'trace-late',
      sessionId: 'session-late',
      retrievalTime,
      responseAt: new Date(retrievalTime.getTime() + 30_000),
      responseText: 'Checking the deployment steps now.',
      // Adoption is only measurable once delivery is evidenced; a selection
      // that was merely formatted stays unknown (see the test below).
      emitted: true
    });
    // First evaluation runs a minute after delivery: the grounded response has
    // not arrived yet, so adoption is not_observed.
    await store.evaluateSessionHelpfulness('session-late');
    expect(observation(store, 'trace-late', eventId)?.adoption).toBe('not_observed');

    // The grounded answer arrives later, still inside the 30-minute window.
    await store.append({
      eventType: 'agent_response',
      sessionId: 'session-late',
      timestamp: new Date(retrievalTime.getTime() + 10 * 60_000),
      content: 'Use port 37777 and run scripts/release-npm.sh for production.'
    });

    const afterWindow = new Date(retrievalTime.getTime() + USEFULNESS_V2_EVALUATION_WINDOW_MS + 1000);
    const summary = await store.reevaluateBoundedUsefulness({ now: afterWindow });
    expect(summary.rowsReevaluated).toBe(1);
    const row = observation(store, 'trace-late', eventId);
    expect(row?.adoption).toBe('grounded');
    // The cutoff now covers the whole window, so the row is not revisited again.
    const second = await store.reevaluateBoundedUsefulness({ now: afterWindow });
    expect(second.rowsReevaluated).toBe(0);
    await store.close();
  });

  it('never grounds an evidence delivery that was only formatted or failed', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const retrievalTime = new Date(Date.now() - 60_000);

    // Formatted only: the text was built but never observed leaving the
    // process. A later response that happens to overlap proves nothing.
    const formattedEvent = await seedDelivery(store, {
      traceId: 'trace-overlap-formatted',
      sessionId: 'session-overlap-formatted',
      retrievalTime,
      responseAt: new Date(retrievalTime.getTime() + 30_000)
    });
    await store.evaluateSessionHelpfulness('session-overlap-formatted');
    const formatted = observation(store, 'trace-overlap-formatted', formattedEvent);
    expect(formatted?.adoption).toBe('unknown');
    expect(formatted?.task_outcome).toBe('unknown');

    // Write failure: the memory demonstrably never reached the consumer.
    const failedEvent = await seedDelivery(store, {
      traceId: 'trace-overlap-failed',
      sessionId: 'session-overlap-failed',
      retrievalTime,
      responseAt: new Date(retrievalTime.getTime() + 30_000)
    });
    await store.recordDeliveryOutcome({
      traceId: 'trace-overlap-failed',
      status: 'failed',
      evidence: 'write_error',
      deliveredAt: retrievalTime
    });
    await store.evaluateSessionHelpfulness('session-overlap-failed');
    const failed = observation(store, 'trace-overlap-failed', failedEvent);
    expect(failed?.adoption).toBe('not_observed');
    expect(failed?.task_outcome).toBe('unknown');

    // The identical response with observed delivery does ground.
    const emittedEvent = await seedDelivery(store, {
      traceId: 'trace-overlap-emitted',
      sessionId: 'session-overlap-emitted',
      retrievalTime,
      responseAt: new Date(retrievalTime.getTime() + 30_000),
      emitted: true
    });
    await store.evaluateSessionHelpfulness('session-overlap-emitted');
    expect(observation(store, 'trace-overlap-emitted', emittedEvent)?.adoption).toBe('grounded');
    await store.close();
  });

  it('reports unknown reference navigation apart from an unopened reference', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const memory = await store.append({
      eventType: 'agent_response',
      sessionId: 'source',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      content: 'Reference target.'
    });
    if (!memory.success) throw new Error('fixture append failed');
    // No trace link at all: opens can never be attributed to this delivery, so
    // "not opened" is not an observation we can make.
    await store.recordRetrieval(memory.eventId, 'session-ref', 0.5, 'reference', {
      memoryKind: 'event',
      presentationMode: 'reference',
      triggerType: 'user_prompt',
      injectedContent: 'Reference target.'
    });
    await store.evaluateSessionHelpfulness('session-ref');
    const row = sqliteGet<{ adoption: string }>(
      store.getDatabase(),
      `SELECT adoption FROM memory_usefulness_observations_v2
       WHERE COALESCE(memory_id, event_id) = ? AND evaluator_version = ?`,
      [memory.eventId, CURRENT_USEFULNESS_EVALUATOR_VERSION]
    );
    expect(row?.adoption).toBe('unknown');
    await store.close();
  });

  it('separates delivery-evidence rows from the legacy assumed-delivery generation', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const retrievalTime = new Date('2026-09-01T10:00:00.000Z');
    await seedDelivery(store, {
      traceId: 'trace-current',
      sessionId: 'session-current',
      retrievalTime,
      responseAt: new Date(retrievalTime.getTime() + 60_000)
    });
    await store.recordDeliveryOutcome({ traceId: 'trace-current', status: 'emitted', evidence: 'hook_stdout' });
    await store.evaluateSessionHelpfulness('session-current');
    await store.upsertUsefulnessObservationV2({
      traceId: 'trace-legacy-assumed',
      eventId: 'event-legacy',
      observationKind: 'outcome',
      presentationMode: 'evidence',
      triggerType: 'user_prompt',
      selected: true,
      delivered: true,
      adoption: 'grounded',
      contentOverlapScore: 0.5,
      taskOutcome: 'unknown',
      reaskOutcome: 'none',
      explicitFeedback: null,
      confidence: 0.8,
      evaluatedAt: retrievalTime.toISOString(),
      evaluatorVersion: 'v2'
    });

    const current = await store.getUsefulnessAggregateV2({ minimumSample: 1 });
    expect(current.evaluatorVersion).toBe(CURRENT_USEFULNESS_EVALUATOR_VERSION);
    expect(current.deliveryStatusCounts.emitted).toBe(1);
    // The v2 row is counted but kept out of the current rates.
    expect(current.legacyAssumedDeliveryRows).toBe(1);
    expect(current.rates.deliveryRate.denominator).toBe(1);
    expect(current.selectedByKind.event).toBe(1);
    expect(current.heuristics.grounding).toBe('text_overlap');
    await store.close();
  });
});
