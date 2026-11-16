import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  summarized: [] as string[]
}));
vi.mock('../../../src/services/memory-service.js', () => ({
  DISABLED_SHARED_STORE_CONFIG: {},
  MemoryService: class {
    constructor(private readonly options: { llmSummaryGenerator: (events: unknown[]) => Promise<unknown> }) {}
    async initialize() {}
    async shutdown() {}
    async generateLlmSessionSummary(sessionId: string) {
      mocks.summarized.push(sessionId);
      return Boolean(await this.options.llmSummaryGenerator([]));
    }
  }
}));
vi.mock('../../../src/core/registry/session-registry.js', () => ({ getSessionProject: () => undefined }));
vi.mock('../../../src/core/worker-lock.js', () => ({
  WorkerLock: class {
    acquire() { return { acquired: true }; }
    release() {}
  }
}));
vi.mock('../../../src/adapters/llm/session-summary-llm.js', () => ({
  generateLlmSessionSummary: mocks.generate,
  isLlmSummaryEnabled: () => true,
  getSummaryProviderName: () => 'claude',
  getSummaryModel: () => 'test-model'
}));

let homeDir: string;

async function loadModules() {
  const telemetryModule = await import('../../../src/core/runtime-resource-telemetry.js');
  const telemetry = new telemetryModule.RuntimeResourceTelemetry({ persist: false });
  telemetryModule.setRuntimeResourceTelemetryForTests(telemetry);
  const daemon = await import('../../../src/adapters/claude/hooks/semantic-daemon.js');
  const pending = await import('../../../src/adapters/llm/summary-pending.js');
  const { CliProviderError } = await import('../../../src/adapters/llm/cli-provider.js');
  return { telemetry, daemon, pending, CliProviderError };
}

async function summarize(daemon: { handleSemanticDaemonRequest(raw: string): Promise<unknown> }, sessionId: string) {
  await daemon.handleSemanticDaemonRequest(JSON.stringify({ type: 'summarize', sessionId }));
}

beforeEach(() => {
  vi.resetModules();
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-daemon-pending-'));
  vi.stubEnv('HOME', homeDir);
  mocks.generate.mockReset();
  mocks.summarized.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('semantic daemon and the provider circuit breaker', () => {
  it('keeps a session the open breaker skipped and counts it as skipped, not failed', async () => {
    const { telemetry, daemon, pending, CliProviderError } = await loadModules();
    mocks.generate.mockRejectedValue(new CliProviderError('skipped', 'provider-circuit-open'));

    await summarize(daemon, 's1');

    await vi.waitFor(() => expect(pending.listPendingSummaries().map((entry) => entry.sessionId)).toEqual(['s1']));
    expect(telemetry.getSnapshot().summary).toMatchObject({ attempts: 0, failures: 0, skipped: 1 });
  });

  it('does not keep sessions whose provider call failed for another reason', async () => {
    const { telemetry, daemon, pending, CliProviderError } = await loadModules();
    mocks.generate.mockRejectedValue(new CliProviderError('limit', 'provider-rate-limit'));

    await summarize(daemon, 's1');

    await vi.waitFor(() => expect(telemetry.getSnapshot().summary?.failures).toBe(1));
    expect(pending.listPendingSummaries()).toEqual([]);
  });

  it('summarizes the kept sessions once a provider call succeeds again', async () => {
    const { daemon, pending } = await loadModules();
    pending.savePendingSummary('kept-1');
    pending.savePendingSummary('kept-2');
    mocks.generate.mockResolvedValue({ text: '- ok', metadata: {} });

    await summarize(daemon, 'fresh');

    await vi.waitFor(() => expect(mocks.summarized).toEqual(['fresh', 'kept-1', 'kept-2']));
    expect(pending.listPendingSummaries()).toEqual([]);
  });

  it('puts a kept session back when the breaker reopens during the drain', async () => {
    const { daemon, pending, CliProviderError } = await loadModules();
    pending.savePendingSummary('kept-1');
    pending.savePendingSummary('kept-2');
    mocks.generate
      .mockResolvedValueOnce({ text: '- ok', metadata: {} })
      .mockResolvedValueOnce({ text: '- ok', metadata: {} })
      .mockRejectedValue(new CliProviderError('skipped', 'provider-circuit-open'));

    await summarize(daemon, 'fresh');

    await vi.waitFor(() => expect(mocks.summarized).toEqual(['fresh', 'kept-1', 'kept-2']));
    await vi.waitFor(() => expect(pending.listPendingSummaries().map((entry) => entry.sessionId)).toEqual(['kept-2']));
  });

  it('leaves the queue alone while the breaker is still open', async () => {
    const { daemon, pending, CliProviderError } = await loadModules();
    pending.savePendingSummary('kept-1');
    mocks.generate.mockRejectedValue(new CliProviderError('skipped', 'provider-circuit-open'));

    await summarize(daemon, 'fresh');

    await vi.waitFor(() => expect(pending.listPendingSummaries().map((entry) => entry.sessionId)).toEqual(['kept-1', 'fresh']));
    expect(mocks.summarized).toEqual(['fresh']);
  });
});
