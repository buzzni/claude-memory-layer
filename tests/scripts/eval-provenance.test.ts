import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildProvenance,
  corpusChanged,
  countRows,
  describeFixture,
  formatProvenanceLines,
  pathRef,
  pickEnv,
  sanitizeSettings,
  topKSaturation,
  withProvenanceHeader
} from '../../scripts/eval-provenance.mjs';

const ROOT = process.cwd();
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const tempDirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-provenance-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('buildProvenance', () => {
  it('records git state, package version, generation time, fixtures, flags and env', () => {
    const fixture = path.join(ROOT, 'benchmarks/lesson-recall/calibration-v1.json');
    const provenance = buildProvenance({
      generatedAt: '2026-11-01T00:00:00.000Z',
      fixtures: [fixture],
      flags: { topK: 3, fixture },
      env: { CLAUDE_MEMORY_SEARCH: 'hybrid' }
    });

    expect(provenance.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof provenance.gitDirty).toBe('boolean');
    expect(provenance.packageVersion).toBe(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
    expect(provenance.generatedAt).toBe('2026-11-01T00:00:00.000Z');
    expect(provenance.fixtures).toEqual([{
      ref: 'benchmarks/lesson-recall/calibration-v1.json',
      sha256: sha256(readFileSync(fixture)),
      split: 'dev',
      manifest: 'match'
    }]);
    expect(provenance.flags).toEqual({ topK: 3, fixture: 'benchmarks/lesson-recall/calibration-v1.json' });
    expect(provenance.env).toEqual({ CLAUDE_MEMORY_SEARCH: 'hybrid' });
    expect(provenance.warnings).toEqual([]);
  });

  it('flags corpusChanged and saturation in warnings', () => {
    const provenance = buildProvenance({
      store: { rowsAtStart: { events: 3 }, rowsAtEnd: { events: 4 }, inputRows: 3, window: { from: 'a', to: 'b' } },
      retrieval: { topK: 5, candidatePool: 5 }
    });
    expect(provenance.store).toMatchObject({ corpusChanged: true, inputRows: 3, window: { from: 'a', to: 'b' } });
    expect(provenance.retrieval).toEqual({ topK: 5, candidatePool: 5, saturated: true });
    expect(provenance.warnings).toHaveLength(2);
    expect(provenance.warnings.join('\n')).toMatch(/corpus changed/);
    expect(provenance.warnings.join('\n')).toMatch(/saturated/);
  });
});

describe('describeFixture', () => {
  it('reports a registered fixture whose bytes no longer match splits.json as a mismatch', () => {
    const dir = tempDir();
    const edited = path.join(dir, 'calibration-v1.json');
    writeFileSync(edited, '{"edited":true}\n');
    expect(describeFixture(edited)).toMatchObject({ split: null, manifest: 'mismatch' });
  });

  it('reports a fixture splits.json does not list as unregistered', () => {
    const dir = tempDir();
    const other = path.join(dir, 'other.json');
    writeFileSync(other, '{}\n');
    expect(describeFixture(other)).toMatchObject({ split: null, manifest: 'unregistered' });
  });
});

describe('path exposure', () => {
  it('keeps repository paths relative and hashes anything outside the repository', () => {
    expect(pathRef(path.join(ROOT, 'scripts/eval-split.ts'))).toBe('scripts/eval-split.ts');
    const outside = pathRef(path.join(homedir(), 'secret-project', 'events.sqlite'));
    expect(outside).toMatch(/^outside-repo:[0-9a-f]{16}$/);
  });

  it('never writes an absolute or home path into the provenance block', () => {
    const dir = tempDir();
    const fixture = path.join(dir, 'fixture.json');
    writeFileSync(fixture, '{}\n');
    const home = homedir();
    const provenance = buildProvenance({
      fixtures: [fixture],
      store: { ref: path.join(home, '.claude-code/memory/projects/abc'), rowsAtStart: { events: 1 }, rowsAtEnd: { events: 1 } },
      flags: { store: `${home}/.claude-code/memory/projects/abc`, out: '~/report.json', cwdRelative: 'out/report.json', nested: [dir] },
      env: { CLAUDE_MEMORY_PROJECTS_ROOT: path.join(home, '.claude-code/memory/projects') }
    });
    const serialized = JSON.stringify(provenance);

    expect(serialized).not.toContain(home);
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain(ROOT);
    expect(serialized).not.toContain('~/');
    expect(provenance.flags.cwdRelative).toBe('out/report.json');
  });

  it('resolves a relative store location before deciding it is inside the repository', () => {
    const provenance = buildProvenance({ store: { ref: '../private-copy/events.sqlite', rowsAtStart: {}, rowsAtEnd: {} } });
    expect(provenance.store.ref).toMatch(/^outside-repo:[0-9a-f]{16}$/);
  });

  it('sanitizes settings recursively', () => {
    expect(sanitizeSettings({ a: { b: ['/abs/path', 'plain'] }, n: 1, off: undefined })).toEqual({
      a: { b: [expect.stringMatching(/^outside-repo:/), 'plain'] },
      n: 1
    });
  });
});

describe('pickEnv', () => {
  it('keeps memory flags, redacts credentials and drops unrelated variables', () => {
    expect(pickEnv({
      CLAUDE_MEMORY_SEARCH: 'hybrid',
      MEMORY_RERANK_WEIGHT_LEXICAL: '0.4',
      CLAUDE_MEMORY_MONGO_URI: 'mongodb://user:pw@host',
      CLAUDE_MEMORY_LAYER_DASHBOARD_PASSWORD: 'pw',
      PATH: '/usr/bin',
      HOME: '/Users/someone'
    })).toEqual({
      CLAUDE_MEMORY_SEARCH: 'hybrid',
      MEMORY_RERANK_WEIGHT_LEXICAL: '0.4',
      CLAUDE_MEMORY_MONGO_URI: '[redacted]',
      CLAUDE_MEMORY_LAYER_DASHBOARD_PASSWORD: '[redacted]'
    });
  });
});

describe('corpusChanged', () => {
  it('detects rows written to the store between the start and end snapshots', () => {
    const db = new Database(path.join(tempDir(), 'events.sqlite'));
    db.exec('CREATE TABLE events (id TEXT); CREATE TABLE memory_lessons (id TEXT); INSERT INTO events VALUES (\'a\')');
    const start = countRows(db, ['events', 'memory_lessons']);
    expect(corpusChanged(start, countRows(db, ['events', 'memory_lessons']))).toBe(false);
    db.prepare('INSERT INTO events VALUES (?)').run('b');
    const end = countRows(db, ['events', 'memory_lessons']);
    db.close();

    expect(start).toEqual({ events: 1, memory_lessons: 0 });
    expect(end).toEqual({ events: 2, memory_lessons: 0 });
    expect(corpusChanged(start, end)).toBe(true);
  });

  it('counts a missing table as null instead of failing', () => {
    const db = new Database(':memory:');
    expect(countRows(db, ['memory_helpfulness'])).toEqual({ memory_helpfulness: null });
    db.close();
  });

  it('treats a table that appeared or vanished as a change', () => {
    expect(corpusChanged({ a: 1 }, { a: 1, b: 0 })).toBe(true);
  });
});

describe('topKSaturation', () => {
  it('is saturated when top-k reaches the candidate pool size', () => {
    expect(topKSaturation(5, 5)).toBe(true);
    expect(topKSaturation(6, 5)).toBe(true);
    expect(topKSaturation(3, 5)).toBe(false);
  });
});

describe('markdown header', () => {
  it('inserts provenance lines under the report title and leaves the rest unchanged', () => {
    const provenance = buildProvenance({
      generatedAt: '2026-11-01T00:00:00.000Z',
      store: { rowsAtStart: { events: 1 }, rowsAtEnd: { events: 2 } },
      retrieval: { topK: 3, candidatePool: 2 }
    });
    const lines = formatProvenanceLines(provenance);
    const report = '# Title\n\n- Existing: 1\n';
    const withHeader = withProvenanceHeader(report, provenance);

    expect(lines[0]).toMatch(/^- Provenance: git [0-9a-f]{12}/);
    expect(withHeader.startsWith('# Title\n\n- Provenance:')).toBe(true);
    expect(withHeader.endsWith('\n- Existing: 1\n')).toBe(true);
    expect(withHeader).toContain('corpus changed');
    expect(withHeader).toContain('saturated');
  });

  it('prints per-window input row counts', () => {
    const provenance = buildProvenance({ store: { rowsAtStart: {}, rowsAtEnd: {}, inputRows: { 'all time': 4 } } });
    expect(formatProvenanceLines(provenance).join('\n')).toContain('input rows {"all time":4}');
  });
});
