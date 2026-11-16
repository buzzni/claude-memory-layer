import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { buildMemoryAuditReport, formatMemoryAuditMarkdown } from '../../src/apps/cli/memory-audit-report.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function seedStore(homeDir: string, storeHash: string, skips: number): Promise<void> {
  const dir = path.join(homeDir, '.claude-code', 'memory', 'projects', storeHash);
  mkdirSync(dir, { recursive: true });
  const store = new SQLiteEventStore(path.join(dir, 'events.sqlite'));
  await store.initialize();
  for (let i = 0; i < skips; i++) await store.recordCaptureSkipped('private-session-id', 'subagent');
  await store.close();
}

describe('memory audit: hook inputs the capture policy kept out', () => {
  it('counts skips per reason code and prints no session ids', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-audit-capture-'));
    roots.push(homeDir);
    await seedStore(homeDir, 'aaaaaaaa', 3);
    await seedStore(homeDir, 'bbbbbbbb', 0);

    const report = buildMemoryAuditReport({ homeDir, allProjects: true });
    const skippedOf = (hash: string) => report.stores.find((store) => store.storeHash === hash)?.captureSkipped;

    expect(skippedOf('aaaaaaaa')).toEqual([{ reason: 'subagent', count: 3 }]);
    expect(skippedOf('bbbbbbbb')).toEqual([]);
    const markdown = formatMemoryAuditMarkdown(report);
    expect(markdown).toContain('## Not stored by the capture policy');
    expect(markdown).toContain('| aaaaaaaa | subagent | 3 |');
    expect(markdown).not.toContain('| bbbbbbbb | subagent');
    expect(markdown).not.toContain('private-session-id');
  });

  it('prints no section when nothing was skipped', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-audit-capture-'));
    roots.push(homeDir);
    await seedStore(homeDir, 'aaaaaaaa', 0);

    const markdown = formatMemoryAuditMarkdown(buildMemoryAuditReport({ homeDir, allProjects: true }));
    expect(markdown).not.toContain('## Not stored by the capture policy');
  });
});
