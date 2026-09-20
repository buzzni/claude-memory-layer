import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as hostContract from '../../src/services/lesson-host-service.js';
import { createLessonHostService, hashLessonCandidatePayload } from '../../src/services/lesson-host-service.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { LessonRepository } from '../../src/core/operations/lesson-repository.js';
import { MemoryQueryService } from '../../src/core/engine/memory-query-service.js';
import { MemoryAssetPermissionService } from '../../src/core/operations/memory-asset-permission-service.js';
import { CANONICAL_MEMORY_PERMISSION_MODE_ENV } from '../../src/core/operations/canonical-memory-access-service.js';

const tempDirs: string[] = [];

function fixture(now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'cml-host-lessons-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  const bindings = new Map([
    ['reader', { projectHash: 'project-a', actorId: 'actor-a', userId: 'user-a', machineId: 'machine-a', sessionId: 'session-a', generation: 3, capabilities: ['lesson.read'] as const }],
    ['reviewer', { projectHash: 'project-a', actorId: 'actor-a', userId: 'user-a', machineId: 'machine-a', sessionId: 'session-a', generation: 3, capabilities: ['lesson.read', 'lesson.review', 'lesson.manage'] as const, normalEndSessionIds: ['session-a'] }],
    ['other-project', { projectHash: 'project-b', actorId: 'actor-b', userId: 'user-b', machineId: 'machine-b', sessionId: 'session-b', generation: 3, capabilities: ['lesson.read'] as const }]
  ]);
  const service = createLessonHostService({
    db: store.getDatabase(),
    verifyBinding: async (binding: unknown) => {
      const verified = bindings.get(String(binding));
      if (!verified) throw new Error('untrusted host binding');
      return verified;
    }, eventStore: store,
    now
  });
  return { dir, store, service, bindings, cleanup: async () => store.close() };
}

async function seedSource(store: SQLiteEventStore, projectHash = 'project-a'): Promise<string> {
  const id = randomUUID();
  await store.importEvents([{
    id,
    eventType: 'tool_observation',
    sessionId: 'session-source',
    timestamp: new Date('2026-09-20T00:00:00.000Z'),
    content: 'focused test passed with verified result',
    canonicalKey: `event:${id}`,
    dedupeKey: `dedupe:${id}`,
    metadata: { scope: { project: { hash: projectHash } } }
  }]);
  return id;
}

