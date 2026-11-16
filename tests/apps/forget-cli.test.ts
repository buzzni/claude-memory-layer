import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { hashProjectPath } from '../../src/core/registry/project-path.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { tsxArgs, tsxCommand } from '../helpers/tsx-process.js';

interface CliFixture {
  home: string;
  projectDir: string;
  dbPath: string;
}

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function createFixture(name: string): CliFixture {
  const home = mkdtempSync(path.join(tmpdir(), `cml-forget-cli-${name}-`));
  homes.push(home);
  const projectDir = `/opt/cml-forget-cli-${name}-project`;
  const storagePath = path.join(home, '.claude-code', 'memory', 'projects', hashProjectPath(projectDir));
  mkdirSync(storagePath, { recursive: true });
  return { home, projectDir, dbPath: path.join(storagePath, 'events.sqlite') };
}

async function seed(fixture: CliFixture): Promise<{ a1: string; a2: string; b1: string }> {
  const store = new SQLiteEventStore(fixture.dbPath);
  await store.initialize();
  const at = new Date('2026-01-01T00:00:00.000Z');
  const a1 = await store.append({ eventType: 'user_prompt', sessionId: 'session-a', timestamp: at, content: 'a first' });
  const a2 = await store.append({ eventType: 'agent_response', sessionId: 'session-a', timestamp: at, content: 'a second' });
  const b1 = await store.append({ eventType: 'user_prompt', sessionId: 'session-b', timestamp: at, content: 'b first' });
  await store.close();
  return { a1: a1.eventId!, a2: a2.eventId!, b1: b1.eventId! };
}

async function remainingIds(fixture: CliFixture, ids: string[]): Promise<string[]> {
  const store = new SQLiteEventStore(fixture.dbPath, { readonly: true });
  await store.initialize();
  const remaining: string[] = [];
  for (const id of ids) {
    if (await store.getEvent(id)) remaining.push(id);
  }
  await store.close();
  return remaining;
}

function runForget(fixture: CliFixture, args: string[]) {
  return spawnSync(tsxCommand, tsxArgs('src/apps/cli/index.ts', 'forget', ...args, '--project', fixture.projectDir), {
    cwd: process.cwd(),
    env: { ...process.env, HOME: fixture.home },
    encoding: 'utf8'
  });
}

describe('claude-memory-layer forget <eventId> / --session', () => {
  it('previews an event id without deleting it, and deletes only that event with --confirm', async () => {
    const fixture = createFixture('event');
    const ids = await seed(fixture);

    const preview = runForget(fixture, [ids.a1]);
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('Matching rows: 1');
    expect(preview.stdout).toContain('--confirm');
    expect(await remainingIds(fixture, [ids.a1, ids.a2, ids.b1])).toEqual([ids.a1, ids.a2, ids.b1]);

    const applied = runForget(fixture, [ids.a1, '--confirm']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toContain('Events deleted 1');
    expect(await remainingIds(fixture, [ids.a1, ids.a2, ids.b1])).toEqual([ids.a2, ids.b1]);
  }, 60_000);

  it('deletes every event of a session with --session --confirm and leaves other sessions', async () => {
    const fixture = createFixture('session');
    const ids = await seed(fixture);

    const applied = runForget(fixture, ['--session', 'session-a', '--confirm']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toContain('Events deleted 2');
    expect(await remainingIds(fixture, [ids.a1, ids.a2, ids.b1])).toEqual([ids.b1]);
  }, 60_000);

  it('rejects combined selectors with a non-zero exit instead of silently picking one', async () => {
    const fixture = createFixture('conflict');
    const ids = await seed(fixture);

    const result = runForget(fixture, [ids.a1, '--session', 'session-b', '--confirm']);
    expect(result.status).not.toBe(0);
    expect(await remainingIds(fixture, [ids.a1, ids.a2, ids.b1])).toEqual([ids.a1, ids.a2, ids.b1]);
  }, 60_000);
});
