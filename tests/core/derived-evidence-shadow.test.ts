import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import {
  DERIVED_EVIDENCE_GENERATOR_VERSION,
  evaluateDerivedEvidenceShadow,
  readSourceClock
} from '../../src/core/operations/derived-evidence-candidates.js';
import type { LessonCandidate } from '../../src/core/operations/lesson-candidate-service.js';

/**
 * R4: derived candidates carry their provenance, stay in shadow, and the
 * exclusions the spec names (environment-dependent failures, missing
 * credentials, failure-only attempts, one-off PR narratives, repository
 * document copies, secrets) actually block promotion.
 */

const roots: string[] = [];

function databasePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-derived-evidence-'));
  roots.push(root);
  return path.join(root, 'events.sqlite');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function candidateFor(id: string, sourceEventIds: string[]): LessonCandidate {
  return {
    candidateId: id,
    projectHash: 'proj',
    name: 'Verify before publishing',
    trigger: 'When releasing a package version',
    steps: ['Run the focused tests', 'Run typecheck', 'Publish through the tagged workflow'],
    confidence: 0.72,
    sourceSessionIds: ['session-1', 'session-2'],
    sourceEventIds,
    failureModes: [],
    skillCandidate: true,
    pattern: { tools: ['focused tests', 'typecheck'], fileCategories: ['src'], taskPatterns: ['code-change'] },
    reasons: ['2 successful sessions share the same tool pattern']
  };
}

async function seedEvent(store: SQLiteEventStore, content: string, metadata?: Record<string, unknown>): Promise<string> {
  const appended = await store.append({
    eventType: 'tool_observation',
    sessionId: 'session-1',
    timestamp: new Date('2026-09-01T00:00:00.000Z'),
    content,
    metadata
  });
  if (!appended.success || !appended.eventId) throw new Error('fixture append failed');
  return appended.eventId;
}

