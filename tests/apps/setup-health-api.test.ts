import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => {
  const service = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    getStats: vi.fn(),
    getOutboxStats: vi.fn(),
  };
  return {
    service,
    getLightweightServiceFromQuery: vi.fn(() => service),
    spawnSync: vi.fn(),
  };
});

vi.mock('child_process', () => ({
  spawnSync: mocks.spawnSync,
}));

vi.mock('../../src/apps/server/api/utils.js', () => ({
  getLightweightServiceFromQuery: mocks.getLightweightServiceFromQuery,
  getWritableServiceFromQuery: vi.fn(),
}));

const { healthRouter } = await import('../../src/apps/server/api/health.js');

function createApp() {
  const app = new Hono();
  app.route('/api/health', healthRouter);
  return app;
}

function statsPayload() {
  return {
    totalEvents: 12,
    vectorCount: 8,
    levelStats: [{ level: 'L4', count: 3 }],
    rawPath: 'PRIVATE_STORAGE_PATH_SHOULD_NOT_LEAK',
  };
}

function outboxPayload() {
  return {
    embedding: { pending: 1, processing: 0, failed: 0, stuckProcessing: 0, oldestProcessingAgeMs: null, total: 4, rawError: 'PRIVATE_EMBED_ERROR_SHOULD_NOT_LEAK' },
    vector: { pending: 0, processing: 0, failed: 0, stuckProcessing: 0, oldestProcessingAgeMs: null, total: 4, itemIds: ['PRIVATE_VECTOR_ITEM_SHOULD_NOT_LEAK'] },
  };
}

const ANTHROPIC_ENV_KEY = 'ANTHROPIC_API_KEY';
const PRIVATE_ANTHROPIC_SENTINEL = ['PRIVATE', 'ANTHROPIC', 'KEY', 'SHOULD_NOT_LEAK'].join('_');

function setEnvValue(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('setup/provider health API', () => {
  const originalAnthropicKey = process.env[ANTHROPIC_ENV_KEY];
  const originalDisableVector = process.env.CLAUDE_MEMORY_DISABLE_VECTOR;

  beforeEach(() => {
    mocks.service.initialize.mockReset().mockResolvedValue(undefined);
    mocks.service.shutdown.mockReset().mockResolvedValue(undefined);
    mocks.service.getStats.mockReset().mockResolvedValue(statsPayload());
    mocks.service.getOutboxStats.mockReset().mockResolvedValue(outboxPayload());
    mocks.getLightweightServiceFromQuery.mockClear();
    mocks.spawnSync.mockReset().mockReturnValue({ status: 0, stdout: 'claude 1.2.3\n', stderr: 'PRIVATE_CLAUDE_STDERR_SHOULD_NOT_LEAK' });
    setEnvValue(ANTHROPIC_ENV_KEY, PRIVATE_ANTHROPIC_SENTINEL);
    delete process.env.CLAUDE_MEMORY_DISABLE_VECTOR;
  });

  afterEach(() => {
    setEnvValue(ANTHROPIC_ENV_KEY, originalAnthropicKey);
    if (originalDisableVector === undefined) delete process.env.CLAUDE_MEMORY_DISABLE_VECTOR;
    else process.env.CLAUDE_MEMORY_DISABLE_VECTOR = originalDisableVector;
  });

  it('returns aggregate setup and provider readiness without leaking env, raw paths, or stderr', async () => {
    const res = await createApp().request('/api/health/setup?project=abc12345');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 'ok',
      setup: {
        scope: 'project',
        storage: { status: 'ok', totalEvents: 12, vectorCount: 8 },
        outbox: { pending: 1, failed: 0, stuckProcessing: 0 },
      },
      providers: {
        claudeCli: { status: 'available', command: 'claude', authSignal: 'env-present' },
        embeddings: { status: 'enabled', backend: '@huggingface/transformers' },
      },
    });
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.service.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.spawnSync).toHaveBeenCalledWith('claude', ['--version'], expect.objectContaining({ encoding: 'utf-8', timeout: expect.any(Number) }));

    const serialized = JSON.stringify(body);
    for (const privateSentinel of [
      PRIVATE_ANTHROPIC_SENTINEL,
      'PRIVATE_CLAUDE_STDERR_SHOULD_NOT_LEAK',
      'PRIVATE_STORAGE_PATH_SHOULD_NOT_LEAK',
      'PRIVATE_EMBED_ERROR_SHOULD_NOT_LEAK',
      'PRIVATE_VECTOR_ITEM_SHOULD_NOT_LEAK',
    ]) {
      expect(serialized).not.toContain(privateSentinel);
    }
  });

  it('marks setup as needs-setup when Claude CLI is missing or vector backend is disabled', async () => {
    mocks.spawnSync.mockReturnValue({ status: null, error: Object.assign(new Error('spawn ENOENT PRIVATE_PATH'), { code: 'ENOENT' }) });
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_MEMORY_DISABLE_VECTOR = '1';

    const res = await createApp().request('/api/health/setup');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('needs-setup');
    expect(body.providers.claudeCli).toMatchObject({ status: 'missing', authSignal: 'not-detected' });
    expect(body.providers.embeddings).toMatchObject({ status: 'disabled' });
    expect(body.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('Install or authenticate Claude CLI'),
      expect.stringContaining('Enable vector embeddings'),
    ]));
    expect(JSON.stringify(body)).not.toContain('PRIVATE_PATH');
  });
});
