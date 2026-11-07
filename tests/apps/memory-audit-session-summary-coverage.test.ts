import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createSQLiteDatabase, sqliteClose, sqliteExec, sqliteRun, type SQLiteDatabase } from '../../src/core/sqlite-wrapper.js';
import { buildMemoryAuditReport, formatMemoryAuditMarkdown } from '../../src/apps/cli/memory-audit-report.js';

const STORE = 'aaaaaaaa';
const SINCE = new Date('2026-10-01T00:00:00.000Z');
const UNTIL = new Date('2026-10-02T00:00:00.000Z');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeDb(homeDir: string, withMetadata = true): SQLiteDatabase {
  const dir = path.join(homeDir, '.claude-code', 'memory', 'projects', STORE);
  mkdirSync(dir, { recursive: true });
  const db = createSQLiteDatabase(path.join(dir, 'events.sqlite'));
  sqliteExec(db, `CREATE TABLE events (
    id TEXT PRIMARY KEY, event_type TEXT NOT NULL, session_id TEXT NOT NULL,
    timestamp TEXT NOT NULL, content TEXT NOT NULL, canonical_key TEXT NOT NULL
    ${withMetadata ? ', metadata TEXT' : ''}
  )`);
  return db;
}

let seq = 0;
function event(db: SQLiteDatabase, session: string, type: string, timestamp: string, metadata?: unknown): void {
  const id = `e-${++seq}`;
  if (metadata === undefined) {
    sqliteRun(db, `INSERT INTO events (id, event_type, session_id, timestamp, content, canonical_key) VALUES (?, ?, ?, ?, 'c', ?)`,
      [id, type, session, timestamp, id]);
  } else {
    sqliteRun(db, `INSERT INTO events (id, event_type, session_id, timestamp, content, canonical_key, metadata) VALUES (?, ?, ?, ?, 'c', ?, ?)`,
      [id, type, session, timestamp, id, typeof metadata === 'string' ? metadata : JSON.stringify(metadata)]);
  }
}

function conversation(db: SQLiteDatabase, session: string, startedAt: string): void {
  event(db, session, 'user_prompt', startedAt);
  event(db, session, 'agent_response', startedAt);
  event(db, session, 'tool_observation', startedAt);
}

describe('audit session summary coverage', () => {
  it('counts eligible, summarized and LLM-generated sessions that started in the window', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-audit-summary-'));
    roots.push(homeDir);
    const db = makeDb(homeDir);
    const IN = '2026-10-01T12:00:00.000Z';

    conversation(db, 's-llm', IN);
    event(db, 's-llm', 'session_summary', '2026-10-01T13:00:00.000Z', { generated: 'llm', provider: 'claude' });
    conversation(db, 's-rule', IN);
    event(db, 's-rule', 'session_summary', '2026-10-01T14:00:00.000Z', { generated: 'rule-based' });
    conversation(db, 's-none', IN);
    // Three events but a single conversational one: below the eligibility floor.
    event(db, 's-thin', 'user_prompt', IN);
    event(db, 's-thin', 'tool_observation', IN);
    event(db, 's-thin', 'tool_observation', IN);
    event(db, 's-tiny', 'user_prompt', IN);
    event(db, 's-tiny', 'agent_response', IN);
    // The summary event must not pad a two-event session over the floor.
    event(db, 's-padded', 'user_prompt', IN);
    event(db, 's-padded', 'agent_response', IN);
    event(db, 's-padded', 'session_summary', '2026-10-01T15:00:00.000Z', '{broken');
    // Summary lands after the window closes: counted as summarized, not as latest.
    conversation(db, 's-late', '2026-10-01T23:00:00.000Z');
    event(db, 's-late', 'session_summary', '2026-10-02T03:00:00.000Z', { generated: 'llm' });
    // Started before the window; only its summary falls inside.
    conversation(db, 's-before', '2026-09-30T12:00:00.000Z');
    event(db, 's-before', 'session_summary', '2026-10-01T20:00:00.000Z', { generated: 'llm' });
    sqliteClose(db);

    const report = buildMemoryAuditReport({ homeDir, allProjects: true, since: SINCE, until: UNTIL });
    expect(report.stores[0].sessionSummaryCoverage).toEqual({
      sessionsStarted: 7,
      eligible: 4,
      withSummary: 4,
      llmGenerated: 2,
      latestSummaryAt: '2026-10-01T20:00:00.000Z'
    });

    const markdown = formatMemoryAuditMarkdown(report);
    expect(markdown).toContain('## Session summary coverage');
    expect(markdown).toContain('| Store | Sessions started | Eligible | With summary | LLM-generated | Latest summary |');
    expect(markdown).toContain('| aaaaaaaa | 7 | 4 | 4 | 2 | 2026-10-01T20:00:00.000Z |');
  });

  it('shows a dash for the latest summary when none is in the window and tolerates a store without metadata', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-audit-summary-'));
    roots.push(homeDir);
    const db = makeDb(homeDir, false);
    conversation(db, 's-1', '2026-10-01T12:00:00.000Z');
    event(db, 's-1', 'session_summary', '2026-10-01T13:00:00.000Z');
    sqliteClose(db);

    const report = buildMemoryAuditReport({ homeDir, allProjects: true, since: SINCE, until: UNTIL });
    expect(report.stores[0].sessionSummaryCoverage).toEqual({
      sessionsStarted: 1, eligible: 1, withSummary: 1, llmGenerated: 0, latestSummaryAt: '2026-10-01T13:00:00.000Z'
    });

    const none = buildMemoryAuditReport({ homeDir, allProjects: true, since: new Date('2026-11-01T00:00:00.000Z') });
    expect(none.stores[0].sessionSummaryCoverage).toMatchObject({ sessionsStarted: 0, latestSummaryAt: null });
    expect(formatMemoryAuditMarkdown(none)).toContain('| aaaaaaaa | 0 | 0 | 0 | 0 | - |');
  });
});
