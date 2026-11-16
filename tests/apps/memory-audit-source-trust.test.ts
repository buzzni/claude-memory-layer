import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import type { RetrievalOutcomeDiagnostics, RetrievalTriggerType } from '../../src/core/retrieval-telemetry.js';
import { buildMemoryAuditReport, formatMemoryAuditMarkdown } from '../../src/apps/cli/memory-audit-report.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function diagnostics(injectedByOrigin?: RetrievalOutcomeDiagnostics['injectedByOrigin']): RetrievalOutcomeDiagnostics {
  return {
    outcomeReason: 'selected',
    laneCandidateCounts: {},
    filteredCounts: {},
    topScore: null,
    threshold: 0,
    freshnessState: 'unknown',
    ...(injectedByOrigin ? { injectedByOrigin } : {})
  };
}

async function seedStore(homeDir: string, storeHash: string): Promise<void> {
  const dir = path.join(homeDir, '.claude-code', 'memory', 'projects', storeHash);
  mkdirSync(dir, { recursive: true });
  const store = new SQLiteEventStore(path.join(dir, 'events.sqlite'));
  await store.initialize();
  const traces: Array<[string, RetrievalTriggerType, RetrievalOutcomeDiagnostics]> = [
    ['prompt-1', 'user_prompt', diagnostics({ assistant: 2, tool: 1 })],
    ['prompt-2', 'user_prompt', diagnostics({ imported: 1, tool: 1 })],
    ['recap', 'session_start', diagnostics({ assistant: 1, imported: 2 })],
    // Requested reads are not injection; a pre-origin hook trace has no counts.
    ['search', 'explicit_search', diagnostics({ tool: 5 })],
    ['legacy-prompt', 'user_prompt', diagnostics()]
  ];
  for (const [traceId, triggerType, outcomeDiagnostics] of traces) {
    await store.recordRetrievalTrace({
      traceId,
      sessionId: 'private-session-id',
      queryText: 'private query text',
      candidateEventIds: ['e1'],
      selectedEventIds: ['e1'],
      triggerType,
      outcomeDiagnostics
    });
  }
  await store.close();
}

describe('memory audit: hook-injected memories by origin', () => {
  it('sums hook traces per origin class and prints no ids or text', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-audit-origin-'));
    roots.push(homeDir);
    await seedStore(homeDir, 'aaaaaaaa');

    const report = buildMemoryAuditReport({ homeDir, allProjects: true });
    const store = report.stores.find((candidate) => candidate.storeHash === 'aaaaaaaa');

    expect(store?.injectedByOrigin).toEqual({
      traces: 3,
      counts: { user: 0, assistant: 3, derived: 0, imported: 3, tool: 2, unknown: 0 }
    });
    const markdown = formatMemoryAuditMarkdown(report);
    expect(markdown).toContain('## Hook-injected memories by origin');
    expect(markdown).toContain('| aaaaaaaa | 3 | 0 | 3 | 0 | 3 | 2 | 0 |');
    expect(markdown).not.toContain('private-session-id');
    expect(markdown).not.toContain('private query text');
  });
});
