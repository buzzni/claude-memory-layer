import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { LessonRepository } from '../../src/core/operations/lesson-repository.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';
import {
  applyRunbookConsolidation,
  planRunbookConsolidation,
  revertRunbookConsolidation
} from '../../src/services/lesson-consolidation-service.js';

const tempDirs: string[] = [];
const stores: SQLiteEventStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cml-consolidate-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  stores.push(store);
  const db = store.getDatabase();
  const repo = new LessonRepository(db);
  const seed = (name: string, extra: Record<string, unknown> = {}) => repo.upsert({
    projectHash: 'project-a', name, trigger: `when ${name}`, steps: [`do ${name}`], confidence: 0.5,
    sourceSessionIds: [`session-${name}`], sourceEventIds: [`event-${name}`], failureModes: [], sourceClass: 'curated', ...extra
  });
  const a = await seed('rebase-before-push', { confidence: 0.8 });
  const b = await seed('push-rejected-retry');
  const c = await seed('unrelated-ui-rule');
  return { db, repo, a, b, c };
}

function draft(absorbs: Array<{ lessonId: string; revision: number }>, overrides: Record<string, unknown> = {}) {
  return {
    lessonId: 'rb-branch-1',
    name: 'prepare-and-push-pr-branch',
    trigger: "PR을 만들거나 갱신하려고 브랜치를 push할 때. 예: 'Commit & pr'",
    steps: ['git branch --show-current로 브랜치를 확인한다', 'origin/main 위로 rebase한 뒤 push한다'],
    failureModes: ['push 거절을 권한 문제로 오진하기'],
    validation: ['git rev-list --left-right --count origin/main...HEAD가 0 behind'],
    scope: '이 저장소의 브랜치·PR 작업',
    reconsiderWhen: '브랜치 정책이나 push 도구가 바뀔 때',
    absorbs,
    ...overrides
  };
}

describe('planRunbookConsolidation', () => {
  it('lists each runbook with the lessons it would switch off', async () => {
    const { db, a, b } = await fixture();
    const plan = planRunbookConsolidation(db, 'project-a', { runbooks: [draft([{ lessonId: a.lessonId, revision: 1 }, { lessonId: b.lessonId, revision: 1 }])] });
    expect(plan.problems).toEqual([]);
    expect(plan.runbooks).toEqual([{ draftId: 'rb-branch-1', name: 'prepare-and-push-pr-branch', absorbs: [
      { lessonId: a.lessonId, name: 'rebase-before-push', revision: 1 },
      { lessonId: b.lessonId, name: 'push-rejected-retry', revision: 1 }
    ] }]);
  });

  it('reports every state problem instead of stopping at the first', async () => {
    const { db, repo, a, b, c } = await fixture();
    repo.setRecallEnabled({ lessonId: c.lessonId, projectHash: 'project-a', expectedRevision: 1, enabled: false });
    const plan = planRunbookConsolidation(db, 'project-a', { runbooks: [
      draft([{ lessonId: a.lessonId, revision: 2 }, { lessonId: 'missing', revision: 1 }, { lessonId: c.lessonId, revision: 2 }]),
      draft([{ lessonId: b.lessonId, revision: 1 }, { lessonId: b.lessonId, revision: 1 }], { lessonId: 'rb-2', name: 'unrelated-ui-rule' }),
      draft([{ lessonId: a.lessonId, revision: 1 }], { lessonId: 'rb-3', name: 'prepare-and-push-pr-branch' })
    ] });
    expect(plan.problems).toEqual([
      `rb-branch-1: lesson ${a.lessonId} is at revision 1, not 2`,
      'rb-branch-1: lesson missing is not in this project',
      `rb-branch-1: lesson ${c.lessonId} is already switched off`,
      `rb-2: lesson ${b.lessonId} is absorbed more than once`,
      'rb-2: name unrelated-ui-rule is already a lesson',
      `rb-3: lesson ${a.lessonId} is absorbed more than once`,
      'rb-3: name prepare-and-push-pr-branch is used by another draft'
    ]);
  });

  it('refuses a malformed or unsafe runbook outright', async () => {
    const { db, a } = await fixture();
    const absorbs = [{ lessonId: a.lessonId, revision: 1 }];
    expect(() => planRunbookConsolidation(db, 'project-a', { runbooks: [draft(absorbs, { steps: Array.from({ length: 21 }, (_, i) => `step ${i}`) })] })).toThrow();
    expect(() => planRunbookConsolidation(db, 'project-a', { runbooks: [draft(absorbs, { steps: ['export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789'] })] })).toThrow(/credential/);
  });
});

