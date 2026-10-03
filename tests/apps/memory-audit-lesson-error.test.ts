import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { buildMemoryAuditReport, formatMemoryAuditMarkdown } from '../../src/apps/cli/memory-audit-report.js';

// An unexpected failure inside the lesson/prompt aggregates must be reported as
// an enum, distinct from an unsupported schema, without the raw error text.
vi.mock('../../src/core/lesson-usage-audit.js', () => ({
  auditLessonUsage: () => {
    throw new Error('boom /private/secret-path details');
  }
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('memory audit lesson section failure', () => {
  it('reports lessonAuditError without raw error text and keeps the rest of the store report', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-audit-lesson-error-'));
    roots.push(homeDir);
    const dir = path.join(homeDir, '.claude-code', 'memory', 'projects', 'aaaaaaaa');
    mkdirSync(dir, { recursive: true });
    const store = new SQLiteEventStore(path.join(dir, 'events.sqlite'));
    await store.initialize();
    await store.append({ eventType: 'user_prompt', sessionId: 's', timestamp: new Date(), content: 'a stored prompt' });
    await store.close();

    const report = buildMemoryAuditReport({ homeDir, allProjects: true });
    const entry = report.stores[0];
    expect(entry.state).toBe('read');
    expect(entry.events.total).toBe(1);
    expect(entry).toMatchObject({ promptQuality: null, lessonUsage: null, lessonQuality: null, lessonAuditError: 'computation_failed' });
    const output = JSON.stringify(report) + formatMemoryAuditMarkdown(report);
    expect(output).toContain('error: computation_failed');
    expect(output).not.toContain('boom');
    expect(output).not.toContain('/private/secret-path');
  });
});
