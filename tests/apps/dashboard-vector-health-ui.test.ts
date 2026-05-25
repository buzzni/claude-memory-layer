import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';

class TestElement {
  innerHTML = '';
  textContent = '';
  className = '';
  disabled = false;
  style: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
}

function loadOverviewWithElements(
  elements: Record<string, TestElement>,
  fetchImpl: (url: string, init?: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }> = async () => ({ ok: true, json: async () => ({}) })
) {
  const dashboardDir = join(process.cwd(), 'src/apps/dashboard/assets/js');
  const source = ['state.js', 'views.js', 'overview.js']
    .map(file => readFileSync(join(dashboardDir, file), 'utf-8'))
    .join('\n');
  const context = {
    console,
    URL,
    ApexCharts: function () { return { render() {}, destroy() {} }; },
    fetch: fetchImpl,
    window: { location: { origin: 'http://localhost:37777' } },
    document: {
      addEventListener() {},
      getElementById(id: string) { return elements[id] ?? null; },
      querySelectorAll() { return []; },
      querySelector() { return null; },
    },
  };

  vm.runInNewContext(
    `${source}\n;globalThis.__dashboardTestHooks = { state, loadVectorHealthData, updateVectorHealthUI, recoverVectorHealth };`,
    context
  );
  return (context as unknown as { __dashboardTestHooks: {
    state: Record<string, any>;
    loadVectorHealthData: () => Promise<void>;
    updateVectorHealthUI: () => void;
    recoverVectorHealth: () => Promise<void>;
  }}).__dashboardTestHooks;
}

function healthPayload() {
  return {
    status: 'needs-attention',
    timestamp: '2026-05-25T15:00:00.000Z',
    storage: {
      totalEvents: 123,
      vectorCount: 456,
      rawPath: 'PRIVATE_STORAGE_PATH_SENTINEL'
    },
    outbox: {
      embedding: { pending: 1, processing: 2, failed: 3, stuckProcessing: 1, oldestProcessingAgeMs: 120_000, total: 12, rawError: 'PRIVATE_EMBED_ERROR_SENTINEL' },
      vector: { pending: 4, processing: 5, failed: 6, stuckProcessing: 2, oldestProcessingAgeMs: 245_000, total: 34, rowId: 'PRIVATE_VECTOR_ROW_ID_SENTINEL', itemId: 'PRIVATE_ITEM_ID_SENTINEL', sourceContent: 'PRIVATE_SOURCE_CONTENT_SENTINEL' },
      totals: { pending: 5, processing: 7, failed: 9, stuckProcessing: 3, oldestProcessingAgeMs: 245_000, rawIds: ['PRIVATE_TOTAL_ROW_ID_SENTINEL'] }
    },
    levelStats: []
  };
}

