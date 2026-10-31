import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const tempDirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-provenance-wiring-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(command: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
}

function expectNoPaths(text: string, ...paths: string[]) {
  for (const value of [homedir(), ROOT, ...paths]) expect(text).not.toContain(value);
}

describe('replay-retrieval-benchmark provenance', () => {
  const writeFixture = () => {
    const fixturePath = path.join(tempDir(), 'fixture.json');
    writeFileSync(fixturePath, `${JSON.stringify({
      name: 'provenance-fixture',
      ks: [1, 3],
      metadata: { rawContentIncluded: false },
      queries: [{ queryId: 'q1', query: 'provenance marker', expectedIds: ['m1'], expectedRelevance: { m1: 1 } }],
      memories: [{ id: 'm1', content: 'provenance marker memory' }, { id: 'm2', content: 'unrelated note' }]
    }, null, 2)}\n`);
    return fixturePath;
  };

  it('adds a provenance block to the JSON report without touching the existing fields', () => {
    const fixturePath = writeFixture();
    const result = run('npx', ['tsx', 'scripts/replay-retrieval-benchmark.ts', '--fixture', fixturePath, '--format', 'json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);

    expect(report.summary).toBeDefined();
    expect(report.provenance).toMatchObject({
      gitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      generatedAt: report.generatedAt,
      fixtures: [{ ref: expect.stringMatching(/^outside-repo:/), sha256: sha256(readFileSync(fixturePath)), split: null, manifest: 'unregistered' }],
      retrieval: { topK: 3, candidatePool: 2, saturated: true }
    });
    expect(report.provenance.flags).toMatchObject({ includePerQuery: true });
    expectNoPaths(JSON.stringify(report.provenance), path.dirname(fixturePath));
    expect(result.stderr).toContain('saturated');
  });

  it('adds provenance header lines under the markdown title', () => {
    const result = run('npx', ['tsx', 'scripts/replay-retrieval-benchmark.ts', '--fixture', writeFixture(), '--format', 'markdown', '--top-k', '1']);
    expect(result.status).toBe(0);
    const lines = result.stdout.split('\n');

    expect(lines[0]).toBe('# Retrieval Replay Benchmark Report');
    expect(lines[2]).toMatch(/^- Provenance: git [0-9a-f]{12}/);
    expect(result.stdout).toContain('- Top-k 3 / candidate pool 2 — saturated');
    expect(result.stdout).toContain('- Fixture: provenance-fixture');
  });
});

describe('replay-hook-grounding provenance', () => {
  it('records the fixture hash and unchanged store row counts', () => {
    const fixture = 'benchmarks/replay/hook-grounding-fixture-v1.json';
    const result = run('npx', ['tsx', 'scripts/replay-hook-grounding.ts', '--fixture', fixture, '--format', 'json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);

    expect(report.turns).toBe(8);
    expect(report.provenance.fixtures).toEqual([expect.objectContaining({ ref: fixture, sha256: sha256(readFileSync(fixture)) })]);
    expect(report.provenance.store).toMatchObject({ inputRows: 8, corpusChanged: false });
    expect(report.provenance.store.rowsAtStart).toEqual(report.provenance.store.rowsAtEnd);
    expect(report.provenance.store.window.from <= report.provenance.store.window.to).toBe(true);
    expect(Object.keys(report.provenance.store.rowsAtStart)).toEqual(['events', 'retrieval_traces', 'memory_lessons']);
    const projectHash = JSON.parse(readFileSync(fixture, 'utf8')).projectHash;
    expect(report.provenance.flags).toEqual({ semantic: 'off', projectHash: sha256(Buffer.from(projectHash)).slice(0, 16) });
    expect(JSON.stringify(report.provenance)).not.toContain(projectHash);
    expectNoPaths(JSON.stringify(report.provenance), tmpdir());
  });
});

describe('measure-injection-grounding provenance', () => {
  it('prints provenance header lines with store row counts and no store path', () => {
    const root = tempDir();
    mkdirSync(path.join(root, 'abc123'));
    const db = new Database(path.join(root, 'abc123', 'events.sqlite'));
    db.exec(`CREATE TABLE memory_helpfulness (source TEXT, content_overlap_score REAL, created_at TEXT);
      INSERT INTO memory_helpfulness VALUES ('session_start', 0.2, '2026-10-01'), ('session_start', NULL, '2026-10-02')`);
    db.close();

    const result = run('node', ['scripts/measure-injection-grounding.mjs', '--since', '2026-09-01'], { CLAUDE_MEMORY_PROJECTS_ROOT: root });
    const header = result.stdout.split('\n\n')[0];

    expect(header).toMatch(/^- Provenance: git [0-9a-f]{12}/);
    expect(header).toContain('- Store rows: start {"stores":1,"memory_helpfulness":2,"scored":1}, end {"stores":1,"memory_helpfulness":2,"scored":1}, input rows {"before 2026-09-01":0,"since 2026-09-01":1}');
    expect(header).not.toContain('corpus changed');
    expect(result.stdout).toContain('session_start');
    expectNoPaths(header, root, 'abc123');
  });
});
