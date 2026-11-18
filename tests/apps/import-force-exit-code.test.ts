// @load-sensitive: loads the whole CLI module graph in-process (about 5s cold) to run
// the registered import commands; under parallel load that nears the unit timeout.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { importExitCode } from '../../src/apps/cli/import-exit-code.js';
import { FORCE_REIMPORT_LIMIT_REFUSAL, type ImportResult } from '../../src/services/session-history-importer.js';

/**
 * #227: a force reimport the --limit could cut short is skipped and the
 * command exits 1; one skipped because the source has nothing to read stays a
 * warning (exit 0). `import`, `codex import` and `hermes import` all end
 * through printImportSummary, which takes its exit code from importExitCode.
 * The importers' own skip decisions are covered without a process in
 * tests/services/*force-reimport* and tests/core/*validation*.
 */

const limitSkip = (source: string) => `Skipped force reimport (${FORCE_REIMPORT_LIMIT_REFUSAL}): ${source}`;
const unreadableSkip = (source: string) => `Skipped force reimport (no parseable records): ${source}`;

describe('import --force exit codes', () => {
  it('exits 0 when every session imported', () => {
    expect(importExitCode({ errors: [] })).toBe(0);
  });

  it('exits 1 when a force reimport was skipped for the message limit', () => {
    expect(importExitCode({ errors: [limitSkip('/sessions/exit-session.jsonl')] })).toBe(1);
  });

  it('exits 0 when a force reimport was skipped for having no parseable records', () => {
    expect(importExitCode({ errors: [unreadableSkip('/sessions/torn-session.jsonl')] })).toBe(0);
  });

  it('exits 0 for other import errors', () => {
    expect(importExitCode({ errors: ['File not found: /sessions/gone.jsonl', 'Failed to import /sessions/a.jsonl: boom'] })).toBe(0);
  });

  it('exits 0 when the limit refusal text only appears in another error or a file name', () => {
    expect(importExitCode({
      errors: [
        `Failed to import /sessions/a.jsonl: ${limitSkip('/sessions/a.jsonl')}`,
        unreadableSkip(`/sessions/Skipped force reimport (${FORCE_REIMPORT_LIMIT_REFUSAL}).jsonl`)
      ]
    })).toBe(0);
  });

  it('exits 1 when one limit skip sits among other skips and errors', () => {
    expect(importExitCode({
      errors: [
        unreadableSkip('hermes-tools'),
        'Failed to import /sessions/a.jsonl: boom',
        limitSkip('hermes-exit'),
        unreadableSkip('/sessions/torn-session.jsonl')
      ]
    })).toBe(1);
  });
});

// The registered commands run in this process with the memory service,
// importers, runners and worker lock replaced, so no CLI process starts and
// no embedding model loads.
const fakes = vi.hoisted(() => ({ result: undefined as unknown as ImportResult }));

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

vi.mock('../../src/services/session-history-importer.js', async (importOriginal) => ({
  ...await importOriginal<object>(),
  createSessionHistoryImporter: () => ({
    importSessionFile: async () => fakes.result,
    importProject: async () => fakes.result,
    importAll: async () => fakes.result
  })
}));

vi.mock('../../src/apps/cli/codex-import-runner.js', () => ({
  runCodexImportOnce: async () => ({ mode: 'project', storageScope: 'project', result: fakes.result, embedCount: 0 })
}));

vi.mock('../../src/apps/cli/hermes-import-runner.js', () => ({
  runHermesImportOnce: async () => ({ mode: 'project', storageScope: 'project', result: fakes.result, embedCount: 0 })
}));

vi.mock('../../src/core/worker-lock.js', () => ({
  WorkerLock: class {
    acquire() { return { acquired: true }; }
    release() {}
  }
}));

const importResult = (errors: string[]): ImportResult => ({
  totalSessions: 1,
  totalMessages: 6,
  importedPrompts: 3,
  importedResponses: 3,
  skippedDuplicates: 0,
  errors
});

let home = '';
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

// Commander 12 keeps option values across parses, so every run loads the CLI
// afresh and catches the program at the module's own program.parse(). A run
// that fails before the summary would set exit code 1 on its own, so each run
// must reach the summary without an error.
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

describe('import commands end with the import exit code', () => {
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'cml-import-exit-wiring-'));
    vi.stubEnv('HOME', home);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const project = () => path.join(home, 'work', 'app');
  const commands: Array<[string, () => string[]]> = [
    ['import --project', () => ['import', '--project', project(), '--force', '--limit', '6']],
    ['import --all', () => ['import', '--all', '--force', '--limit', '6']],
    ['codex import', () => ['codex', 'import', '--project', project(), '--force', '--limit', '6', '--no-process-embeddings']],
    ['hermes import', () => ['hermes', 'import', '--project', project(), '--force', '--limit', '6', '--no-process-embeddings']]
  ];

  describe.each(commands)('%s', (_name, args) => {
    it('exits 1 when a force reimport was skipped for the message limit', async () => {
      fakes.result = importResult([limitSkip('exit-session')]);
      await runCli(...args());
      expect(process.exitCode).toBe(1);
    });

    it('exits 0 when every session imported', async () => {
      fakes.result = importResult([]);
      await runCli(...args());
      expect(process.exitCode ?? 0).toBe(0);
    });

    it('keeps an earlier failure exit code', async () => {
      fakes.result = importResult([unreadableSkip('torn-session')]);
      process.exitCode = 1;
      await runCli(...args());
      expect(process.exitCode).toBe(1);
    });
  });
});
