import { afterEach, describe, expect, it } from 'vitest';
import { isSemanticRescueEligible, rankCuratedLessonsHybrid, warmHybridLessonCache } from '../../src/extensions/mcp/hybrid-lesson-ranking.js';

const lesson = { lessonId: 'l1', projectHash: 'p', name: 'Rollback release', trigger: 'When deployment fails', steps: ['restore'], confidence: 1, sourceSessionIds: [], sourceEventIds: [], failureModes: [], skillCandidate: false, sourceClass: 'curated' as const, revision: 1, recallEnabled: true, scope: '', validation: [], reconsiderWhen: '', validVersions: [], createdAt: new Date(), updatedAt: new Date() };
const previousExperiment = process.env.CLAUDE_MEMORY_LESSON_HYBRID_EXPERIMENT;
afterEach(() => { if (previousExperiment === undefined) delete process.env.CLAUDE_MEMORY_LESSON_HYBRID_EXPERIMENT; else process.env.CLAUDE_MEMORY_LESSON_HYBRID_EXPERIMENT = previousExperiment; });
describe('hybrid lesson rescue', () => {
  it('keeps lexical results and refuses general negated intent', async () => {
    expect(isSemanticRescueEligible('do not revert the release')).toBe(false);
    expect(await rankCuratedLessonsHybrid([lesson], 'rollback release', 3)).toEqual([lesson]);
  });
  it('allows safety requirements and failure states but rejects procedure contraindications', () => {
    expect(isSemanticRescueEligible('validateUploadMime must not trust a client-declared upload MIME type.')).toBe(true);
    expect(isSemanticRescueEligible('업로드 MIME header만 믿지 말고 서버에서 실제 파일 signature와 정책을 확인한다.')).toBe(true);
    expect(isSemanticRescueEligible('The server does not start after the configuration change.')).toBe(true);
    expect(isSemanticRescueEligible('The SERVER DOES NOT START after the configuration change.')).toBe(true);
    expect(isSemanticRescueEligible('Do not use validateUploadMime for this endpoint.')).toBe(false);
    expect(isSemanticRescueEligible('You MUST NOT APPLY, run, or invoke validateUploadMime here.')).toBe(false);
    expect(isSemanticRescueEligible('validateUploadMime를 적용하지 마라.')).toBe(false);
    expect(isSemanticRescueEligible('validateUploadMime를 사용하지 말고 별도 처리한다.')).toBe(false);
    expect(isSemanticRescueEligible('Continue WITHOUT retryWithJitter and IGNORE retry handling.')).toBe(false);
    expect(isSemanticRescueEligible('We are not using rollback here.')).toBe(false);
    expect(isSemanticRescueEligible('A valid lease is not rejected when the clock skew is within bounds.')).toBe(false);
    expect(isSemanticRescueEligible('You must not delete this migration.')).toBe(false);
    expect(isSemanticRescueEligible('24시간을 더하지 말고 timezone의 calendar date로 계산한다.')).toBe(false);
    expect(isSemanticRescueEligible('validateUploadMime를 적용하지 않는다.')).toBe(false);
    expect(isSemanticRescueEligible('retryWithJitter를 실행하지 않음.')).toBe(false);
    expect(isSemanticRescueEligible('do-not run retryWithJitter here.')).toBe(false);
    expect(isSemanticRescueEligible('이 작업은 금지되어 있다.')).toBe(false);
    expect(isSemanticRescueEligible('이 단계를 건너뛰어도 된다.')).toBe(false);
    expect(isSemanticRescueEligible('검증 결과를 무시한다.')).toBe(false);
    expect(isSemanticRescueEligible('The server does not start; skip rollback.')).toBe(false);
    expect(isSemanticRescueEligible('Must not trust client input; do-not run the migration.')).toBe(false);
  });
  it('rescues an unambiguous safety query from a warm cache but abstains for a mixed contraindication', async () => {
    process.env.CLAUDE_MEMORY_LESSON_HYBRID_EXPERIMENT = 'true';
    const embedder = { getModelName: () => 'fixture/model-safety-guard', initialize: async () => undefined, embed: async () => ({ vector: [1, 0] }) } as never;
    await warmHybridLessonCache([lesson], embedder);
    expect(await rankCuratedLessonsHybrid([lesson], 'Must not trust client input.', 1, embedder)).toEqual([lesson]);
    expect(await rankCuratedLessonsHybrid([lesson], 'Must not trust client input; do-not run the migration.', 1, embedder)).toEqual([]);
  });
  it('does not initialize an embedder for an empty pool', async () => {
    const embedder = { getModelName: () => 'fixture/model', initialize: async () => { throw new Error('must not initialize'); }, embed: async () => ({ vector: [1, 0] }) } as never;
    await expect(rankCuratedLessonsHybrid([], 'semantic query', 3, embedder)).resolves.toEqual([]);
  });
  it('uses only a background-built cache for semantic rescue', async () => {
    process.env.CLAUDE_MEMORY_LESSON_HYBRID_EXPERIMENT = 'true';
    const embedder = { getModelName: () => 'fixture/model', initialize: async () => undefined, embed: async (value: string) => ({ vector: value.includes('Rollback') ? [1, 0] : [1, 0] }) } as never;
    expect(await rankCuratedLessonsHybrid([lesson], 'undo a release', 1, embedder)).toEqual([]);
    await warmHybridLessonCache([lesson], embedder);
    expect(await rankCuratedLessonsHybrid([lesson], 'undo a release', 1, embedder)).toEqual([lesson]);
  });
  it('queues another project and a new revision while warming, then only selects from complete snapshots', async () => {
    process.env.CLAUDE_MEMORY_LESSON_HYBRID_EXPERIMENT = 'true';
    let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
    const embedder = { getModelName: () => 'fixture/model-queue', initialize: async () => undefined, embed: async () => { await hold; return { vector: [1, 0] }; } } as never;
    const other = { ...lesson, projectHash: 'other', lessonId: 'l10' };
    const revision = { ...lesson, revision: 2 };
    const first = warmHybridLessonCache([lesson], embedder);
    const second = warmHybridLessonCache([other, revision], embedder);
    expect(await rankCuratedLessonsHybrid([lesson, revision], 'unseen semantic text', 1, embedder)).toEqual([]);
    release(); await Promise.all([first, second]);
    expect(await rankCuratedLessonsHybrid([other], 'unseen semantic text', 1, embedder)).toEqual([other]);
    expect(await rankCuratedLessonsHybrid([revision], 'unseen semantic text', 1, embedder)).toEqual([revision]);
  });
});
