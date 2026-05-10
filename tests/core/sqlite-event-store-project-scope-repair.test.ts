import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { createSQLiteDatabase, sqliteClose, sqliteRun } from '../../src/core/sqlite-wrapper.js';
import type { MemoryEvent } from '../../src/core/types.js';
import { hashProjectPath } from '../../src/core/registry/project-path.js';

function tempDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-project-scope-repair-'));
  return { dir, dbPath: path.join(dir, 'events.sqlite') };
}

function event(
  id: string,
  content: string,
  metadata: Record<string, unknown>,
  sessionId = `session-${id}`
): MemoryEvent {
  return {
    id,
    eventType: 'user_prompt',
    sessionId,
    timestamp: new Date('2026-05-10T00:00:00.000Z'),
    content,
    canonicalKey: `canonical-${id}`,
    dedupeKey: `dedupe-${id}`,
    metadata
  };
}

function mutateDb(dbPath: string, statements: Array<{ sql: string; params?: unknown[] }>): void {
  const db = createSQLiteDatabase(dbPath, { walMode: false });
  try {
    for (const statement of statements) {
      sqliteRun(db, statement.sql, statement.params || []);
    }
  } finally {
    sqliteClose(db);
  }
}

describe('SQLiteEventStore legacy project-scope repair/quarantine', () => {
  it('repairs same-project legacy imports and quarantines mis-scoped/unscoped imported memories from default reads', async () => {
    const { dir, dbPath } = tempDb();
    const store = new SQLiteEventStore(dbPath);
    const projectPath = '/repo/claude-memory-layer';
    const otherProjectPath = '/repo/predictor';
    const projectHash = hashProjectPath(projectPath);

    try {
      await store.importEvents([
        event('same-project-legacy', 'CML dashboard memory-only diagnostic should remain searchable', {
          source: 'hermes',
          importedFrom: '/tmp/hermes-state.sqlite',
          projectPath
        }, 'session-current'),
        event('other-project-legacy', 'PREDICTOR_CONTAMINATION Streamlit betting workflow must not appear in CML search', {
          source: 'hermes',
          importedFrom: '/tmp/hermes-state.sqlite',
          projectPath: otherProjectPath
        }, 'session-other'),
        event('unscoped-legacy', 'ALPHA_TRADER_CONTAMINATION should be quarantined when project scope is missing', {
          source: 'hermes',
          importedFrom: '/tmp/hermes-state.sqlite'
        }, 'session-missing'),
        event('wrongly-scoped-legacy', 'PR merged at https://github.com/justinbuzzni/predictor/pull/1 should not appear in CML project memory', {
          source: 'hermes',
          importedFrom: '/tmp/hermes-state.sqlite',
          scope: { project: { hash: projectHash, path: projectPath } },
          tags: [`proj:${projectHash}`]
        }, 'session-wrongly-scoped'),
        event('wrong-path-no-content-hint', 'Generic legacy row with current hash but explicit foreign project path should not remain visible', {
          source: 'hermes',
          importedFrom: '/tmp/hermes-state.sqlite',
          projectPath: otherProjectPath,
          scope: { project: { hash: projectHash, path: projectPath } },
          tags: [`proj:${projectHash}`]
        }, 'session-wrong-path'),
        event('already-scoped', 'CML scoped retrieval replay remains visible', {
          scope: { project: { hash: projectHash, path: projectPath } },
          tags: [`proj:${projectHash}`]
        }, 'session-scoped'),
        event('repair-explanation', 'CML project-scope repair note: github.com/justinbuzzni/predictor is only a contamination example, not a predictor project task', {
          source: 'hermes',
          importedFrom: '/tmp/hermes-state.sqlite',
          scope: { project: { hash: projectHash, path: projectPath } },
          tags: [`proj:${projectHash}`]
        }, 'session-scoped')
      ]);

      const dryRun = await store.repairLegacyProjectScope({ projectPath, dryRun: true });
      expect(dryRun).toMatchObject({
        dryRun: true,
        scanned: 7,
        repaired: 1,
        quarantined: 4,
        alreadyScoped: 2
      });

      const apply = await store.repairLegacyProjectScope({ projectPath });
      expect(apply).toMatchObject({
        dryRun: false,
        scanned: 7,
        repaired: 1,
        quarantined: 4,
        alreadyScoped: 2
      });

      mutateDb(dbPath, [
        { sql: 'UPDATE events SET access_count = 99, turn_id = ? WHERE id = ?', params: ['turn-quarantined', 'other-project-legacy'] },
        { sql: 'UPDATE events SET access_count = 3, turn_id = ? WHERE id = ?', params: ['turn-active', 'same-project-legacy'] },
        { sql: 'INSERT INTO memory_helpfulness (id, event_id, session_id, retrieval_score, query_preview, helpfulness_score, measured_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))', params: ['help-quarantined', 'other-project-legacy', 'help-session', 1, 'quarantined query', 0.99] },
        { sql: 'INSERT INTO memory_helpfulness (id, event_id, session_id, retrieval_score, query_preview, helpfulness_score, measured_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))', params: ['help-active', 'same-project-legacy', 'help-session', 0.9, 'active query', 0.9] },
      ]);

      const mostAccessed = await store.getMostAccessed(5);
      expect(mostAccessed.map((e) => e.content).join('\n')).not.toContain('PREDICTOR_CONTAMINATION');
      expect(mostAccessed.map((e) => e.content)).toContain('CML dashboard memory-only diagnostic should remain searchable');

      const helpful = await store.getHelpfulMemories(5);
      expect(helpful.map((entry) => entry.summary).join('\n')).not.toContain('PREDICTOR_CONTAMINATION');
      expect(helpful.map((entry) => entry.eventId)).toContain('same-project-legacy');

      expect(await store.getSessionTurns('session-other')).toEqual([]);
      expect(await store.countSessionTurns('session-other')).toBe(0);
      expect(await store.countSessionTurns('session-other', { includeQuarantined: true })).toBe(1);

      const sameProject = await store.getSessionEvents('session-current');
      expect(sameProject[0].metadata).toMatchObject({
        scope: { project: { hash: projectHash } },
        repair: { legacyProjectScope: { action: 'repaired' } }
      });
      expect((sameProject[0].metadata?.tags as string[])).toContain(`proj:${projectHash}`);

      const otherProjectVisible = await store.getSessionEvents('session-other');
      expect(otherProjectVisible).toEqual([]);
      const otherProject = await store.getSessionEvents('session-other', { includeQuarantined: true });
      expect(otherProject[0].metadata).toMatchObject({
        quarantine: {
          status: 'active',
          category: 'project-scope',
          reason: 'project-path-mismatch'
        },
        repair: { legacyProjectScope: { action: 'quarantined' } }
      });

      const missingProject = await store.getSessionEvents('session-missing', { includeQuarantined: true });
      expect(missingProject[0].metadata).toMatchObject({
        quarantine: {
          status: 'active',
          category: 'project-scope',
          reason: 'missing-project-scope'
        }
      });

      const wronglyScoped = await store.getSessionEvents('session-wrongly-scoped', { includeQuarantined: true });
      expect(wronglyScoped[0].metadata).toMatchObject({
        quarantine: {
          status: 'active',
          category: 'project-scope',
          reason: 'content-project-mismatch'
        },
        repair: { legacyProjectScope: { action: 'quarantined' } }
      });

      const wrongPathNoContentHint = await store.getSessionEvents('session-wrong-path', { includeQuarantined: true });
      expect(wrongPathNoContentHint[0].metadata).toMatchObject({
        quarantine: {
          status: 'active',
          category: 'project-scope',
          reason: 'project-path-mismatch'
        },
        repair: { legacyProjectScope: { action: 'quarantined' } }
      });
      expect(await store.getSessionEvents('session-wrong-path')).toEqual([]);

      const contaminatedSearch = await store.keywordSearch('PREDICTOR_CONTAMINATION Streamlit', 10);
      expect(contaminatedSearch.map((r) => r.event.content)).toEqual([]);

      const wronglyScopedSearch = await store.keywordSearch('github.com justinbuzzni predictor', 10);
      expect(wronglyScopedSearch.map((r) => r.event.content)).toEqual([
        'CML project-scope repair note: github.com/justinbuzzni/predictor is only a contamination example, not a predictor project task'
      ]);

      const activeSearch = await store.keywordSearch('memory-only diagnostic', 10);
      expect(activeSearch.map((r) => r.event.content)).toContain('CML dashboard memory-only diagnostic should remain searchable');

      const recent = await store.getRecentEvents(10);
      expect(recent.map((e) => e.content).join('\n')).not.toContain('PREDICTOR_CONTAMINATION');
      expect(recent.map((e) => e.content).join('\n')).not.toContain('ALPHA_TRADER_CONTAMINATION');
      expect(await store.getEvent(otherProject[0].id)).toBeNull();
      expect(await store.getEvent(otherProject[0].id, { includeQuarantined: true })).not.toBeNull();
      expect(await store.countEvents()).toBe(3);
      expect(await store.countEvents({ includeQuarantined: true })).toBe(7);

      const levelStats = await store.getLevelStats();
      expect(levelStats).toContainEqual({ level: 'L0', count: 3 });

      const levelEvents = await store.getEventsByLevel('L0', { limit: 10 });
      const levelText = levelEvents.map((e) => e.content).join('\n');
      expect(levelText).toContain('CML dashboard memory-only diagnostic should remain searchable');
      expect(levelText).not.toContain('PREDICTOR_CONTAMINATION');
      expect(levelText).not.toContain('ALPHA_TRADER_CONTAMINATION');
      expect(levelText).not.toContain('Running PR review for github.com/justinbuzzni/predictor');
      expect(levelText).toContain('CML project-scope repair note: github.com/justinbuzzni/predictor is only a contamination example');
    } finally {
      await store.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not crash default reads when legacy metadata JSON is invalid', async () => {
    const { dir, dbPath } = tempDb();
    const store = new SQLiteEventStore(dbPath);

    try {
      await store.importEvents([
        event('invalid-metadata', 'Invalid metadata row should still be readable', { source: 'hermes' })
      ]);
      mutateDb(dbPath, [
        { sql: 'UPDATE events SET metadata = ? WHERE id = ?', params: ['{not-json', 'invalid-metadata'] }
      ]);

      await expect(store.getEvent('invalid-metadata')).resolves.toMatchObject({
        id: 'invalid-metadata',
        content: 'Invalid metadata row should still be readable'
      });
      await expect(store.getRecentEvents(5)).resolves.toHaveLength(1);
    } finally {
      await store.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects mismatched repair projectPath and projectHash at the store boundary', async () => {
    const { dir, dbPath } = tempDb();
    const store = new SQLiteEventStore(dbPath);

    try {
      await expect(store.repairLegacyProjectScope({
        projectPath: '/repo/claude-memory-layer',
        projectHash: hashProjectPath('/repo/predictor'),
        dryRun: true
      })).rejects.toThrow(/different project stores/);
    } finally {
      await store.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses session project path evidence to quarantine invalid legacy metadata JSON', async () => {
    const { dir, dbPath } = tempDb();
    const store = new SQLiteEventStore(dbPath);
    const projectPath = '/repo/claude-memory-layer';
    const otherProjectPath = '/repo/predictor';

    try {
      await store.importEvents([
        event('invalid-foreign-metadata', 'Invalid metadata from a foreign session should be quarantined', { source: 'hermes' }, 'session-invalid-foreign')
      ]);
      await store.upsertSession({
        id: 'session-invalid-foreign',
        startedAt: new Date('2026-05-10T00:00:00.000Z'),
        projectPath: otherProjectPath
      });
      mutateDb(dbPath, [
        { sql: 'UPDATE events SET metadata = ? WHERE id = ?', params: ['{not-json', 'invalid-foreign-metadata'] }
      ]);

      const dryRun = await store.repairLegacyProjectScope({ projectPath, dryRun: true });
      expect(dryRun).toMatchObject({ scanned: 1, repaired: 0, quarantined: 1, skipped: 0 });

      await store.repairLegacyProjectScope({ projectPath });
      expect(await store.getSessionEvents('session-invalid-foreign')).toEqual([]);
      const quarantined = await store.getSessionEvents('session-invalid-foreign', { includeQuarantined: true });
      expect(quarantined[0].metadata).toMatchObject({
        quarantine: { status: 'active', category: 'project-scope', reason: 'project-path-mismatch' },
        repair: { legacyProjectScope: { action: 'quarantined' } }
      });
    } finally {
      await store.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
