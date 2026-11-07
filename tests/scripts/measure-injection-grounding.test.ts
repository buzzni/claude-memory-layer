import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * One store where r1 is an answer that reused an injected lesson (m0), r3 was
 * answered inside the session it is later injected into, and r2 is neither.
 */
function writeStore(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-grounding-origin-'));
  tempDirs.push(root);
  mkdirSync(path.join(root, 'abc123'));
  const db = new Database(path.join(root, 'abc123', 'events.sqlite'));
  db.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, session_id TEXT);
    INSERT INTO events VALUES ('r1', 's0'), ('r2', 's0'), ('r3', 's2');
    CREATE TABLE memory_helpfulness (
      event_id TEXT, session_id TEXT, source TEXT, content_overlap_score REAL,
      evidence_json TEXT, created_at TEXT
    );
  `);
  const insert = db.prepare('INSERT INTO memory_helpfulness VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('m0', 's0', 'user_prompt', 0.4, JSON.stringify([{ responseEventId: 'r1', similarity: 0.9 }]), '2026-10-01');
  insert.run('r1', 's5', 'user_prompt', 0.5, null, '2026-10-02');
  insert.run('r2', 's5', 'user_prompt', 0.1, null, '2026-10-02');
  insert.run('r3', 's2', 'user_prompt', 0.3, null, '2026-10-02');
  // r1 back in its own session: same-session takes precedence over derived.
  insert.run('r1', 's0', 'user_prompt', 0.1, null, '2026-10-03');
  db.close();
  return root;
}

function run(root: string, ...args: string[]) {
  return spawnSync('node', ['scripts/measure-injection-grounding.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_MEMORY_PROJECTS_ROOT: root }
  });
}

describe('measure-injection-grounding --by-origin', () => {
  it('splits each window by where the injected memory came from', () => {
    const result = run(writeStore(), '--by-origin');

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/all time\s+avg 0\.2800\s+grounded 100\.0%\s+n=5/);
    expect(result.stdout).toMatch(/same-session\s+avg 0\.2000\s+n=2\s+\(40\.0% of rows, 28\.6% of overlap\)/);
    expect(result.stdout).toMatch(/derived\s+avg 0\.5000\s+n=1\s+\(20\.0% of rows, 35\.7% of overlap\)/);
    expect(result.stdout).toMatch(/cross-session\s+avg 0\.2500\s+n=2\s+\(40\.0% of rows, 35\.7% of overlap\)/);
  });

  it('keeps the default report free of the split', () => {
    const result = run(writeStore());

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/all time\s+avg 0\.2800/);
    expect(result.stdout).not.toContain('same-session');
  });
});