describe('applyRunbookConsolidation', () => {
  it('adds the runbook and switches absorbed lessons off, pointing at it, with an audit trail', async () => {
    const { db, repo, a, b, c } = await fixture();
    const result = applyRunbookConsolidation(db, 'project-a', { runbooks: [draft([{ lessonId: a.lessonId, revision: 1 }, { lessonId: b.lessonId, revision: 1 }])] }, 'cml-cli');
    expect(result.runbooks).toHaveLength(1);
    const runbook = repo.get(result.runbooks[0].lessonId)!;
    expect(runbook).toMatchObject({ name: 'prepare-and-push-pr-branch', sourceClass: 'curated', recallEnabled: true, confidence: 0.8, scope: '이 저장소의 브랜치·PR 작업' });
    expect(runbook.absorbedInto).toBeUndefined();
    expect(runbook.sourceSessionIds).toEqual(['session-rebase-before-push', 'session-push-rejected-retry']);
    expect(runbook.sourceEventIds).toEqual(['event-rebase-before-push', 'event-push-rejected-retry']);
    for (const id of [a.lessonId, b.lessonId]) {
      expect(repo.get(id)).toMatchObject({ recallEnabled: false, absorbedInto: runbook.lessonId, revision: 2 });
    }
    expect(repo.get(c.lessonId)).toMatchObject({ recallEnabled: true, revision: 1 });
    expect(repo.get(c.lessonId)!.absorbedInto).toBeUndefined();
    const audits = sqliteAll<{ operation: string; target_id: string }>(db, `SELECT operation, target_id FROM memory_governance_audit WHERE operation IN ('lesson_promote', 'lesson_consolidate') AND actor = 'cml-cli' ORDER BY created_at`);
    expect(audits.map((row) => row.operation).sort()).toEqual(['lesson_consolidate', 'lesson_consolidate', 'lesson_promote']);
  });

  it('changes nothing when any runbook has a problem', async () => {
    const { db, repo, a, b } = await fixture();
    expect(() => applyRunbookConsolidation(db, 'project-a', { runbooks: [
      draft([{ lessonId: a.lessonId, revision: 1 }]),
      draft([{ lessonId: b.lessonId, revision: 9 }], { lessonId: 'rb-2', name: 'second-runbook' })
    ] }, 'cml-cli')).toThrow(/revision/);
    expect(repo.getByProjectAndName('project-a', 'prepare-and-push-pr-branch')).toBeNull();
    expect(repo.get(a.lessonId)).toMatchObject({ recallEnabled: true, revision: 1 });
  });
});

describe('revertRunbookConsolidation', () => {
  it('switches the absorbed lessons back on and the runbook off, and refuses a lesson that is not a runbook', async () => {
    const { db, repo, a, b } = await fixture();
    const [{ lessonId }] = applyRunbookConsolidation(db, 'project-a', { runbooks: [draft([{ lessonId: a.lessonId, revision: 1 }, { lessonId: b.lessonId, revision: 1 }])] }, 'cml-cli').runbooks;
    const result = revertRunbookConsolidation(db, 'project-a', lessonId, 'cml-cli');
    expect(result).toEqual({ runbookId: lessonId, restored: [a.lessonId, b.lessonId].sort() });
    for (const id of [a.lessonId, b.lessonId]) {
      expect(repo.get(id)).toMatchObject({ recallEnabled: true, revision: 3 });
      expect(repo.get(id)!.absorbedInto).toBeUndefined();
    }
    expect(repo.get(lessonId)).toMatchObject({ recallEnabled: false });
    expect(() => revertRunbookConsolidation(db, 'project-a', lessonId, 'cml-cli')).toThrow(/not a runbook/);
  });
});
