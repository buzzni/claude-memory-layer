/**
 * Health API
 * Operational health checks including outbox backlog/failures
 */

import { Hono } from 'hono';
import { spawnSync } from 'child_process';
import { getLightweightServiceFromQuery, getWritableServiceFromQuery } from './utils.js';

export const healthRouter = new Hono();

type SetupHealthStatus = 'ok' | 'needs-setup' | 'needs-attention' | 'error';

function hasEnvSignal(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

function claudeAuthSignal(): 'env-present' | 'not-detected' {
  return hasEnvSignal('ANTHROPIC_API_KEY') || hasEnvSignal('CLAUDE_API_KEY') || hasEnvSignal('CLAUDE_CODE_OAUTH_TOKEN')
    ? 'env-present'
    : 'not-detected';
}

function detectClaudeCli(): { status: 'available' | 'missing' | 'error'; command: 'claude'; authSignal: 'env-present' | 'not-detected'; version?: string } {
  const result = spawnSync('claude', ['--version'], {
    encoding: 'utf-8',
    timeout: 3_000,
  });

  const authSignal = claudeAuthSignal();
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === 'ENOENT') {
    return { status: 'missing', command: 'claude', authSignal };
  }
  if (result.status === 0) {
    const version = String(result.stdout || '').split('\n')[0]?.trim().slice(0, 80) || undefined;
    return { status: 'available', command: 'claude', authSignal, ...(version ? { version } : {}) };
  }
  return { status: 'error', command: 'claude', authSignal };
}

function detectEmbeddingBackend(): { status: 'enabled' | 'disabled'; backend: '@huggingface/transformers' } {
  const disabled = ['1', 'true', 'yes'].includes(String(process.env.CLAUDE_MEMORY_DISABLE_VECTOR || '').toLowerCase());
  return {
    status: disabled ? 'disabled' : 'enabled',
    backend: '@huggingface/transformers',
  };
}

function aggregateOutbox(outbox: Awaited<ReturnType<Awaited<ReturnType<typeof getLightweightServiceFromQuery>>['getOutboxStats']>>) {
  const pending = (outbox.embedding?.pending || 0) + (outbox.vector?.pending || 0);
  const processing = (outbox.embedding?.processing || 0) + (outbox.vector?.processing || 0);
  const failed = (outbox.embedding?.failed || 0) + (outbox.vector?.failed || 0);
  const stuckProcessing = (outbox.embedding?.stuckProcessing || 0) + (outbox.vector?.stuckProcessing || 0);
  return { pending, processing, failed, stuckProcessing };
}

// GET /api/health/setup
// Aggregate-only install/provider readiness for dashboard setup guidance.
healthRouter.get('/setup', async (c) => {
  const memoryService = getLightweightServiceFromQuery(c);
  try {
    await memoryService.initialize();
    const [stats, outbox] = await Promise.all([
      memoryService.getStats(),
      memoryService.getOutboxStats()
    ]);

    const outboxTotals = aggregateOutbox(outbox);
    const claudeCli = detectClaudeCli();
    const embeddings = detectEmbeddingBackend();
    const recommendations: string[] = [];

    if (claudeCli.status !== 'available') {
      recommendations.push('Install or authenticate Claude CLI to enable Ask Memory assistant responses.');
    }
    if (embeddings.status === 'disabled') {
      recommendations.push('Enable vector embeddings to improve semantic retrieval and memory usefulness.');
    }
    if (outboxTotals.failed > 0 || outboxTotals.stuckProcessing > 0) {
      recommendations.push('Run vector health recovery before trusting retrieval freshness.');
    }

    let status: SetupHealthStatus = 'ok';
    if (claudeCli.status !== 'available' || embeddings.status === 'disabled') {
      status = 'needs-setup';
    } else if (outboxTotals.failed > 0 || outboxTotals.stuckProcessing > 0) {
      status = 'needs-attention';
    }

    const scoped = Boolean(c.req.query('project') || c.req.query('projectId'));
    return c.json({
      status,
      timestamp: new Date().toISOString(),
      setup: {
        scope: scoped ? 'project' : 'global',
        storage: {
          status: 'ok',
          totalEvents: stats.totalEvents,
          vectorCount: stats.vectorCount,
        },
        outbox: outboxTotals,
      },
      providers: {
        claudeCli,
        embeddings,
      },
      recommendations,
    });
  } catch {
    return c.json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: 'Setup health check failed'
    }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/health
healthRouter.get('/', async (c) => {
  const memoryService = getLightweightServiceFromQuery(c);
  try {
    await memoryService.initialize();

    const [stats, outbox] = await Promise.all([
      memoryService.getStats(),
      memoryService.getOutboxStats()
    ]);

    const outboxPending = outbox.embedding.pending + outbox.vector.pending;
    const outboxProcessing = outbox.embedding.processing + outbox.vector.processing;
    const outboxFailed = outbox.embedding.failed + outbox.vector.failed;
    const outboxStuckProcessing = outbox.embedding.stuckProcessing + outbox.vector.stuckProcessing;
    const oldestProcessingAgeMs = Math.max(
      outbox.embedding.oldestProcessingAgeMs ?? 0,
      outbox.vector.oldestProcessingAgeMs ?? 0
    ) || null;

    const status = outboxFailed > 0 || outboxStuckProcessing > 0 ? 'needs-attention' : 'ok';

    return c.json({
      status,
      timestamp: new Date().toISOString(),
      storage: {
        totalEvents: stats.totalEvents,
        vectorCount: stats.vectorCount
      },
      outbox: {
        embedding: outbox.embedding,
        vector: outbox.vector,
        totals: {
          pending: outboxPending,
          processing: outboxProcessing,
          failed: outboxFailed,
          stuckProcessing: outboxStuckProcessing,
          oldestProcessingAgeMs
        }
      },
      levelStats: stats.levelStats
    });
  } catch {
    return c.json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: 'Health check failed'
    }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// POST /api/health/recover
// Recover stale processing/failed outbox work before another worker pass.
healthRouter.post('/recover', async (c) => {
  const memoryService = getWritableServiceFromQuery(c);
  try {
    await memoryService.initialize();

    const body = await c.req.json().catch(() => ({})) as {
      stuckThresholdMs?: unknown;
      maxRetries?: unknown;
    };
    const options: { stuckThresholdMs?: number; maxRetries?: number } = {};
    if (typeof body.stuckThresholdMs === 'number' && Number.isFinite(body.stuckThresholdMs)) {
      options.stuckThresholdMs = body.stuckThresholdMs;
    }
    if (typeof body.maxRetries === 'number' && Number.isFinite(body.maxRetries)) {
      options.maxRetries = body.maxRetries;
    }

    const before = await memoryService.getOutboxStats();
    const recovered = await memoryService.recoverStuckOutboxItems(options);
    const [stats, outbox] = await Promise.all([
      memoryService.getStats(),
      memoryService.getOutboxStats()
    ]);

    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      recovered,
      before: {
        outbox: before
      },
      after: {
        storage: {
          totalEvents: stats.totalEvents,
          vectorCount: stats.vectorCount
        },
        outbox
      }
    });
  } catch {
    return c.json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: 'Outbox recovery failed'
    }, 500);
  } finally {
    await memoryService.shutdown();
  }
});
