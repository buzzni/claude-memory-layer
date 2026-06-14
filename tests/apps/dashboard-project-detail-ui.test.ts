import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';

class TestElement {
  innerHTML = '';
  textContent = '';
  hidden = false;
  style: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
}

function loadOverviewWithElements(
  elements: Record<string, TestElement>,
  fetchImpl: (url: string, init?: RequestInit) => Promise<{ ok?: boolean; json: () => Promise<unknown> }>
) {
  const dashboardDir = join(process.cwd(), 'src/apps/dashboard/assets/js');
  const source = ['state.js', 'views.js', 'overview.js']
    .map(file => readFileSync(join(dashboardDir, file), 'utf-8'))
    .join('\n');
  const context = {
    console,
    URL,
    fetch: fetchImpl,
    window: { location: { origin: 'http://localhost:37777' } },
    document: {
      addEventListener() {},
      getElementById(id: string) { return elements[id] ?? null; },
      querySelectorAll() { return []; },
      querySelector() { return null; },
    },
    ApexCharts: class { render() {} destroy() {} },
  };

  vm.runInNewContext(
    `${source}\n;globalThis.__dashboardTestHooks = { state, loadProjectDetailData, updateProjectDetailUI };`,
    context
  );
  return (context as unknown as { __dashboardTestHooks: {
    state: Record<string, any>;
    loadProjectDetailData: () => Promise<void>;
    updateProjectDetailUI: () => void;
  }}).__dashboardTestHooks;
}

describe('dashboard project detail card', () => {
  it('has a stable overview mount point for project detail', () => {
    const html = readFileSync(join(process.cwd(), 'src/apps/dashboard/index.html'), 'utf-8');
    expect(html).toContain('id="project-detail-card"');
    expect(html).toContain('Project Detail');
  });

  it('loads selected project detail and renders aggregate-only metrics', async () => {
    const card = new TestElement();
    const requested: string[] = [];
    const hooks = loadOverviewWithElements({ 'project-detail-card': card }, async (url) => {
      requested.push(url);
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/api/projects/project-safe-hash/detail');
      return { json: async () => ({
        project: { hash: 'project-safe-hash', projectName: 'shop-app', registered: true, projectPath: '/PRIVATE/PATH/SHOULD_NOT_LEAK' },
        storage: { eventCount: 42, vectorCount: 31, rawPath: 'PRIVATE_STORAGE_PATH_SHOULD_NOT_LEAK' },
        sessions: { total: 7 },
        eventTypes: { user_prompt: 5, agent_response: 4 },
        sources: { hermes: 6, codex: 3 },
        retrieval: { totalQueries: 9, selectionRate: 0.37, rawQuery: 'PRIVATE_QUERY_SHOULD_NOT_LEAK' },
        outbox: { pending: 3, processing: 1, failed: 0, stuckProcessing: 0, rawIds: ['PRIVATE_OUTBOX_ID_SHOULD_NOT_LEAK'] },
      }) };
    });
    hooks.state.currentProject = 'project-safe-hash';

    await hooks.loadProjectDetailData();
    hooks.updateProjectDetailUI();

    expect(requested).toHaveLength(1);
    const request = new URL(requested[0]);
    expect(request.searchParams.get('project')).toBe('project-safe-hash');
    expect(card.hidden).toBe(false);
    expect(card.innerHTML).toContain('Project Detail');
    expect(card.innerHTML).toContain('shop-app');
    expect(card.innerHTML).toContain('42 events');
    expect(card.innerHTML).toContain('7 sessions');
    expect(card.innerHTML).toContain('31 vectors');
    expect(card.innerHTML).toContain('37.0% selection');
    expect(card.innerHTML).toContain('3 pending');
    expect(card.innerHTML).toContain('user_prompt');
    expect(card.innerHTML).toContain('hermes');

    for (const privateSentinel of [
      '/PRIVATE/PATH/SHOULD_NOT_LEAK',
      'PRIVATE_STORAGE_PATH_SHOULD_NOT_LEAK',
      'PRIVATE_QUERY_SHOULD_NOT_LEAK',
      'PRIVATE_OUTBOX_ID_SHOULD_NOT_LEAK',
    ]) {
      expect(card.innerHTML).not.toContain(privateSentinel);
    }
  });
});
