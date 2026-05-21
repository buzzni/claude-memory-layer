import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';

class TestElement {
  innerHTML = '';
  textContent = '';
  className = '';
  style: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
}

function loadOverviewWithElements(
  elements: Record<string, TestElement>,
  fetchImpl: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }> = async () => ({ ok: true, json: async () => ({}) })
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
    `${source}\n;globalThis.__dashboardTestHooks = { state, loadOperationsStatsData, updateOperationsStatsUI };`,
    context
  );
  return (context as unknown as { __dashboardTestHooks: {
    state: Record<string, any>;
    loadOperationsStatsData: () => Promise<void>;
    updateOperationsStatsUI: () => void;
  }}).__dashboardTestHooks;
}

function operationsPayload() {
  return {
    generatedAt: '2026-05-21T12:00:00.000Z',
    windowDays: 7,
    projectHash: 'project-safe-hash',
    projection: { databaseExists: true, available: true, missingTables: [] },
    facets: {
      totalAssignments: 5,
      distribution: [
        { dimension: 'topic', values: [{ value: 'api', count: 2 }, { value: 'ops', count: 1 }], other: 1 },
        { dimension: 'runtime', values: [{ value: '[REDACTED]', count: 1 }], other: 0 }
      ],
      rawFacetValue: '/Users/alice/private-project password=dk'
    },
    actions: {
      total: 4,
      byStatus: [{ status: 'pending', count: 2 }, { status: 'done', count: 1 }, { status: 'in_progress', count: 1 }],
      title: 'raw action title password=dk'
    },
    leases: {
      totalActive: 2,
      activeByTargetType: [{ targetType: 'action', count: 1 }, { targetType: 'routine', count: 1 }],
      targetId: 'action-private-target'
    },
    retention: {
      total: 3,
      byDecision: [{ decision: 'keep', count: 2 }, { decision: 'review', count: 1 }],
      dryRunDiffJson: '{"path":"/Users/alice/private-project"}'
    },
    governanceAudit: {
      total: 3,
      operationsByDay: [
        { date: '2026-05-20', total: 2, operations: [{ operation: 'action_update', count: 1 }, { operation: 'facet_tag', count: 1 }] },
        { date: '2026-05-21', total: 1, operations: [{ operation: 'lesson_promote', count: 1 }] }
      ],
      sourceEventIds: ['source-private-token=dk']
    },
    lessons: {
      total: 4,
      confidenceBuckets: [
        { bucket: '0.00-0.25', count: 1 },
        { bucket: '0.25-0.50', count: 1 },
        { bucket: '0.50-0.75', count: 1 },
        { bucket: '0.75-1.00', count: 1 }
      ],
      text: 'raw lesson text token=dk'
    }
  };
}

