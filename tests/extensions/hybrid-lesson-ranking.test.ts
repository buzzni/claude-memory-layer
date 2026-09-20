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
