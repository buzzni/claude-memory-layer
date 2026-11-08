import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  service: vi.fn(),
  generate: vi.fn(),
  acquire: vi.fn()
}));
vi.mock('../../../src/services/memory-service.js', () => ({
  DISABLED_SHARED_STORE_CONFIG: {},
  MemoryService: class {
    constructor(options: unknown) { return mocks.service(options); }
  }
}));
vi.mock('../../../src/core/registry/session-registry.js', () => ({ getSessionProject: () => undefined }));
vi.mock('../../../src/core/worker-lock.js', () => ({
  WorkerLock: class {
    acquire() { return mocks.acquire(); }
    release() {}
  }
}));
vi.mock('../../../src/adapters/llm/session-summary-llm.js', () => ({
  generateLlmSessionSummary: mocks.generate,
  isLlmSummaryEnabled: () => true,
  getSummaryProviderName: () => 'codex',
  getSummaryModel: () => 'gpt-test'
}));

type ServiceOptions = { llmSummaryGenerator: (events: unknown[]) => Promise<unknown> };

/** Stands in for MemoryService: runs the injected generator like the ingest service does. */
function stubService(options: { callsProvider: boolean; stored: boolean }) {
  mocks.service.mockImplementation((serviceOptions: ServiceOptions) => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    generateLlmSessionSummary: vi.fn(async () => {
      if (options.callsProvider) await serviceOptions.llmSummaryGenerator([]);
      return options.stored;
    })
  }));
}

async function summarizeAndSnapshot() {
  const telemetryModule = await import('../../../src/core/runtime-resource-telemetry.js');
  const telemetry = new telemetryModule.RuntimeResourceTelemetry({ persist: false });
  telemetryModule.setRuntimeResourceTelemetryForTests(telemetry);
  const { handleSemanticDaemonRequest } = await import('../../../src/adapters/claude/hooks/semantic-daemon.js');
  await handleSemanticDaemonRequest(JSON.stringify({ type: 'summarize', sessionId: 's1' }));
  // The summary runs fire-and-forget; wait for it to settle.
  await vi.waitFor(() => expect(mocks.service).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
  return telemetry.getSnapshot().summary;
}

beforeEach(() => {
  vi.resetModules();
  mocks.service.mockReset();
  mocks.generate.mockReset().mockResolvedValue({ text: 't', metadata: {} });
  mocks.acquire.mockReset().mockReturnValue({ acquired: true });
});
afterEach(() => { vi.resetModules(); });

describe('semantic daemon summary telemetry', () => {
  it('records a stored summary with the resolved provider and model', async () => {
    stubService({ callsProvider: true, stored: true });
    expect(await summarizeAndSnapshot()).toMatchObject({
      provider: 'codex', model: 'gpt-test', attempts: 1, stored: 1, empty: 0, failures: 0
    });
  });

  it('records an empty outcome when the provider answered but nothing was stored', async () => {
    stubService({ callsProvider: true, stored: false });
    expect(await summarizeAndSnapshot()).toMatchObject({ attempts: 1, stored: 0, empty: 1, failures: 0 });
  });

  it('records the provider error code instead of swallowing the failure', async () => {
    const { CliProviderError } = await import('../../../src/adapters/llm/cli-provider.js');
    mocks.generate.mockRejectedValue(new CliProviderError('not logged in', 'auth'));
    stubService({ callsProvider: true, stored: false });
    const summary = await summarizeAndSnapshot();
    expect(summary).toMatchObject({ attempts: 1, stored: 0, failures: 1, lastFailure: { code: 'auth' } });
  });

  it('records nothing when the provider was never called (already summarized, too few events)', async () => {
    stubService({ callsProvider: false, stored: false });
    expect(await summarizeAndSnapshot()).toBeUndefined();
  });
});
