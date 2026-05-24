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
    `${source}\n;globalThis.__dashboardTestHooks = { state, loadPerspectiveStatsData, updatePerspectiveStatsUI };`,
    context
  );
  return (context as unknown as { __dashboardTestHooks: {
    state: Record<string, any>;
    loadPerspectiveStatsData: () => Promise<void>;
    updatePerspectiveStatsUI: () => void;
  }}).__dashboardTestHooks;
}

function perspectivePayload() {
  return {
    generatedAt: '2026-05-21T12:00:00.000Z',
    windowDays: 7,
    projectHash: 'project-safe-hash',
    projection: { databaseExists: true, available: true, missingTables: [] },
    actors: {
      total: 3,
      byKind: [
        { kind: 'assistant', count: 1 },
        { kind: 'subagent', count: 1 },
        { kind: 'user', count: 1 }
      ],
      displayName: 'PRIVATE_DISPLAY_SENTINEL'
    },
    sessionActors: {
      total: 3,
      observeSelfEnabled: 2,
      observeOthersEnabled: 2,
      byRole: [
        { role: 'assistant', count: 1 },
        { role: 'observer', count: 1 },
        { role: 'speaker', count: 1 }
      ],
      metadata: 'PRIVATE_SESSION_METADATA_SENTINEL'
    },
    actorCards: {
      total: 1,
      totalEntries: 2,
      averageEntries: 2,
      fullCards: 0,
      entries: ['PRIVATE_CARD_ENTRY_SENTINEL']
    },
    observations: {
      total: 4,
      byLevel: [
        { level: 'explicit', count: 1 },
        { level: 'deductive', count: 1 },
        { level: 'inductive', count: 1 },
        { level: 'contradiction', count: 1 }
      ],
      byCreatedBy: [
        { createdBy: 'rule', count: 2 },
        { createdBy: 'manual', count: 1 },
        { createdBy: 'llm', count: 1 }
      ],
      content: 'PRIVATE_OBSERVATION_CONTENT_SENTINEL'
    },
    contradictions: {
      summary: { total: 1, returnedItems: 1 },
      items: [
        {
          observationId: 'obs-safe-id',
          observerActorId: 'actor:assistant:hermes',
          observedActorId: 'actor:user:founder',
          confidence: 0.88,
          sourceEventCount: 1,
          sourceObservationCount: 1,
          createdAt: '2026-05-21T12:00:00.000Z',
          updatedAt: '2026-05-21T12:00:00.000Z',
          content: 'PRIVATE_CONTRADICTION_CONTENT_SENTINEL'
        }
      ]
    },
    recentActivity: {
      byDay: [
        {
          date: '2026-05-21',
          total: 4,
          levels: [
            { level: 'explicit', count: 1 },
            { level: 'contradiction', count: 1 }
          ],
          rawSourceEventIds: ['event-private-sentinel']
        }
      ]
    }
  };
}