describe('dashboard operations aggregate cards', () => {
  it('renders aggregate-only operation cards and ignores raw/private fields', () => {
    const elements = {
      'operations-stats-summary': new TestElement(),
      'operations-facets-list': new TestElement(),
      'operations-actions-list': new TestElement(),
      'operations-leases-list': new TestElement(),
      'operations-retention-list': new TestElement(),
      'operations-governance-list': new TestElement(),
      'operations-lessons-list': new TestElement(),
    };
    const hooks = loadOverviewWithElements(elements);

    hooks.state.operationsStats = operationsPayload();
    hooks.updateOperationsStatsUI();

    const html = Object.values(elements).map(el => `${el.innerHTML} ${el.textContent}`).join('\n');
    expect(elements['operations-stats-summary'].innerHTML).toContain('5 facets');
    expect(elements['operations-stats-summary'].innerHTML).toContain('4 actions');
    expect(elements['operations-stats-summary'].innerHTML).toContain('2 active leases');
    expect(elements['operations-facets-list'].innerHTML).toContain('topic');
    expect(elements['operations-facets-list'].innerHTML).toContain('runtime');
    expect(elements['operations-facets-list'].innerHTML).toContain('3 value buckets');
    expect(elements['operations-facets-list'].innerHTML).not.toContain('api');
    expect(elements['operations-facets-list'].innerHTML).not.toContain('ops');
    expect(elements['operations-facets-list'].innerHTML).not.toContain('[REDACTED]');
    expect(elements['operations-actions-list'].innerHTML).toContain('pending');
    expect(elements['operations-actions-list'].innerHTML).toContain('done');
    expect(elements['operations-leases-list'].innerHTML).toContain('action');
    expect(elements['operations-retention-list'].innerHTML).toContain('keep');
    expect(elements['operations-governance-list'].innerHTML).toContain('2026-05-20');
    expect(elements['operations-governance-list'].innerHTML).toContain('action_update');
    expect(elements['operations-lessons-list'].innerHTML).toContain('0.75-1.00');

    expect(html).not.toContain('/Users/alice/private-project');
    expect(html).not.toContain('password=dk');
    expect(html).not.toContain('token=dk');
    expect(html).not.toContain('raw action title');
    expect(html).not.toContain('action-private-target');
    expect(html).not.toContain('source-private');
    expect(html).not.toContain('raw lesson text');
    expect(html).not.toContain('dryRunDiffJson');
  });

  it('loads operation stats from the aggregate API using the current project scope', async () => {
    const requestedUrls: string[] = [];
    const hooks = loadOverviewWithElements({}, async (url) => {
      requestedUrls.push(url);
      return { ok: true, json: async () => operationsPayload() };
    });
    hooks.state.currentProject = 'project-safe-hash';

    await hooks.loadOperationsStatsData();

    expect(requestedUrls).toHaveLength(1);
    let url = new URL(requestedUrls[0]);
    expect(url.pathname).toBe('/api/stats/operations');
    expect(url.searchParams.get('project')).toBe('project-safe-hash');
    expect(url.searchParams.get('windowDays')).toBe('7');
    expect(hooks.state.operationsStats?.actions?.total).toBe(4);

    hooks.state.kpiWindow = '30d';
    await hooks.loadOperationsStatsData();

    expect(requestedUrls).toHaveLength(2);
    url = new URL(requestedUrls[1]);
    expect(url.pathname).toBe('/api/stats/operations');
    expect(url.searchParams.get('project')).toBe('project-safe-hash');
    expect(url.searchParams.get('windowDays')).toBe('30');
  });

  it('clears previously rendered aggregates when operations stats fail to load', () => {
    const elements = {
      'operations-stats-summary': new TestElement(),
      'operations-facets-list': new TestElement(),
      'operations-actions-list': new TestElement(),
      'operations-leases-list': new TestElement(),
      'operations-retention-list': new TestElement(),
      'operations-governance-list': new TestElement(),
      'operations-lessons-list': new TestElement(),
    };
    const hooks = loadOverviewWithElements(elements);

    hooks.state.operationsStats = operationsPayload();
    hooks.updateOperationsStatsUI();
    expect(elements['operations-facets-list'].innerHTML).toContain('topic');
    expect(elements['operations-actions-list'].innerHTML).toContain('pending');
    expect(elements['operations-governance-list'].innerHTML).toContain('2026-05-20');

    hooks.state.operationsStats = null;
    hooks.updateOperationsStatsUI();

    const html = Object.values(elements).map(el => `${el.innerHTML} ${el.textContent}`).join('\n');
    expect(elements['operations-stats-summary'].innerHTML).toContain('Operation aggregates unavailable');
    expect(elements['operations-facets-list'].innerHTML).toContain('Operation aggregate data unavailable');
    expect(elements['operations-actions-list'].innerHTML).toContain('Operation aggregate data unavailable');
    expect(html).not.toContain('topic');
    expect(html).not.toContain('pending');
    expect(html).not.toContain('2026-05-20');
  });

  it('renders an empty state when operation projections are unavailable', () => {
    const elements = {
      'operations-stats-summary': new TestElement(),
      'operations-facets-list': new TestElement(),
      'operations-actions-list': new TestElement(),
      'operations-leases-list': new TestElement(),
      'operations-retention-list': new TestElement(),
      'operations-governance-list': new TestElement(),
      'operations-lessons-list': new TestElement(),
    };
    const hooks = loadOverviewWithElements(elements);

    hooks.state.operationsStats = {
      projection: { databaseExists: true, available: false, missingTables: ['memory_facets'] },
      facets: { totalAssignments: 0, distribution: [] },
      actions: { total: 0, byStatus: [] },
      leases: { totalActive: 0, activeByTargetType: [] },
      retention: { total: 0, byDecision: [] },
      governanceAudit: { total: 0, operationsByDay: [] },
      lessons: { total: 0, confidenceBuckets: [] }
    };
    hooks.updateOperationsStatsUI();

    expect(elements['operations-stats-summary'].innerHTML).toContain('Operation projections unavailable');
    expect(elements['operations-facets-list'].innerHTML).toContain('No facet aggregates');
    expect(elements['operations-actions-list'].innerHTML).toContain('No action status data');
    expect(elements['operations-leases-list'].innerHTML).toContain('No active leases');
  });

  it('defines dashboard containers for every operation aggregate card', () => {
    const html = readFileSync(join(process.cwd(), 'src/apps/dashboard/index.html'), 'utf-8');

    expect(html).toContain('Memory Operations');
    for (const id of [
      'operations-stats-summary',
      'operations-facets-list',
      'operations-actions-list',
      'operations-leases-list',
      'operations-retention-list',
      'operations-governance-list',
      'operations-lessons-list'
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
