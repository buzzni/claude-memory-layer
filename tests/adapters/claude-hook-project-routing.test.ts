import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({
  input: '',
  services: new Map<string, ReturnType<typeof createService>>(),
  forProject: vi.fn(),
  deliveryService: vi.fn(),
  forSession: vi.fn(),
  registerSession: vi.fn(),
  ensureDaemonRunning: vi.fn(),
  autoHeal: vi.fn(),
  retrieveSemanticMemories: vi.fn(),
  scheduleSemanticGraduation: vi.fn()
}));

vi.mock('../../src/services/memory-service.js', () => ({
  getLightweightMemoryServiceForProject: fixture.forProject,
  createMemoryService: fixture.deliveryService,
  getProjectStoragePath: (project: string) => `/fixture-storage${project}`,
  hashProjectPath: (project: string) => `hash-${project.slice(-1)}`,
  DISABLED_SHARED_STORE_CONFIG: { enabled: false },
  getLightweightMemoryService: fixture.forSession
}));
vi.mock('../../src/core/registry/session-registry.js', () => ({ registerSession: fixture.registerSession }));
vi.mock('../../src/adapters/claude/hooks/hook-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/adapters/claude/hooks/hook-runtime.js')>(),
  readStdin: vi.fn(async () => fixture.input)
}));
vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  ensureDaemonRunning: fixture.ensureDaemonRunning,
  scheduleSessionSummary: vi.fn().mockResolvedValue(undefined),
  retrieveSemanticMemories: fixture.retrieveSemanticMemories,
  scheduleSemanticGraduation: fixture.scheduleSemanticGraduation
}));
vi.mock('../../src/adapters/claude/hooks/tool-observation-vector-auto-heal-client.js', () => ({
  spawnToolObservationVectorAutoHealIfNeeded: fixture.autoHeal
}));

function createService(project: string) {
  const event = {
    id: `event-${project.slice(-1)}`, eventType: 'agent_response', sessionId: 'past-session',
    content: `Deployment approval workflow requires the release manager to approve tag push. Project ${project.slice(-1)} uses signed release tags.`,
    timestamp: new Date('2026-09-01T00:00:00.000Z')
  };
  return {
    startSession: vi.fn().mockResolvedValue(undefined),
    evaluatePendingSessions: vi.fn().mockResolvedValue(undefined),
    getSessionsWithoutSummary: vi.fn().mockResolvedValue([]),
    backfillMissingSummaries: vi.fn().mockResolvedValue(undefined),
    getCoreMemoryBlockInjections: vi.fn().mockResolvedValue([]),
    listProjectLessonInjections: vi.fn().mockResolvedValue([]),
    searchGraduatedEvidence: vi.fn().mockResolvedValue([]),
    keywordSearch: vi.fn().mockResolvedValue([{ score: 0.95, event }]),
    getEvent: vi.fn().mockResolvedValue(event),
    getRecentEvents: vi.fn().mockResolvedValue([event]),
    incrementMemoryAccess: vi.fn().mockResolvedValue(undefined),
    recordRetrieval: vi.fn().mockResolvedValue(undefined),
    recordQueryTrace: vi.fn().mockResolvedValue('trace-id'),
    recordDeliveryOutcome: vi.fn().mockResolvedValue(1),
    storeUserPrompt: vi.fn().mockResolvedValue(undefined),
    getSessionHistory: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined)
  };
}

let home: string;
let diagnostics: string[];

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'cml-project-routing-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', '');
  vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', 'true');
  vi.stubEnv('CLAUDE_MEMORY_RETRIEVAL_MODE', 'keyword');
  vi.stubEnv('CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT', '');
  vi.stubEnv('CLAUDE_MEMORY_SEARCH', 'true');
  vi.stubEnv('CLAUDE_MEMORY_DEBUG', '1');
  diagnostics = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => { diagnostics.push(args.map(String).join(' ')); });
  fixture.services.clear();
  fixture.forProject.mockReset().mockImplementation((project: string) => {
    if (!fixture.services.has(project)) fixture.services.set(project, createService(project));
    return fixture.services.get(project);
  });
  fixture.forSession.mockReset().mockImplementation(() => { throw new Error('session registry must not route cwd-bearing recall'); });
  fixture.deliveryService.mockReset().mockImplementation(() => createService('/repo/delivery'));
  fixture.registerSession.mockReset().mockReturnValue('project-hash');
  fixture.ensureDaemonRunning.mockReset().mockResolvedValue(undefined);
  fixture.autoHeal.mockReset().mockResolvedValue(undefined);
  fixture.retrieveSemanticMemories.mockReset().mockResolvedValue([]);
  fixture.scheduleSemanticGraduation.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  // Clear a delivery callback, including on a test assertion failure, before
  // another fixture replaces the service or removes its isolated HOME.
  const { reportHookDelivery } = await import('../../src/adapters/claude/hooks/hook-output.js');
  await reportHookDelivery({ status: 'failed', error: new Error('fixture cleanup') });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

