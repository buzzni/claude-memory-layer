import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asStored } from '../helpers/stored-origin.js';

/**
 * SessionStart recap: rows from another machine carry a low-trust label;
 * native rows and this machine's host session imports (Codex) do not. The
 * trace counts the injected rows per origin class.
 */

const fixture = vi.hoisted(() => ({
  input: '',
  service: null as null | Record<string, ReturnType<typeof vi.fn>>
}));

vi.mock('../../src/services/memory-service.js', () => ({
  getLightweightMemoryServiceForProject: () => fixture.service,
  createMemoryService: () => fixture.service,
  getProjectStoragePath: (project: string) => `/fixture-storage${project}`,
  hashProjectPath: () => 'hash-a',
  DISABLED_SHARED_STORE_CONFIG: { enabled: false },
  getLightweightMemoryService: () => { throw new Error('cwd-bearing hooks must not use the session registry'); }
}));
vi.mock('../../src/core/registry/session-registry.js', () => ({ registerSession: vi.fn().mockReturnValue('hash-a') }));
vi.mock('../../src/adapters/claude/hooks/hook-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/adapters/claude/hooks/hook-runtime.js')>(),
  readStdin: vi.fn(async () => fixture.input)
}));
vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  ensureDaemonRunning: vi.fn().mockResolvedValue(undefined),
  scheduleSessionSummary: vi.fn().mockResolvedValue(undefined),
  retrieveSemanticMemories: vi.fn().mockResolvedValue([]),
  scheduleSemanticGraduation: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../../src/adapters/claude/hooks/tool-observation-vector-auto-heal-client.js', () => ({
  spawnToolObservationVectorAutoHealIfNeeded: vi.fn().mockResolvedValue(undefined)
}));

const NATIVE_ANSWER = 'Native answer: releases go through publish-npm.yml on tag push.';
const CODEX_ANSWER = 'Codex answer: the Codex session fixed the replay fixture.';
const IMPORTED_ANSWER = 'Pulled answer: machine B moved the dashboard port.';

/** As getRecentEvents returns it: with the origin the store computes. */
function answer(id: string, content: string, timestamp: string, metadata: Record<string, unknown> = {}) {
  return asStored({ id, eventType: 'agent_response', sessionId: `session-${id}`, content, timestamp: new Date(timestamp), metadata });
}

function createService() {
  return {
    startSession: vi.fn().mockResolvedValue(undefined),
    getSessionsWithoutSummary: vi.fn().mockResolvedValue([]),
    backfillMissingSummaries: vi.fn().mockResolvedValue(undefined),
    getCoreMemoryBlockInjections: vi.fn().mockResolvedValue([]),
    listProjectLessonInjections: vi.fn().mockResolvedValue([]),
    getSessionStartLessonUsage: vi.fn().mockResolvedValue(new Map()),
    listProjectRunbookIds: vi.fn().mockResolvedValue([]),
    getRecentEvents: vi.fn().mockResolvedValue([
      answer('native', NATIVE_ANSWER, '2026-11-07T01:00:00.000Z'),
      answer('codex', CODEX_ANSWER, '2026-11-06T01:00:00.000Z', { importedFrom: '/home/u/.codex/sessions/a.jsonl', source: 'codex' }),
      answer('imported', IMPORTED_ANSWER, '2026-11-05T01:00:00.000Z', { mongoSync: { originHostname: 'machine-b' } })
    ]),
    recordRetrieval: vi.fn().mockResolvedValue(undefined),
    recordQueryTrace: vi.fn().mockResolvedValue('trace-id'),
    recordDeliveryOutcome: vi.fn().mockResolvedValue(1),
    close: vi.fn().mockResolvedValue(undefined)
  };
}

let home: string;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'cml-session-start-source-trust-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', '');
  vi.stubEnv('CLAUDE_MEMORY_LESSON_OWNER', '');
  vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', '');
  vi.stubEnv('CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT', '');
  vi.stubEnv('CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH', join(home, 'operations.json'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fixture.service = createService();
});

afterEach(async () => {
  const { reportHookDelivery } = await import('../../src/adapters/claude/hooks/hook-output.js');
  await reportHookDelivery({ status: 'failed', error: new Error('fixture cleanup') });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

async function sessionStartContext(): Promise<string> {
  fixture.input = JSON.stringify({ cwd: '/repo/a', session_id: 'session-now', hook_event_name: 'SessionStart', source: 'startup' });
  const { main } = await import('../../src/adapters/claude/hooks/session-start.js');
  const output = JSON.parse(await main({ persistPrompt: false }));
  return output.hookSpecificOutput.additionalContext ?? '';
}

describe('SessionStart source-trust labels', () => {
  it('labels the row from another machine and leaves native and host-import rows bare', async () => {
    const context = await sessionStartContext();

    expect(context).toContain(`- **2026-11-07**: ${NATIVE_ANSWER}`);
    expect(context).toContain(`- **2026-11-06**: ${CODEX_ANSWER}`);
    expect(context).toContain(`- **2026-11-05** [low-trust: imported]: ${IMPORTED_ANSWER}`);
  });

  it('records the recap rows per origin class on the trace', async () => {
    await sessionStartContext();

    const recapTrace = fixture.service!.recordQueryTrace.mock.calls
      .map(([trace]) => trace)
      .find((trace) => trace.strategy === 'session-start-hook');
    expect(recapTrace.outcomeDiagnostics.injectedByOrigin).toEqual({ assistant: 2, imported: 1 });
  });

  it('keeps imported rows in the recap when the source-trust filter is on', async () => {
    writeFileSync(join(home, 'operations.json'), JSON.stringify({ sourceTrust: { excludeUntrustedFromAutoInjection: true } }));

    const context = await sessionStartContext();

    expect(context).toContain(NATIVE_ANSWER);
    expect(context).toContain(`[low-trust: imported]: ${IMPORTED_ANSWER}`);
  });
});