describe('derived evidence shadow evaluation (specs R4)', () => {
  it('removes sensitive candidate text from the entire returned report', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const eventId = await seedEvent(store, 'All tests passed.');
    const candidate = candidateFor('sensitive-output', [eventId]);
    candidate.steps = ['NPM_TOKEN=synthetic-do-not-emit'];
    candidate.reasons = ['NPM_TOKEN=synthetic-do-not-emit'];
    const report = evaluateDerivedEvidenceShadow(store.getDatabase(), [candidate]);
    expect(report.blocked[0].promotion.rejections).toContain('sensitive_material');
    expect(JSON.stringify(report)).not.toContain('synthetic-do-not-emit');
    await store.close();
  });

  it('blocks incomplete provenance and measures a known zero lag', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const eventId = await seedEvent(store, 'All tests passed.');
    const report = evaluateDerivedEvidenceShadow(store.getDatabase(), [candidateFor('partial', [eventId, 'missing'])]);
    expect(report.shadowCandidates).toHaveLength(0);
    expect(report.blocked[0].promotion.rejections).toContain('no_source_refs');
    expect(readSourceClock([{ id: 'x', event_type: 'user_prompt', content: '',
      timestamp: '2026-09-05T12:00:00Z',
      metadata: JSON.stringify({ originalTimestamp: '2026-09-05T12:00:00Z' })
    }]).maxIngestLagMs).toBe(0);
    await store.close();
  });
  it('carries source refs, applicability, validity and generator version and never enters recall', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const eventId = await seedEvent(store, 'npm test -- release.test.ts\n12 passed, 0 errors. Build succeeded.');

    const report = evaluateDerivedEvidenceShadow(store.getDatabase(), [candidateFor('cand-ok', [eventId])], {
      projectId: 'proj'
    });

    expect(report.mode).toBe('shadow');
    expect(report.shadowCandidates).toHaveLength(1);
    const candidate = report.shadowCandidates[0];
    expect(candidate.sourceRefs).toEqual([{ projectId: 'proj', kind: 'event', id: eventId }]);
    expect(candidate.applicability.length).toBeGreaterThan(0);
    expect(candidate.rationale.length).toBeGreaterThan(0);
    expect(candidate.validity.reviewWhen.length).toBeGreaterThan(0);
    expect(candidate.generatorVersion).toBe(DERIVED_EVIDENCE_GENERATOR_VERSION);
    // Shadow mode: nothing derived is retrievable until a reviewer promotes it.
    expect(candidate.promotion).toMatchObject({ state: 'shadow_candidate', usableForRecall: false });
    await store.close();
  });

  it('blocks the promotions R4 names instead of turning them into durable lessons', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();

    const cases: Array<{ id: string; content: string; reason: string }> = [
      {
        id: 'cand-env',
        content: 'npm install\nnpm ERR! code EACCES\nnpm ERR! permission denied, mkdir',
        reason: 'environment_dependent_failure'
      },
      {
        id: 'cand-creds',
        content: 'curl the registry\nHTTP 401 Unauthorized: invalid api key for the publish endpoint',
        reason: 'missing_credentials'
      },
      {
        id: 'cand-failed',
        content: 'vitest run\n3 failed, exit code 1\nerror: cannot resolve module',
        reason: 'unresolved_failure'
      },
      {
        id: 'cand-pr',
        content: 'Opened pull request PR #142 and merged it after review. Tests passed.',
        reason: 'one_off_pr_narrative'
      },
      {
        id: 'cand-docs',
        content: 'Copied the release checklist verbatim out of AGENTS.md. Tests passed.',
        reason: 'repository_document_copy'
      },
      {
        id: 'cand-secret',
        content: 'export NPM_TOKEN=npm_ExampleSecretValue123 && npm publish\npublish succeeded',
        reason: 'sensitive_material'
      }
    ];

    for (const testCase of cases) {
      const eventId = await seedEvent(store, testCase.content);
      const report = evaluateDerivedEvidenceShadow(
        store.getDatabase(),
        [candidateFor(testCase.id, [eventId])],
        { projectId: 'proj' }
      );
      expect(report.shadowCandidates, `${testCase.id} must not become a shadow candidate`).toHaveLength(0);
      expect(report.blocked[0].promotion.state).toBe('blocked');
      expect(report.blocked[0].promotion.rejections).toContain(testCase.reason);
      expect(report.blocked[0].promotion.usableForRecall).toBe(false);
    }
    await store.close();
  });

  it('keeps only the retry condition when a failure was resolved by retrying', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const eventId = await seedEvent(
      store,
      'vitest run — 1 failed, flaky snapshot.\nRetried the same command: all tests pass, 0 errors.'
    );
    const report = evaluateDerivedEvidenceShadow(store.getDatabase(), [candidateFor('cand-retry', [eventId])], {
      projectId: 'proj'
    });
    const candidate = report.shadowCandidates[0];
    expect(candidate).toBeDefined();
    expect(candidate.applicability.some((line) => /retry/i.test(line))).toBe(true);
    await store.close();
  });

  it('blocks a candidate whose source events cannot be read back', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    const report = evaluateDerivedEvidenceShadow(
      store.getDatabase(),
      [candidateFor('cand-dangling', ['no-such-event'])],
      { projectId: 'proj' }
    );
    expect(report.unresolvedSourceRefs).toBe(1);
    expect(report.blocked[0].promotion.rejections).toContain('no_source_refs');
    // A reference that resolves to nothing is typed unknown, never "event".
    expect(report.blocked[0].sourceRefs[0].kind).toBe('unknown');
    await store.close();
  });

  it('separates the source clock from the store clock and counts unknown clocks', () => {
    const clock = readSourceClock([
      {
        id: 'a',
        event_type: 'tool_observation',
        timestamp: '2026-09-05T12:00:00.000Z',
        content: 'x',
        metadata: JSON.stringify({ originalTimestamp: '2026-09-05T11:00:00.000Z' })
      },
      {
        id: 'b',
        event_type: 'tool_observation',
        timestamp: '2026-09-05T13:00:00.000Z',
        content: 'y',
        metadata: null
      }
    ]);
    expect(clock.occurredAt).toBe('2026-09-05T11:00:00.000Z');
    expect(clock.ingestedAt).toBe('2026-09-05T12:00:00.000Z');
    expect(clock.maxIngestLagMs).toBe(3_600_000);
    // A source with no original clock is counted, not assumed lag-free.
    expect(clock.unknownSourceClocks).toBe(1);
  });

  it('reports per-source ingest lag from the store', async () => {
    const store = new SQLiteEventStore(databasePath());
    await store.initialize();
    await store.append({
      eventType: 'user_prompt',
      sessionId: 'imported',
      timestamp: new Date('2026-09-05T12:00:00.000Z'),
      content: 'imported prompt',
      metadata: { source: 'codex', originalTimestamp: '2026-09-05T11:30:00.000Z' }
    });
    await store.append({
      eventType: 'user_prompt',
      sessionId: 'live',
      timestamp: new Date('2026-09-05T12:05:00.000Z'),
      content: 'live prompt'
    });

    const clocks = await store.getIngestSourceClocks();
    const codex = clocks.find((row) => row.source === 'codex');
    const native = clocks.find((row) => row.source === 'native');
    expect(codex).toMatchObject({ events: 1, withSourceClock: 1, maxLagMs: 1_800_000 });
    expect(native).toMatchObject({ events: 1, withSourceClock: 0, unknownSourceClock: 1, maxLagMs: null });
    await store.close();
  });
});