const hooks = [
  { event: 'SessionStart', module: '../../src/adapters/claude/hooks/session-start.js' },
  { event: 'UserPromptSubmit', module: '../../src/adapters/claude/hooks/user-prompt-submit.js' }
] as const;

async function invoke(module: string, input: unknown): Promise<{ hookSpecificOutput: { hookEventName: string; additionalContext?: string } }> {
  fixture.input = typeof input === 'string' ? input : JSON.stringify(input);
  const { main } = await import(module);
  return JSON.parse(await main({ persistPrompt: false, contextPresentation: 'reference' }));
}

function input(cwd: unknown = '/repo/a') {
  return { cwd, session_id: 'unregistered-session', prompt: 'Explain deployment approval workflow tag push release manager' };
}

describe('cwd-authoritative automatic recall', () => {
  for (const hook of hooks) {
    it(`${hook.event} routes unregistered and reused sessions by their supplied project cwd`, async () => {
      const a = await invoke(hook.module, input('/repo/a'));
      const b = await invoke(hook.module, input('/repo/b'));

      expect(fixture.forSession).not.toHaveBeenCalled();
      expect(fixture.forProject.mock.calls.map((call) => call[0])).toEqual(['/repo/a', '/repo/b']);
      expect(a.hookSpecificOutput.additionalContext).toContain('Project a');
      expect(a.hookSpecificOutput.additionalContext).not.toContain('Project b');
      expect(b.hookSpecificOutput.additionalContext).toContain('Project b');
      expect(b.hookSpecificOutput.additionalContext).not.toContain('Project a');
      const terminal = diagnostics.filter((line) => line.startsWith('[cml-recall] ')).map((line) => JSON.parse(line.slice('[cml-recall] '.length)));
      expect(terminal.filter((record) => record.stage === 'complete')).toEqual([
        expect.objectContaining({ event: hook.event, outcome: 'selected', contextChars: expect.any(Number) }),
        expect.objectContaining({ event: hook.event, outcome: 'selected', contextChars: expect.any(Number) })
      ]);
    });

    for (const body of ['{broken', 'null', '{}', JSON.stringify(input('relative/repo')), JSON.stringify(input('')), JSON.stringify(input(null))]) {
      it(`${hook.event} rejects invalid or missing cwd before registry, daemon, or service side effects (${body})`, async () => {
        const output = await invoke(hook.module, body);

        expect(output).toEqual({ hookSpecificOutput: { hookEventName: hook.event } });
        expect(fixture.forProject).not.toHaveBeenCalled();
        expect(fixture.forSession).not.toHaveBeenCalled();
        expect(fixture.registerSession).not.toHaveBeenCalled();
        expect(fixture.ensureDaemonRunning).not.toHaveBeenCalled();
        expect(fixture.autoHeal).not.toHaveBeenCalled();
        expect(diagnostics.some((line) => line.startsWith('[cml-recall] ') && JSON.parse(line.slice('[cml-recall] '.length)).outcome === 'error')).toBe(true);
      });
    }

    it(`${hook.event} converts constructor permission errors to an empty envelope with safe diagnostics`, async () => {
      fixture.forProject.mockImplementation(() => {
        throw Object.assign(new Error('secret-token /private/memory/store'), { code: 'SQLITE_CANTOPEN' });
      });
      const output = await invoke(hook.module, input());

      expect(output).toEqual({ hookSpecificOutput: { hookEventName: hook.event } });
      expect(diagnostics.join('\n')).not.toMatch(/secret-token|\/private\/memory\/store/);
      expect(diagnostics.filter((line) => line.startsWith('[cml-recall] ')).map((line) => JSON.parse(line.slice('[cml-recall] '.length)))).toContainEqual(expect.objectContaining({
        event: hook.event, stage: 'service', outcome: 'error', errorCode: 'SQLITE_CANTOPEN'
      }));
    });
  }

  it('SessionStart registry permission failure does not suppress authoritative project retrieval', async () => {
    fixture.registerSession.mockImplementation(() => { throw Object.assign(new Error('private registry path'), { code: 'EPERM' }); });
    const output = await invoke(hooks[0].module, input());
    expect(output.hookSpecificOutput.additionalContext).toContain('Project a');
    expect(diagnostics.join('\n')).not.toContain('private registry path');
    expect(diagnostics.filter((line) => line.startsWith('[cml-recall] ')).map((line) => JSON.parse(line.slice('[cml-recall] '.length)))).toContainEqual(expect.objectContaining({
      event: 'SessionStart', stage: 'registry', outcome: 'error', errorCode: 'EPERM'
    }));
  });

  it('host-worker startup retains registration, retrieval, and telemetry without detached maintenance', async () => {
    vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', '');
    vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', 'host-worker');
    fixture.input = JSON.stringify(input());
    const { main } = await import('../../src/adapters/claude/hooks/session-start.js');
    const output = JSON.parse(await main({ contextPresentation: 'reference', deliveryClient: 'codex-host', maintenance: false }));
    const service = fixture.services.get('/repo/a')!;

    expect(output.hookSpecificOutput.additionalContext).toContain('Project a');
    expect(fixture.registerSession).toHaveBeenCalledWith('unregistered-session', '/repo/a');
    expect(service.startSession).toHaveBeenCalledWith('unregistered-session', '/repo/a');
    expect(service.recordQueryTrace).toHaveBeenCalledWith(expect.objectContaining({ deliveryClient: 'codex-host' }));
    expect(fixture.ensureDaemonRunning).not.toHaveBeenCalled();
    expect(fixture.autoHeal).not.toHaveBeenCalled();
    expect(service.getSessionsWithoutSummary).not.toHaveBeenCalled();
    expect(service.backfillMissingSummaries).not.toHaveBeenCalled();
  });

  it('records startup stdout evidence using a fresh writer after the retrieval service closes', async () => {
    vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', '');
    const fresh = createService('/repo/delivery');
    fixture.deliveryService.mockReturnValue(fresh);
    fixture.input = JSON.stringify(input());
    const { main } = await import('../../src/adapters/claude/hooks/session-start.js');
    await main({ contextPresentation: 'reference', deliveryClient: 'codex-host', maintenance: false });
    const closed = fixture.services.get('/repo/a')!;
    expect(closed.close).toHaveBeenCalledTimes(1);
    expect(fixture.deliveryService).not.toHaveBeenCalled();
    const { reportHookDelivery } = await import('../../src/adapters/claude/hooks/hook-output.js');
    await reportHookDelivery({ status: 'emitted' });
    expect(fixture.deliveryService).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/repo/a', projectHash: 'hash-a', storagePath: '/fixture-storage/repo/a',
      lightweightMode: true, analyticsEnabled: false, sharedStoreConfig: { enabled: false }
    }));
    expect(fresh.recordDeliveryOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: 'emitted', evidence: 'hook_stdout' }));
    expect(closed.recordDeliveryOutcome).not.toHaveBeenCalled();
    expect(fresh.close).toHaveBeenCalledTimes(1);
  });

  it('evaluation startup does not pollute production retrieval or delivery records', async () => {
    await invoke(hooks[0].module, input());
    const service = fixture.services.get('/repo/a')!;
    expect(service.recordRetrieval).not.toHaveBeenCalled();
    expect(service.recordQueryTrace).not.toHaveBeenCalled();
    const { reportHookDelivery } = await import('../../src/adapters/claude/hooks/hook-output.js');
    await reportHookDelivery({ status: 'emitted' });
    expect(fixture.deliveryService).not.toHaveBeenCalled();
    expect(service.recordDeliveryOutcome).not.toHaveBeenCalled();
  });

  it('host-worker prompt scopes the existing semantic daemon without launching maintenance', async () => {
    vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', '');
    vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', 'host-worker');
    vi.stubEnv('CLAUDE_MEMORY_RETRIEVAL_MODE', 'hybrid');
    fixture.input = JSON.stringify(input());
    const { main } = await import('../../src/adapters/claude/hooks/user-prompt-submit.js');
    const output = JSON.parse(await main({ contextPresentation: 'reference', deliveryClient: 'codex-host', persistPrompt: false, maintenance: false, allowDaemonStart: false }));
    const service = fixture.services.get('/repo/a')!;

    expect(output.hookSpecificOutput.additionalContext).toContain('Project a');
    expect(fixture.retrieveSemanticMemories).toHaveBeenCalledWith(expect.objectContaining({ projectPath: '/repo/a', sessionId: 'unregistered-session' }), expect.any(Number), { allowDaemonStart: false });
    expect(service.recordQueryTrace).toHaveBeenCalledWith(expect.objectContaining({ deliveryClient: 'codex-host' }));
    expect(service.evaluatePendingSessions).not.toHaveBeenCalled();
    expect(fixture.scheduleSemanticGraduation).not.toHaveBeenCalled();
    expect(service.storeUserPrompt).not.toHaveBeenCalled();
  });
});