function candidate(sourceEventId: string) {
  return {
    name: 'Verify focused changes',
    trigger: 'When changing a focused service',
    steps: ['Run focused tests', 'Run typecheck'],
    confidence: 0.9,
    sourceSessionIds: ['session-source'],
    sourceEventIds: [sourceEventId],
    failureModes: ['Do not skip verification'],
    skillCandidate: false,
    scope: 'this project focused service changes',
    validation: ['focused test passed'],
    reconsiderWhen: 'the test command or service boundary changes'
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('authenticated lesson host service', () => {
  it('appends verified normal-end evidence through canonical ingestion and returns its persisted event id', async () => {
    const { store, service, cleanup } = fixture();
    await store.initialize();
    const result = await service.appendNormalEndEvidence({ version: 1, requestId: 'normal-end-1', binding: 'reviewer', generation: 3, evidenceKey: 'turn-end-1', sessionId: 'session-a', content: 'Provider accepted the bounded turn summary.' });
    const events = store.getDatabase().prepare('SELECT id, content FROM events WHERE session_id=?').all('session-a') as Array<{ id: string; content: string }>;
    await cleanup();
    expect(result).toMatchObject({ outcome: 'persisted', evidenceKey: 'turn-end-1' });
    expect(events.some((event) => event.id === result.eventId && event.content.includes('bounded turn'))).toBe(true);
  });
  it('rejects forged request identity and unsupported contract versions', async () => {
    const { store, service, cleanup } = fixture();
    await store.initialize();

    await expect(service.recall({ version: 1, requestId: 'r1', binding: 'reader', turnId: 'turn-1', query: 'focused changes', actorId: 'forged' } as never)).rejects.toThrow(/unrecognized/i);
    await expect(service.recall({ version: 2, requestId: 'r2', binding: 'reader', turnId: 'turn-1', query: 'focused changes' })).resolves.toEqual({ outcome: 'unsupported_version' });
    await cleanup();
  });

  it('persists an idempotent candidate queue, rejects unsafe payloads, and makes no candidate for no-lesson', async () => {
    const { store, service, cleanup } = fixture();
    await store.initialize();
    const sourceEventId = await seedSource(store);
    const payload = candidate(sourceEventId);
    const payloadHash = hashLessonCandidatePayload(payload);

    const first = await service.enqueueCandidate({ version: 1, requestId: 'enqueue-1', binding: 'reviewer', evidenceKey: 'evidence-1', payloadHash, generation: 3, candidate: payload });
    const replay = await service.enqueueCandidate({ version: 1, requestId: 'enqueue-1', binding: 'reviewer', evidenceKey: 'evidence-1', payloadHash, generation: 3, candidate: payload });
    const procedural = await service.enqueueCandidate({ version: 1, requestId: 'enqueue-token-budget', binding: 'reviewer', evidenceKey: 'evidence-token-budget', generation: 3, candidate: { ...candidate(sourceEventId), name: 'Preserve token budgets', trigger: 'When a token budget is tight', steps: ['Measure the token budget before summarizing'] } });
    await expect(service.enqueueCandidate({ version: 1, requestId: 'enqueue-secret', binding: 'reviewer', evidenceKey: 'evidence-secret', generation: 3, candidate: { ...candidate(sourceEventId), steps: ['use token=secret-value'] } })).rejects.toThrow(/private|credential|forbidden/i);
    const listed = await service.listCandidates({ version: 1, requestId: 'list-1', binding: 'reviewer' });
    await cleanup();

    expect(first).toMatchObject({ outcome: 'pending', revision: 1, evidenceKey: 'evidence-1' });
    expect(replay).toEqual(first);
    expect(procedural).toMatchObject({ outcome: 'pending' });
    expect(listed).toMatchObject({ outcome: 'ok', candidates: expect.arrayContaining([expect.objectContaining({ candidateId: first.candidateId })]), nextOffset: null });
  });

  it('atomically approves exact reviewed payloads, fences stale generations, and excludes disabled legacy lessons from recall', async () => {
    const { store, service, bindings, cleanup } = fixture();
    await store.initialize();
    const sourceEventId = await seedSource(store);
    const payload = candidate(sourceEventId);
    const payloadHash = hashLessonCandidatePayload(payload);
    const queued = await service.enqueueCandidate({ version: 1, requestId: 'enqueue-2', binding: 'reviewer', evidenceKey: 'evidence-2', payloadHash, generation: 3, candidate: payload });
    const reviewed = await service.markReviewed({ version: 1, requestId: 'review-2', binding: 'reviewer', candidateId: queued.candidateId, expectedRevision: queued.revision, payloadHash, generation: 3 });

    await expect(service.approveCandidate({ version: 1, requestId: 'approve-stale', binding: 'reviewer', candidateId: queued.candidateId, expectedRevision: reviewed.revision, payloadHash, generation: 2 })).rejects.toThrow(/generation/i);
    const accepted = await service.approveCandidate({ version: 1, requestId: 'approve-2', binding: 'reviewer', candidateId: queued.candidateId, expectedRevision: reviewed.revision, payloadHash, generation: 3 });
    const direct = await service.get({ version: 1, requestId: 'get-direct', binding: 'reviewer', lessonId: accepted.lessonId });
    const beforeDisable = await service.recall({ version: 1, requestId: 'recall-1', binding: 'reader', turnId: 'turn-1', query: 'focused service changes' });
    await service.setRecallEnabled({ version: 1, requestId: 'disable-1', binding: 'reviewer', lessonId: accepted.lessonId, expectedRevision: accepted.lessonRevision, enabled: false, generation: 3 });
    const afterDisable = await service.recall({ version: 1, requestId: 'recall-2', binding: 'reader', turnId: 'turn-2', query: 'focused service changes' });
    bindings.set('reader', { projectHash: 'project-b', actorId: 'actor-b', userId: 'user-b', machineId: 'machine-b', sessionId: 'session-b', generation: 3, capabilities: ['lesson.read'] as const });
    const foreign = await service.get({ version: 1, requestId: 'get-foreign', binding: 'reader', lessonId: accepted.lessonId });
    const raw = new LessonRepository(store.getDatabase()).get(accepted.lessonId);
    await cleanup();

    expect(accepted).toMatchObject({ outcome: 'accepted', lessonRevision: 1 });
    expect(direct).toMatchObject({ outcome: 'found', lesson: { scope: payload.scope, validation: payload.validation, reconsiderWhen: payload.reconsiderWhen, sourceEventIds: payload.sourceEventIds } });
    expect(beforeDisable).toMatchObject({ outcome: 'selected' });
    expect(beforeDisable.lessonIds).toEqual([accepted.lessonId]);
    expect(afterDisable).toMatchObject({ outcome: 'no_match', lessonIds: [] });
    expect(foreign).toEqual({ outcome: 'not_found' });
    expect(raw?.recallEnabled).toBe(false);
  });

  it('allows a reviewed candidate from an earlier worker generation to be approved by a current UI binding', async () => {
    const { store, service, bindings, cleanup } = fixture();
    await store.initialize();
    const sourceEventId = await seedSource(store);
    const payload = candidate(sourceEventId);
    const payloadHash = hashLessonCandidatePayload(payload);
    const queued = await service.enqueueCandidate({ version: 1, requestId: 'generation-enqueue', binding: 'reviewer', evidenceKey: 'generation-evidence', payloadHash, generation: 3, candidate: payload });
    const reviewed = await service.markReviewed({ version: 1, requestId: 'generation-review', binding: 'reviewer', candidateId: queued.candidateId, expectedRevision: queued.revision, payloadHash, generation: 3 });
    bindings.set('reviewer', { projectHash: 'project-a', actorId: 'actor-a', userId: 'user-a', machineId: 'machine-a', sessionId: 'session-a', generation: 4, capabilities: ['lesson.read', 'lesson.review', 'lesson.manage'] as const });
    const accepted = await service.approveCandidate({ version: 1, requestId: 'generation-approve', binding: 'reviewer', candidateId: queued.candidateId, expectedRevision: reviewed.revision, payloadHash, generation: 4 });
    await cleanup();

    expect(accepted).toMatchObject({ outcome: 'accepted' });
  });

  it('returns a typed timeout with no selected trace when its internal recall deadline expires', async () => {
    let clock = 0;
    const { store, service, cleanup } = fixture(() => (clock++ === 0 ? 0 : 901));
    await store.initialize();
    const sourceEventId = await seedSource(store);
    await new LessonRepository(store.getDatabase()).upsert({ projectHash: 'project-a', name: 'Deadline', trigger: 'When deadline matters', steps: ['Stop safely'], confidence: 0.9, sourceEventIds: [sourceEventId] });
    const result = await service.recall({ version: 1, requestId: 'deadline-recall', binding: 'reader', turnId: 'deadline-turn', query: 'deadline matters' });
    const traces = store.getDatabase().prepare('SELECT * FROM lesson_host_traces').all();
    await cleanup();

    expect(result).toEqual({ outcome: 'timeout', lessonIds: [], lessons: [] });
    expect(traces).toHaveLength(0);
  });

  it('separates selected, delivered, and read trace acknowledgements without storing raw query text', async () => {
    const { store, service, cleanup } = fixture();
    await store.initialize();
    const sourceEventId = await seedSource(store);
    const lesson = await new LessonRepository(store.getDatabase()).upsert({ projectHash: 'project-a', name: 'Focused verification', trigger: 'When focused test changes', steps: ['Run focused tests'], confidence: 0.9, sourceEventIds: [sourceEventId] });
    const selected = await service.recall({ version: 1, requestId: 'select-1', binding: 'reader', turnId: 'turn-a', query: 'focused test changes' });
    const delivered = await service.ackDelivery({ version: 1, requestId: 'deliver-1', binding: 'reader', turnId: 'turn-a', traceId: selected.traceId, lessonIds: [lesson.lessonId], lessonRevisions: [{ lessonId: lesson.lessonId, revision: lesson.revision }] });
    const read = await service.recordRead({ version: 1, requestId: 'read-1', binding: 'reader', lessonId: lesson.lessonId });
    const listed = await service.listTraces({ version: 1, requestId: 'trace-list-1', binding: 'reviewer' });
    const traces = store.getDatabase().prepare('SELECT phase, query_text, lesson_ids_json FROM lesson_host_traces ORDER BY created_at ASC').all() as Array<Record<string, unknown>>;
    await cleanup();

    expect(selected).toMatchObject({ outcome: 'selected' });
    expect(delivered).toMatchObject({ outcome: 'delivered' });
    expect(read).toMatchObject({ outcome: 'read' });
    expect(listed).toMatchObject({ outcome: 'ok', traces: expect.arrayContaining([expect.objectContaining({ phase: 'selected', lessonRevisions: [{ lessonId: lesson.lessonId, revision: lesson.revision }] })]) });
    expect(traces.map((trace) => trace.phase)).toEqual(['selected', 'delivered', 'read']);
    expect(traces.every((trace) => trace.query_text === null)).toBe(true);
  });

  it('rejects delivery acknowledgement when a selected lesson revision changed before provider acceptance', async () => {
    const { store, service, cleanup } = fixture();
    await store.initialize();
    const sourceEventId = await seedSource(store);
    const repository = new LessonRepository(store.getDatabase());
    const lesson = await repository.upsert({ projectHash: 'project-a', name: 'Revision fence', trigger: 'When delivery must be fenced', steps: ['Read revision'], confidence: 0.9, sourceEventIds: [sourceEventId] });
    const selected = await service.recall({ version: 1, requestId: 'select-stale', binding: 'reader', turnId: 'turn-stale', query: 'delivery fenced revision' });
    await repository.upsert({ lessonId: lesson.lessonId, projectHash: 'project-a', name: lesson.name, trigger: lesson.trigger, steps: ['Read latest revision'], confidence: lesson.confidence, sourceEventIds: [sourceEventId] });
    const acknowledged = await service.ackDelivery({ version: 1, requestId: 'ack-stale', binding: 'reader', turnId: 'turn-stale', traceId: selected.traceId, lessonIds: [lesson.lessonId], lessonRevisions: [{ lessonId: lesson.lessonId, revision: lesson.revision }] });
    await cleanup();

    expect(acknowledged).toEqual({ outcome: 'invalid_ack' });
  });

  it('drops a selection withdrawn while the final binding check is pending', async () => {
    const { store, bindings, cleanup } = fixture(); await store.initialize();
    try {
      const sourceEventId = await seedSource(store);
      const repository = new LessonRepository(store.getDatabase());
      const lesson = await repository.upsert({ projectHash: 'project-a', name: 'Final policy fence', trigger: 'When final policy fencing is needed', steps: ['Check policy'], confidence: 1, sourceEventIds: [sourceEventId] });
      let calls = 0;
      const service = createLessonHostService({ db: store.getDatabase(), verifyBinding: async () => {
        if (++calls === 2) repository.setRecallEnabled({ lessonId: lesson.lessonId, projectHash: 'project-a', expectedRevision: lesson.revision, enabled: false });
        return bindings.get('reader')!;
      } });
      expect(await service.recall({ version: 1, requestId: 'final-policy', binding: 'reader', turnId: 'final-policy', query: 'final policy fencing' })).toMatchObject({ outcome: 'no_match', lessons: [] });
      expect(store.getDatabase().prepare('SELECT COUNT(*) AS count FROM lesson_host_traces').get()).toMatchObject({ count: 0 });
    } finally { await cleanup(); }
  });

  it('does not replay a direct body after policy becomes reference-only', async () => {
    vi.stubEnv(CANONICAL_MEMORY_PERMISSION_MODE_ENV, 'registered');
    const { store, service, cleanup } = fixture(); await store.initialize();
    try {
      const sourceEventId = await seedSource(store);
      const lesson = await new LessonRepository(store.getDatabase()).upsert({ projectHash: 'project-a', name: 'Reference fence', trigger: 'When reference fencing is needed', steps: ['Protected procedure'], confidence: 1, sourceEventIds: [sourceEventId] });
      const permissions = new MemoryAssetPermissionService(store.getDatabase());
      const binding = { projectHash: 'project-a', requesterActorId: 'actor-a', assetId: `lesson:${lesson.lessonId}`, actorId: 'actor-a' };
      await permissions.create({ projectHash: 'project-a', requesterActorId: 'actor-a', assetId: binding.assetId, assetType: 'lesson', title: lesson.name, sourceRefs: [binding.assetId] });
      await permissions.bind({ ...binding, injectionMode: 'direct' });
      const request = { version: 1, requestId: 'reference-fence', binding: 'reader', turnId: 'reference-turn', query: 'reference fencing' };
      expect(await service.recall(request)).toMatchObject({ outcome: 'selected' });
      const row = store.getDatabase().prepare('SELECT fingerprint FROM lesson_host_idempotency WHERE request_id=?').get(request.requestId) as { fingerprint: string };
      expect(row.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(row.fingerprint).not.toContain(request.query);
      await permissions.bind({ ...binding, injectionMode: 'reference' });
      expect(await service.recall(request)).toMatchObject({ outcome: 'no_match', lessons: [] });
    } finally { await cleanup(); }
  });

  it('does not replay the old body after an enabled lesson is edited', async () => {
    const { store, service, cleanup } = fixture(); await store.initialize();
    try {
      const sourceEventId = await seedSource(store);
      const repository = new LessonRepository(store.getDatabase());
      const payload = { projectHash: 'project-a', name: 'Revision fence', trigger: 'When revision fencing is needed', steps: ['Old procedure'], confidence: 1, sourceEventIds: [sourceEventId] };
      await repository.upsert(payload);
      const request = { version: 1, requestId: 'revision-fence', binding: 'reader', turnId: 'revision-turn', query: 'revision fencing' };
      expect(await service.recall(request)).toMatchObject({ outcome: 'selected' });
      await repository.upsert({ ...payload, steps: ['Replacement procedure'] });
      expect(await service.recall(request)).toMatchObject({ outcome: 'no_match', lessons: [] });
    } finally { await cleanup(); }
  });

  it('fails closed instead of replaying a recalled body after its lesson is withdrawn', async () => {
    const { store, service, cleanup } = fixture(); await store.initialize();
    const sourceEventId = await seedSource(store); const repository = new LessonRepository(store.getDatabase());
    const lesson = await repository.upsert({ projectHash: 'project-a', name: 'Replay fence', trigger: 'When replay needs fencing', steps: ['Check current policy'], confidence: 1, sourceEventIds: [sourceEventId] });
    const first = await service.recall({ version: 1, requestId: 'replay-fence', binding: 'reader', turnId: 'turn-fence', query: 'replay needs fencing' });
    await repository.setRecallEnabled({ lessonId: lesson.lessonId, projectHash: 'project-a', expectedRevision: lesson.revision, enabled: false });
    const replay = await service.recall({ version: 1, requestId: 'replay-fence', binding: 'reader', turnId: 'turn-fence', query: 'replay needs fencing' });
    await cleanup();
    expect(first).toMatchObject({ outcome: 'selected' });
    expect(replay).toEqual({ outcome: 'no_match', lessonIds: [], lessons: [] });
  });

  it('rejects a request id reused for a different host operation', async () => {
    const { store, service, cleanup } = fixture(); await store.initialize();
    const sourceEventId = await seedSource(store); const lesson = await new LessonRepository(store.getDatabase()).upsert({ projectHash: 'project-a', name: 'Intent fence', trigger: 'When request intent changes', steps: ['Reject collision'], confidence: 1, sourceEventIds: [sourceEventId] });
    await service.get({ version: 1, requestId: 'intent-collision', binding: 'reader', lessonId: lesson.lessonId });
    await expect(service.recordRead({ version: 1, requestId: 'intent-collision', binding: 'reader', lessonId: lesson.lessonId })).rejects.toThrow(/requestId payload conflict/);
    await cleanup();
  });

  it('returns read-only duplicate lesson suggestions in the persistent candidate snapshot', async () => {
    const { store, service, cleanup } = fixture();
    await store.initialize();
    const sourceEventId = await seedSource(store);
    const existing = await new LessonRepository(store.getDatabase()).upsert({ projectHash: 'project-a', name: 'Verify focused changes', trigger: 'When changing a focused service', steps: ['Keep existing body'], confidence: 0.9, sourceEventIds: [sourceEventId] });
    const payload = candidate(sourceEventId);
    const queued = await service.enqueueCandidate({ version: 1, requestId: 'duplicate-enqueue', binding: 'reviewer', evidenceKey: 'duplicate-evidence', payloadHash: hashLessonCandidatePayload(payload), generation: 3, candidate: payload });
    const snapshot = await service.reviewStatus({ version: 1, requestId: 'duplicate-status', binding: 'reviewer', candidateId: queued.candidateId });
    await cleanup();

    expect(queued.duplicateLessonIds).toEqual([existing.lessonId]);
    expect(snapshot).toMatchObject({ outcome: 'found', candidate: { duplicateLessonIds: [existing.lessonId] } });
  });

  it('rejects source-session mismatches and expires stale candidates before review writes', async () => {
    const { store, service, cleanup } = fixture();
    await store.initialize();
    const sourceEventId = await seedSource(store);
    const payload = candidate(sourceEventId);
    await expect(service.enqueueCandidate({ version: 1, requestId: 'session-mismatch', binding: 'reviewer', evidenceKey: 'session-mismatch', generation: 3, candidate: { ...payload, sourceSessionIds: ['forged-session'] } })).rejects.toThrow(/source session/i);
    const queued = await service.enqueueCandidate({ version: 1, requestId: 'expired-enqueue', binding: 'reviewer', evidenceKey: 'expired-evidence', generation: 3, expiresAt: '2026-01-01T00:00:00.000Z', candidate: payload });
    await expect(service.markReviewed({ version: 1, requestId: 'expired-review', binding: 'reviewer', candidateId: queued.candidateId, expectedRevision: queued.revision, payloadHash: queued.payloadHash, generation: 3 })).rejects.toThrow(/expired/i);
    const status = await service.reviewStatus({ version: 1, requestId: 'expired-status', binding: 'reviewer', candidateId: queued.candidateId });
    await cleanup();

    expect(status).toMatchObject({ outcome: 'found', candidate: { status: 'expired' } });
  });

  it('applies host exclusion to the native hook query after reopening the store', async () => {
    const { dir, store, service, cleanup } = fixture();
    await store.initialize();
    const sourceEventId = await seedSource(store);
    const lesson = await new LessonRepository(store.getDatabase()).upsert({
      projectHash: 'project-a', name: 'Restart exclusion', trigger: 'When restart exclusion is needed',
      steps: ['Preserve the exclusion'], confidence: 1, sourceEventIds: [sourceEventId],
    });
    const query = new MemoryQueryService(() => store.initialize(), store);
    expect((await query.listProjectLessonInjections('project-a', undefined)).map((item) => item.value.lessonId)).toEqual([lesson.lessonId]);
    await service.setRecallEnabled({ version: 1, requestId: 'native-exclude', binding: 'reviewer', lessonId: lesson.lessonId, expectedRevision: lesson.revision, enabled: false, generation: 3 });
    expect(await query.listProjectLessonInjections('project-a', undefined)).toEqual([]);
    await cleanup();

    const reopened = new SQLiteEventStore(join(dir, 'events.sqlite'));
    try {
      await reopened.initialize();
      const native = new MemoryQueryService(() => reopened.initialize(), reopened);
      expect(await native.listProjectLessonInjections('project-a', undefined)).toEqual([]);
      expect(new LessonRepository(reopened.getDatabase()).get(lesson.lessonId)).toMatchObject({ recallEnabled: false });
    } finally { await reopened.close(); }
  });

  it('fences registered asset withdrawal in both host and native lanes', async () => {
    vi.stubEnv(CANONICAL_MEMORY_PERMISSION_MODE_ENV, 'registered');
    const { store, service, cleanup } = fixture();
    await store.initialize();
    try {
      const sourceEventId = await seedSource(store);
      const lesson = await new LessonRepository(store.getDatabase()).upsert({
        projectHash: 'project-a', name: 'Withdrawal fence', trigger: 'When withdrawal fencing is needed',
        steps: ['Read current permission'], confidence: 1, sourceEventIds: [sourceEventId],
      });
      const permissions = new MemoryAssetPermissionService(store.getDatabase());
      const asset = { projectHash: 'project-a', requesterActorId: 'actor-a', assetId: `lesson:${lesson.lessonId}` };
      await permissions.create({ ...asset, assetType: 'lesson', title: lesson.name, sourceRefs: [asset.assetId] });
      await permissions.bind({ ...asset, actorId: 'actor-a', injectionMode: 'direct' });
      const native = new MemoryQueryService(() => store.initialize(), store);
      expect(await native.listProjectLessonInjections('project-a', 'actor-a')).toHaveLength(1);
      expect(await native.listProjectLessonInjections('project-a', 'actor-b')).toEqual([]);
      expect(await native.listProjectLessonInjections('project-b', 'actor-a')).toEqual([]);
      const request = { version: 1, requestId: 'withdrawal-native', binding: 'reader', turnId: 'withdrawal-turn', query: 'withdrawal fencing' };
      expect(await service.recall(request)).toMatchObject({ outcome: 'selected' });
      await permissions.update({ ...asset, status: 'archived' });
      expect(await native.listProjectLessonInjections('project-a', 'actor-a')).toEqual([]);
      expect(await service.recall(request)).toMatchObject({ outcome: 'no_match', lessons: [] });
    } finally { await cleanup(); }
  });

  it('keeps the 501st eligible lesson in the shared native injection scan', async () => {
    const { store, cleanup } = fixture();
    await store.initialize();
    const sourceEventId = await seedSource(store);
    const repository = new LessonRepository(store.getDatabase());
    for (let index = 0; index <= 500; index += 1) {
      await repository.upsert({ projectHash: 'project-a', name: `Lesson ${index}`, trigger: `When case ${index}`, steps: [`Verify case ${index}`], confidence: index === 500 ? 0 : 1, sourceEventIds: [sourceEventId] });
    }
    const query = new MemoryQueryService(() => store.initialize(), store);
    const injections = await query.listProjectLessonInjections('project-a', undefined, 500);
    await cleanup();

    expect(injections).toHaveLength(501);
    expect(injections.some((item) => item.value.name === 'Lesson 500')).toBe(true);
  });
});

it('advertises native lesson ownership support on the stable host entry', () => {
  expect((hostContract as Record<string, unknown>).LESSON_HOST_CAPABILITIES).toEqual({ version: 1, nativeLessonOwnerMarker: true });
});