describe('dashboard vector health panel', () => {
  it('loads vector health from the aggregate health API using the current project scope', async () => {
    const requested: Array<{ url: string; init?: RequestInit }> = [];
    const hooks = loadOverviewWithElements({}, async (url, init) => {
      requested.push({ url, init });
      return { ok: true, json: async () => healthPayload() };
    });
    hooks.state.currentProject = 'project-safe-hash';

    await hooks.loadVectorHealthData();

    expect(requested).toHaveLength(1);
    const url = new URL(requested[0].url);
    expect(url.pathname).toBe('/api/health');
    expect(url.searchParams.get('project')).toBe('project-safe-hash');
    expect(requested[0].init?.method).toBeUndefined();
    expect(hooks.state.vectorHealth?.outbox?.vector?.pending).toBe(4);
  });

  it('renders aggregate-only vector health and ignores raw/private fields', () => {
    const elements = {
      'vector-health-summary': new TestElement(),
      'vector-health-queue-list': new TestElement(),
      'vector-health-recovery-result': new TestElement(),
    };
    const hooks = loadOverviewWithElements(elements);

    hooks.state.vectorHealth = healthPayload();
    hooks.state.vectorHealthRecovery = {
      status: 'ok',
      timestamp: '2026-05-25T15:01:00.000Z',
      recovered: {
        embedding: { recoveredProcessing: 1, retriedFailed: 2, rawError: 'PRIVATE_RECOVERY_EMBED_ERROR_SENTINEL' },
        vector: { recoveredProcessing: 3, retriedFailed: 4, itemIds: ['PRIVATE_RECOVERY_ITEM_ID_SENTINEL'] }
      },
      after: healthPayload()
    };

    hooks.updateVectorHealthUI();

    const html = Object.values(elements).map(el => `${el.innerHTML} ${el.textContent}`).join('\n');
    expect(elements['vector-health-summary'].innerHTML).toContain('needs-attention');
    expect(elements['vector-health-summary'].innerHTML).toContain('456 vectors');
    expect(elements['vector-health-summary'].innerHTML).toContain('5 pending');
    expect(elements['vector-health-summary'].innerHTML).toContain('9 failed');
    expect(elements['vector-health-summary'].innerHTML).toContain('3 stuck');
    expect(elements['vector-health-queue-list'].innerHTML).toContain('Embedding Outbox');
    expect(elements['vector-health-queue-list'].innerHTML).toContain('Vector Outbox');
    expect(elements['vector-health-queue-list'].innerHTML).toContain('pending 4');
    expect(elements['vector-health-queue-list'].innerHTML).toContain('failed 6');
    expect(elements['vector-health-recovery-result'].innerHTML).toContain('Last recovery');
    expect(elements['vector-health-recovery-result'].innerHTML).toContain('embedding=3');
    expect(elements['vector-health-recovery-result'].innerHTML).toContain('vector=7');

    for (const privateSentinel of [
      'PRIVATE_STORAGE_PATH_SENTINEL',
      'PRIVATE_EMBED_ERROR_SENTINEL',
      'PRIVATE_VECTOR_ROW_ID_SENTINEL',
      'PRIVATE_ITEM_ID_SENTINEL',
      'PRIVATE_SOURCE_CONTENT_SENTINEL',
      'PRIVATE_TOTAL_ROW_ID_SENTINEL',
      'PRIVATE_RECOVERY_EMBED_ERROR_SENTINEL',
      'PRIVATE_RECOVERY_ITEM_ID_SENTINEL'
    ]) {
      expect(html).not.toContain(privateSentinel);
    }
  });

  it('posts a sanitized recovery request and refreshes aggregate health state', async () => {
    const elements = {
      'vector-health-summary': new TestElement(),
      'vector-health-queue-list': new TestElement(),
      'vector-health-recovery-result': new TestElement(),
      'vector-health-recover-btn': new TestElement(),
    };
    const requested: Array<{ url: string; init?: RequestInit }> = [];
    const hooks = loadOverviewWithElements(elements, async (url, init) => {
      requested.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          status: 'ok',
          timestamp: '2026-05-25T15:02:00.000Z',
          recovered: {
            embedding: { recoveredProcessing: 1, retriedFailed: 0 },
            vector: { recoveredProcessing: 2, retriedFailed: 1 }
          },
          after: {
            storage: { totalEvents: 123, vectorCount: 456 },
            outbox: {
              embedding: { pending: 0, processing: 0, failed: 0, stuckProcessing: 0, oldestProcessingAgeMs: null, total: 10 },
              vector: { pending: 1, processing: 0, failed: 0, stuckProcessing: 0, oldestProcessingAgeMs: null, total: 20 }
            }
          }
        })
      };
    });
    hooks.state.currentProject = 'project-safe-hash';

    await hooks.recoverVectorHealth();

    expect(requested).toHaveLength(1);
    const request = requested[0];
    const url = new URL(request.url);
    expect(url.pathname).toBe('/api/health/recover');
    expect(url.searchParams.get('project')).toBe('project-safe-hash');
    expect(request.init?.method).toBe('POST');
    expect(hooks.state.vectorHealthRecoveryProject).toBe('project-safe-hash');
    expect(hooks.state.vectorHealthRecovery?.recovered?.vector?.retriedFailed).toBe(1);
    expect(hooks.state.vectorHealth?.outbox?.vector?.pending).toBe(1);
    expect(elements['vector-health-recovery-result'].innerHTML).toContain('Last recovery');
    expect(elements['vector-health-recovery-result'].innerHTML).toContain('vector=3');
  });

  it('derives post-recovery health status from remaining aggregate outbox problems', async () => {
    const elements = {
      'vector-health-summary': new TestElement(),
      'vector-health-queue-list': new TestElement(),
      'vector-health-recovery-result': new TestElement(),
      'vector-health-recover-btn': new TestElement(),
    };
    const hooks = loadOverviewWithElements(elements, async () => ({
      ok: true,
      json: async () => ({
        status: 'ok',
        timestamp: '2026-05-25T15:03:00.000Z',
        recovered: {
          embedding: { recoveredProcessing: 0, retriedFailed: 0 },
          vector: { recoveredProcessing: 0, retriedFailed: 1 }
        },
        after: {
          storage: { totalEvents: 123, vectorCount: 456 },
          outbox: {
            embedding: { pending: 0, processing: 0, failed: 0, stuckProcessing: 0, oldestProcessingAgeMs: null, total: 10 },
            vector: { pending: 0, processing: 2, failed: 1, stuckProcessing: 2, oldestProcessingAgeMs: 300_000, total: 20 }
          }
        }
      })
    }));

    await hooks.recoverVectorHealth();

    expect(hooks.state.vectorHealth?.status).toBe('needs-attention');
    expect(elements['vector-health-summary'].innerHTML).toContain('needs-attention');
    expect(elements['vector-health-summary'].innerHTML).toContain('1 failed');
    expect(elements['vector-health-summary'].innerHTML).toContain('2 stuck');
  });

  it('does not display recovery results from a different project scope', () => {
    const elements = {
      'vector-health-summary': new TestElement(),
      'vector-health-queue-list': new TestElement(),
      'vector-health-recovery-result': new TestElement(),
    };
    const hooks = loadOverviewWithElements(elements);
    hooks.state.currentProject = 'project-b';
    hooks.state.vectorHealth = healthPayload();
    hooks.state.vectorHealthRecoveryProject = 'project-a';
    hooks.state.vectorHealthRecovery = {
      status: 'ok',
      timestamp: '2026-05-25T15:01:00.000Z',
      recovered: {
        embedding: { recoveredProcessing: 1, retriedFailed: 2 },
        vector: { recoveredProcessing: 3, retriedFailed: 4 }
      }
    };

    hooks.updateVectorHealthUI();

    expect(elements['vector-health-recovery-result'].innerHTML).toContain('No recovery run in this dashboard session.');
    expect(elements['vector-health-recovery-result'].innerHTML).not.toContain('vector=7');
  });

  it('defines dashboard containers for vector health monitoring', () => {
    const html = readFileSync(join(process.cwd(), 'src/apps/dashboard/index.html'), 'utf-8');

    expect(html).toContain('Vector Health');
    for (const id of [
      'vector-health-summary',
      'vector-health-queue-list',
      'vector-health-recovery-result',
      'vector-health-recover-btn'
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