describe('dashboard perspective memory panel', () => {
  it('renders aggregate-only perspective cards and ignores raw/private fields', () => {
    const elements = {
      'perspective-stats-summary': new TestElement(),
      'perspective-actors-list': new TestElement(),
      'perspective-cards-list': new TestElement(),
      'perspective-observations-list': new TestElement(),
      'perspective-contradictions-list': new TestElement(),
      'perspective-activity-list': new TestElement(),
    };
    const hooks = loadOverviewWithElements(elements);

    hooks.state.perspectiveStats = perspectivePayload();
    hooks.updatePerspectiveStatsUI();

    const html = Object.values(elements).map(el => `${el.innerHTML} ${el.textContent}`).join('\n');
    expect(elements['perspective-stats-summary'].innerHTML).toContain('3 actors');
    expect(elements['perspective-stats-summary'].innerHTML).toContain('1 actor cards');
    expect(elements['perspective-stats-summary'].innerHTML).toContain('4 observations');
    expect(elements['perspective-stats-summary'].innerHTML).toContain('1 contradictions');
    expect(elements['perspective-actors-list'].innerHTML).toContain('assistant');
    expect(elements['perspective-actors-list'].innerHTML).toContain('speaker');
    expect(elements['perspective-cards-list'].innerHTML).toContain('2 entries');
    expect(elements['perspective-cards-list'].innerHTML).toContain('0 full cards');
    expect(elements['perspective-observations-list'].innerHTML).toContain('explicit');
    expect(elements['perspective-observations-list'].innerHTML).toContain('rule');
    expect(elements['perspective-contradictions-list'].innerHTML).toContain('obs-safe-id');
    expect(elements['perspective-contradictions-list'].innerHTML).toContain('88%');
    expect(elements['perspective-activity-list'].innerHTML).toContain('2026-05-21');

    expect(html).not.toContain('PRIVATE_DISPLAY_SENTINEL');
    expect(html).not.toContain('PRIVATE_SESSION_METADATA_SENTINEL');
    expect(html).not.toContain('PRIVATE_CARD_ENTRY_SENTINEL');
    expect(html).not.toContain('PRIVATE_OBSERVATION_CONTENT_SENTINEL');
    expect(html).not.toContain('PRIVATE_CONTRADICTION_CONTENT_SENTINEL');
    expect(html).not.toContain('event-private-sentinel');
  });

  it('loads perspective stats from the aggregate API using the current project scope', async () => {
    const requestedUrls: string[] = [];
    const hooks = loadOverviewWithElements({}, async (url) => {
      requestedUrls.push(url);
      return { ok: true, json: async () => perspectivePayload() };
    });
    hooks.state.currentProject = 'project-safe-hash';

    await hooks.loadPerspectiveStatsData();

    expect(requestedUrls).toHaveLength(1);
    let url = new URL(requestedUrls[0]);
    expect(url.pathname).toBe('/api/stats/perspective');
    expect(url.searchParams.get('project')).toBe('project-safe-hash');
    expect(url.searchParams.get('windowDays')).toBe('7');
    expect(hooks.state.perspectiveStats?.actors?.total).toBe(3);

    hooks.state.kpiWindow = '30d';
    await hooks.loadPerspectiveStatsData();

    expect(requestedUrls).toHaveLength(2);
    url = new URL(requestedUrls[1]);
    expect(url.pathname).toBe('/api/stats/perspective');
    expect(url.searchParams.get('windowDays')).toBe('30');
  });

  it('clears previously rendered aggregates when perspective stats fail to load', () => {
    const elements = {
      'perspective-stats-summary': new TestElement(),
      'perspective-actors-list': new TestElement(),
      'perspective-cards-list': new TestElement(),
      'perspective-observations-list': new TestElement(),
      'perspective-contradictions-list': new TestElement(),
      'perspective-activity-list': new TestElement(),
    };
    const hooks = loadOverviewWithElements(elements);

    hooks.state.perspectiveStats = perspectivePayload();
    hooks.updatePerspectiveStatsUI();
    expect(elements['perspective-actors-list'].innerHTML).toContain('assistant');

    hooks.state.perspectiveStats = null;
    hooks.updatePerspectiveStatsUI();

    const html = Object.values(elements).map(el => `${el.innerHTML} ${el.textContent}`).join('\n');
    expect(elements['perspective-stats-summary'].innerHTML).toContain('Perspective aggregates unavailable');
    expect(elements['perspective-actors-list'].innerHTML).toContain('Perspective aggregate data unavailable');
    expect(elements['perspective-observations-list'].innerHTML).toContain('Perspective aggregate data unavailable');
    expect(html).not.toContain('assistant');
    expect(html).not.toContain('obs-safe-id');
  });

  it('renders an empty state when perspective projections are unavailable', () => {
    const elements = {
      'perspective-stats-summary': new TestElement(),
      'perspective-actors-list': new TestElement(),
      'perspective-cards-list': new TestElement(),
      'perspective-observations-list': new TestElement(),
      'perspective-contradictions-list': new TestElement(),
      'perspective-activity-list': new TestElement(),
    };
    const hooks = loadOverviewWithElements(elements);

    hooks.state.perspectiveStats = {
      projection: { databaseExists: true, available: false, missingTables: ['actor_cards'] },
      actors: { total: 0, byKind: [] },
      sessionActors: { total: 0, observeSelfEnabled: 0, observeOthersEnabled: 0, byRole: [] },
      actorCards: { total: 0, totalEntries: 0, averageEntries: 0, fullCards: 0 },
      observations: { total: 0, byLevel: [], byCreatedBy: [] },
      contradictions: { summary: { total: 0, returnedItems: 0 }, items: [] },
      recentActivity: { byDay: [] }
    };
    hooks.updatePerspectiveStatsUI();

    expect(elements['perspective-stats-summary'].innerHTML).toContain('Perspective projections unavailable');
    expect(elements['perspective-actors-list'].innerHTML).toContain('No actor kind data');
    expect(elements['perspective-cards-list'].innerHTML).toContain('No actor card aggregates');
    expect(elements['perspective-contradictions-list'].innerHTML).toContain('No contradictions queued');
  });

  it('refreshes perspective stats when the shared KPI window changes', () => {
    const source = readFileSync(join(process.cwd(), 'src/apps/dashboard/assets/js/bootstrap.js'), 'utf-8');
    const kpiHandler = source.slice(source.indexOf('// KPI window controls'), source.indexOf('// Search'));

    expect(kpiHandler).toContain('await loadOperationsStatsData();');
    expect(kpiHandler).toContain('await loadPerspectiveStatsData();');
    expect(kpiHandler).toContain('updateOperationsStatsUI();');
    expect(kpiHandler).toContain('updatePerspectiveStatsUI();');
  });

  it('defines dashboard containers for every perspective memory card', () => {
    const html = readFileSync(join(process.cwd(), 'src/apps/dashboard/index.html'), 'utf-8');

    expect(html).toContain('Perspective Memory');
    for (const id of [
      'perspective-stats-summary',
      'perspective-actors-list',
      'perspective-cards-list',
      'perspective-observations-list',
      'perspective-contradictions-list',
      'perspective-activity-list'
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
