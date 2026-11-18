// @load-sensitive: loads the whole CLI module graph in-process (about 5s cold) to run
// the registered import command; under parallel load that nears the unit timeout.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImportOptions, ImportResult } from '../../src/services/session-history-importer.js';

/**
 * #228: every branch of the Claude `import` command passes actor `cli`, which the
 * forced reimport's delete records on its session_reimport audit row. The command
 * runs in this process with the memory service, importer and worker lock
 * replaced, as in import-force-exit-code.test.ts, so no CLI process starts and no
 * embedding model loads.
 */

const fakes = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; target?: string; options: ImportOptions }>
}));

vi.mock('../../src/services/memory-service.js', async (importOriginal) => {
  const service = {
    initialize: async () => {},
    getEmbeddingModelName: () => 'fake-embedder',
    ensureEmbeddingModelForImport: async () => ({ changed: false }),
    processPendingEmbeddings: async () => 0,
    shutdown: async () => {}
  };
  return {
    ...await importOriginal<object>(),
    getDefaultMemoryService: () => service,
    getMemoryServiceForProject: () => service
  };
});

vi.mock('../../src/services/session-history-importer.js', async (importOriginal) => {
  const result: ImportResult = {
    totalSessions: 1, totalMessages: 2, importedPrompts: 1, importedResponses: 1, skippedDuplicates: 0, errors: []
  };
  return {
    ...await importOriginal<object>(),
    createSessionHistoryImporter: () => ({
      importSessionFile: async (target: string, options: ImportOptions) => {
        fakes.calls.push({ method: 'importSessionFile', target, options });
        return result;
      },
      importProject: async (target: string, options: ImportOptions) => {
        fakes.calls.push({ method: 'importProject', target, options });
        return result;
      },
      importAll: async (options: ImportOptions) => {
        fakes.calls.push({ method: 'importAll', options });
        return result;
      }
    })
  };
});

vi.mock('../../src/core/worker-lock.js', () => ({
  WorkerLock: class {
    acquire() { return { acquired: true }; }
    release() {}
  }
}));

let home = '';
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

// Commander 12 keeps option values across parses, so every run loads the CLI
// afresh and catches the program at the module's own program.parse().
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
  await program.parseAsync(args, { from: 'user' });
  expect(error).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Import Complete'));
}

describe('import passes actor cli to the importer', () => {
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'cml-import-audit-actor-'));
    vi.stubEnv('HOME', home);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fakes.calls = [];
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const project = () => path.join(home, 'work', 'app');
  const session = () => path.join(home, 'sessions', 'one.jsonl');
  const branches: Array<[string, () => string[], () => { method: string; target?: string }]> = [
    ['--session', () => ['import', '--session', session(), '--force'], () => ({ method: 'importSessionFile', target: session() })],
    ['--project', () => ['import', '--project', project(), '--force'], () => ({ method: 'importProject', target: project() })],
    ['--all', () => ['import', '--all', '--force'], () => ({ method: 'importAll' })],
    ['the current project', () => ['import', '--force'], () => ({ method: 'importProject', target: process.cwd() })]
  ];

  it.each(branches)('%s', async (_name, args, expected) => {
    await runCli(...args());

    expect(fakes.calls).toEqual([{ ...expected(), options: expect.objectContaining({ force: true, auditActor: 'cli' }) }]);
  });
});
