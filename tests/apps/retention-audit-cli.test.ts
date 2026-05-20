import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  formatRetentionAuditReport,
  resolveRetentionAuditOptions
} from '../../src/apps/cli/retention-audit-command.js';
import { FacetRepository } from '../../src/core/operations/facet-repository.js';
import { hashProjectPath } from '../../src/core/registry/project-path.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

describe('retention audit CLI helpers', () => {
  it('defaults to dry-run audit using the current project path', () => {
    const resolved = resolveRetentionAuditOptions({ project: '/repo/app' });

    expect(resolved).toEqual({
      projectPath: '/repo/app',
      projectHash: undefined,
      dryRun: true,
      limit: 100,
      json: false
    });
  });

  it('rejects non-dry-run invocation because retention audit must not mutate data', () => {
    expect(() => resolveRetentionAuditOptions({ project: '/repo/app', dryRun: false })).toThrow(/dry-run only/);
  });

  it('formats JSON reports with decision counts, policy version, and redacted samples only', () => {
    const output = formatRetentionAuditReport({
      dryRun: true,
      projectHash: 'abc12345',
      policyVersion: 'v1',
      scanned: 1,
      limit: 100,
      decisions: {
        keep: 0,
        review: 0,
        downgrade: 0,
        quarantine: 0,
        tombstone_candidate: 1
      },
      wouldChange: 1,
      samples: [{
        targetType: 'event',
        targetId: 'event-1',
        eventType: 'tool_observation',
        decision: 'tombstone_candidate',
        lifecycleScore: 0.05,
        policyVersion: 'v1',
        dryRunAction: 'mark_tombstone_candidate',
        reasonCodes: ['manual_retention_discard'],
        redactedPreview: '[REDACTED]'
      }]
    }, { json: true });

    const parsed = JSON.parse(output);
    expect(parsed.projectHash).toBe('abc12345');
    expect(parsed.decisions.tombstone_candidate).toBe(1);
    expect(parsed.samples[0].redactedPreview).toBe('[REDACTED]');
    expect(output).not.toContain('/repo/app');
    expect(output).not.toContain('super-secret');
  });
});

describe('retention audit CLI command', () => {
  it('runs a non-destructive JSON audit over project-scoped memories with redacted samples', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cml-retention-audit-home-'));
    const projectDir = '/opt/cml-retention-audit-project-fixture';
    const projectHash = hashProjectPath(projectDir);
    const storagePath = path.join(home, '.claude-code', 'memory', 'projects', projectHash);
    const dbPath = path.join(storagePath, 'events.sqlite');

    try {
      mkdirSync(storagePath, { recursive: true });
      const store = new SQLiteEventStore(dbPath, { markdownMirrorRoot: storagePath });
      await store.initialize();
      const event = await store.append({
        eventType: 'tool_observation',
        sessionId: 'session-retention-audit',
        timestamp: new Date('2024-01-01T00:00:00.000Z'),
        content: `temporary debug output password=dk at ${projectDir}`,
        metadata: {
          scope: { project: { hash: projectHash, path: projectDir } }
        }
      });
      if (event.success !== true) throw new Error('append failed');
      const facetRepo = new FacetRepository(store.getDatabase());
      await facetRepo.assign({
        targetType: 'event',
        targetId: event.eventId,
        dimension: 'retention',
        value: 'discard',
        source: 'manual',
        projectHash,
        evidenceEventIds: [event.eventId]
      });
      await store.close();

      const result = spawnSync('npx', [
        'tsx',
        'src/apps/cli/index.ts',
        'retention',
        'audit',
        '--project',
        projectDir,
        '--dry-run',
        '--limit',
        '10',
        '--json'
      ], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: 'utf8'
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.projectHash).toBe(projectHash);
      expect(parsed.policyVersion).toBe('v1');
      expect(parsed.scanned).toBe(1);
      expect(parsed.decisions.tombstone_candidate).toBe(1);
      expect(parsed.wouldChange).toBe(1);
      expect(parsed.samples).toHaveLength(1);
      expect(parsed.samples[0].targetId).toBe(event.eventId);
      expect(parsed.samples[0].decision).toBe('tombstone_candidate');
      expect(parsed.samples[0].reasonCodes).toContain('manual_retention_discard');
      expect(parsed.samples[0].redactedPreview).toContain('[REDACTED]');
      expect(result.stdout).not.toContain('password=dk');
      expect(result.stdout).not.toContain(projectDir);

      const db = new Database(dbPath);
      const retentionRows = db.prepare('SELECT COUNT(*) AS count FROM memory_retention_scores').get() as { count: number };
      const retentionAudits = db.prepare("SELECT COUNT(*) AS count FROM memory_governance_audit WHERE operation = 'retention_score'").get() as { count: number };
      db.close();
      expect(retentionRows.count).toBe(0);
      expect(retentionAudits.count).toBe(0);
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
