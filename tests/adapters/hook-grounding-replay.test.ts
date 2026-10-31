import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  buildFixtureStore,
  DEFAULT_REPLAY_ARMS,
  formatReplayReport,
  runHookGroundingReplay,
  type HookReplayFixture,
  type ReplayReport
} from '../../src/adapters/claude/hooks/hook-grounding-replay.js';

/**
 * Fixture mode of the hook-path grounding replay (#119): a synthetic store is
 * materialized as real SQLite/FTS5 and replayed through selectHookInjection
 * under each flag arm, without an embedder.
 */

const FIXTURE_PATH = path.join(__dirname, '../../benchmarks/replay/hook-grounding-fixture-v1.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as HookReplayFixture;

const roots: string[] = [];
let storagePath: string;
let ids: Map<string, string>;
let report: ReplayReport;
let storeFingerprintBefore: string;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-hook-replay-'));
  roots.push(dir);
  return dir;
}

/**
 * Content hash of the database plus every WAL byte. A read-only connection to a
 * WAL-mode database may create an empty -wal and a -shm index; neither holds data.
 */
function fingerprint(dir: string): string {
  const database = createHash('sha256').update(readFileSync(path.join(dir, 'events.sqlite'))).digest('hex');
  const walBytes = readdirSync(dir)
    .filter((name) => name.endsWith('-wal'))
    .reduce((sum, name) => sum + statSync(path.join(dir, name)).size, 0);
  return `${database}:${walBytes}`;
}

function injectedIds(arm: string, traceId: string): string[] {
  const result = report.arms.find((entry) => entry.arm === arm)!.results.find((entry) => entry.traceId === traceId)!;
  return result.injections.map((injection) => injection.id);
}

function query(arm: string, traceId: string): string {
  return report.arms.find((entry) => entry.arm === arm)!.results.find((entry) => entry.traceId === traceId)!.retrievalQuery;
}

beforeAll(async () => {
  process.env.HOME = tempDir();
  storagePath = tempDir();
  ids = await buildFixtureStore(fixture, storagePath);
  storeFingerprintBefore = fingerprint(storagePath);
  report = await runHookGroundingReplay({
    storagePath,
    projectHash: fixture.projectHash,
    semantic: 'off',
    storeLabel: fixture.name
  });
}, 60_000);

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('hook-path grounding replay (fixture mode)', () => {
  it('replays every hook trace under each flag arm', () => {
    expect(report.turns).toBe(fixture.traces.length);
    expect(report.arms.map((arm) => arm.arm)).toEqual(DEFAULT_REPLAY_ARMS.map((arm) => arm.name));
    for (const arm of report.arms) expect(arm.results).toHaveLength(fixture.traces.length);
  });

  it('rebuilds the recorded retrieval query from the stored prompt, adherence, and previous turn', () => {
    expect(report.queryReproducedRate).toBe(1);
    expect(query('current', 'trace-r2')).toMatch(/^Previous user: How do I publish a release/);
  });

  it('never lets a lane see an answer written after the trace', () => {
    const laterAnswer = ids.get('r5-answer')!;
    for (const arm of report.arms) {
      expect(injectedIds(arm.arm, 'trace-r5')).not.toContain(laterAnswer);
      // Once it exists, the same answer is recalled for the follow-up question.
      expect(injectedIds(arm.arm, 'trace-r6')).toContain(laterAnswer);
    }
  });

  it('scores injections with the evaluator overlap against the later responses', () => {
    const current = report.arms[0].results.find((result) => result.traceId === 'trace-r1')!;
    expect(current.injections.map((injection) => injection.id)).toEqual([ids.get('past-release-answer')]);
    expect(current.injections[0].overlap).toBeGreaterThanOrEqual(0.3);
  });

  it('applies the query sanitizer only in its arms, on long prompts', () => {
    expect(query('current', 'trace-r3')).toBe(fixture.traces.find((trace) => trace.traceId === 'trace-r3')!.rawQueryText);
    expect(query('query-sanitizer (#125)', 'trace-r3'))
      .toBe('Why did SessionStart grounding fall after PR #55 and what did PR #57 change?');
    expect(query('query-sanitizer (#125)', 'trace-r1')).toBe(query('current', 'trace-r1'));
  });

  it('applies the absolute FTS score only in its arms', () => {
    const fts = report.arms.find((arm) => arm.arm === 'fts-absolute (#121)')!;
    expect(fts.queryChangedVsCurrent).toBe(0);
    expect(fts.selectionChangedVsCurrent).toBeGreaterThan(0);
  });

  it('restores the experiment flags after the run', async () => {
    process.env.CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT = 'false';
    delete process.env.CLAUDE_MEMORY_RETRIEVAL_QUERY_SANITIZER_EXPERIMENT;
    try {
      await runHookGroundingReplay({ storagePath, projectHash: fixture.projectHash, semantic: 'off', limit: 1 });
      expect(process.env.CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT).toBe('false');
      expect('CLAUDE_MEMORY_RETRIEVAL_QUERY_SANITIZER_EXPERIMENT' in process.env).toBe(false);
    } finally {
      delete process.env.CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT;
    }
  });

  it('only reads the store', () => {
    expect(fingerprint(storagePath)).toBe(storeFingerprintBefore);
  });

  it('reports aggregates with the counterfactual bias stated, and no content or ids', async () => {
    const markdown = formatReplayReport(report);
    expect(markdown).toContain('**Counterfactual bias.**');
    expect(markdown).toContain('## Historically uninjected turns');
    for (const id of ids.values()) expect(markdown).not.toContain(id);
    for (const event of fixture.events) expect(markdown).not.toContain(event.content.split('\n')[0]);
    await expect(markdown).toMatchFileSnapshot('__snapshots__/hook-grounding-replay-fixture.md');
  });
});

describe('lesson time bound', () => {
  it('drops a lesson saved after the prompt and keeps it once it predates the prompt', async () => {
    const run = async (createdAt: string) => {
      const dir = tempDir();
      await buildFixtureStore({
        ...fixture,
        lessons: fixture.lessons!.map((lesson) => ({ ...lesson, createdAt }))
      }, dir);
      const result = await runHookGroundingReplay({
        storagePath: dir,
        projectHash: fixture.projectHash,
        semantic: 'off',
        arms: [DEFAULT_REPLAY_ARMS[0]],
        limit: 1
      });
      return result.arms[0].results[0].injections.map((injection) => injection.id);
    };

    const lessonId = fixture.lessons![0].lessonId;
    expect(await run('2026-10-01T10:02:00.000Z')).not.toContain(lessonId);
    expect(await run('2026-09-30T00:00:00.000Z')).toContain(lessonId);
  }, 60_000);
});
