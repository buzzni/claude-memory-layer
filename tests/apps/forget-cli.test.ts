// @load-sensitive: loads the whole CLI module graph in-process (about 5s cold) to run
// the registered forget command; under parallel load that nears the unit timeout.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getProjectStoragePath } from '../../src/core/registry/project-path.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

/**
 * #211: the registered `forget` command, run in this process (no CLI process, no embedding
 * model). What it deletes is covered in forget-command.test.ts; this checks the wiring: preview
 * by default, `--confirm` deletes, a mixed selection and a partial cleanup exit 1.
 */

let home = '';
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

// Commander 12 keeps option values across parses, so every run loads the CLI afresh and
// catches the program at the module's own program.parse().
async function runCli(...args: string[]): Promise<void> {
  vi.resetModules();
  const parse = vi.spyOn(Command.prototype, 'parse').mockImplementationOnce(function (this: Command) {
    return this;
  });
  let program: Command;
  try {
    await import('../../src/apps/cli/index.js');
    program = parse.mock.contexts[0] as Command;
  } finally {
    parse.mockRestore();
  }
  await program.parseAsync(['forget', ...args, '--project', project()], { from: 'user' });
}

const project = () => path.join(home, 'work', 'app');
const output = () => log.mock.calls.map((call) => call.join(' ')).join('\n');

async function seed(): Promise<{ a1: string; a2: string; b1: string; dbPath: string }> {
  const dbPath = path.join(getProjectStoragePath(project()), 'events.sqlite');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = new SQLiteEventStore(dbPath);
  await store.initialize();
  const at = new Date('2026-01-01T00:00:00.000Z');
  const a1 = await store.append({ eventType: 'user_prompt', sessionId: 'session-a', timestamp: at, content: 'a first' });
  const a2 = await store.append({ eventType: 'agent_response', sessionId: 'session-a', timestamp: at, content: 'a second' });
  const b1 = await store.append({ eventType: 'user_prompt', sessionId: 'session-b', timestamp: at, content: 'b first' });
  await store.close();
  return { a1: a1.eventId!, a2: a2.eventId!, b1: b1.eventId!, dbPath };
}

async function remaining(dbPath: string, ids: string[]): Promise<string[]> {
  const store = new SQLiteEventStore(dbPath, { readonly: true });
  await store.initialize();
  const left: string[] = [];
  for (const id of ids) if (await store.getEvent(id)) left.push(id);
  await store.close();
  return left;
}

describe('forget <eventId> / --session command', () => {
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'cml-forget-cli-'));
    vi.stubEnv('HOME', home);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitCalled(code); }) as never);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('previews an event id without deleting it, and deletes only that event with --confirm', async () => {
    const ids = await seed();

    await runCli(ids.a1);
    expect(output()).toContain('Matching rows: 1');
    expect(output()).toContain('--confirm');
    expect(await remaining(ids.dbPath, [ids.a1, ids.a2, ids.b1])).toEqual([ids.a1, ids.a2, ids.b1]);

    await runCli(ids.a1, '--confirm');
    expect(output()).toContain('Events deleted 1');
    expect(await remaining(ids.dbPath, [ids.a1, ids.a2, ids.b1])).toEqual([ids.a2, ids.b1]);
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('deletes every event of a session with --session --confirm and leaves other sessions', async () => {
    const ids = await seed();

    await runCli('--session', 'session-a', '--confirm');

    expect(output()).toContain('Events deleted 2');
    expect(await remaining(ids.dbPath, [ids.a1, ids.a2, ids.b1])).toEqual([ids.b1]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('rejects combined selectors with exit 1 instead of silently picking one', async () => {
    const ids = await seed();

    await expect(runCli(ids.a1, '--session', 'session-b', '--confirm')).rejects.toEqual(new ExitCalled(1));

    expect(error).toHaveBeenCalledWith(expect.stringContaining('only one'));
    expect(await remaining(ids.dbPath, [ids.a1, ids.a2, ids.b1])).toEqual([ids.a1, ids.a2, ids.b1]);
  });

  it.skipIf(process.getuid?.() === 0)('exits 1 when part of the forgotten data could not be removed', async () => {
    const ids = await seed();
    const mirrorFile = path.join(getProjectStoragePath(project()), 'memory', 'default', 'user_prompt', '2026-01-01.md');
    mkdirSync(path.dirname(mirrorFile), { recursive: true });
    // A second entry that stays forces a rewrite (a file left empty would just be unlinked).
    const entry = (id: string, sessionId: string) =>
      `\n- ts: 2026-01-01T00:00:00.000Z\n  id: ${id}\n  type: user_prompt\n  session: ${sessionId}\n  category: user_prompt\n  content: |\n    text\n`;
    writeFileSync(mirrorFile, entry(ids.a1, 'session-a') + entry(ids.b1, 'session-b'));
    chmodSync(mirrorFile, 0o444);

    await runCli(ids.a1, '--confirm');

    expect(output()).toContain('Warning: could not rewrite');
    expect(process.exitCode).toBe(1);
    expect(await remaining(ids.dbPath, [ids.a1])).toEqual([]);
  });
});
