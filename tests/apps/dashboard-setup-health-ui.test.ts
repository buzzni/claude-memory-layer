import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';

class TestElement {
  innerHTML = '';
  textContent = '';
  value = '';
  checked = false;
  disabled = false;
  style: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
}

function loadViewsWithElements(
  elements: Record<string, TestElement>,
  fetchImpl: (url: string, init?: RequestInit) => Promise<{ ok?: boolean; json: () => Promise<unknown> }>
) {
  const dashboardDir = join(process.cwd(), 'src/apps/dashboard/assets/js');
  const source = ['state.js', 'views.js']
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
  };

  vm.runInNewContext(
    `${source}\n;globalThis.__dashboardTestHooks = { state, loadConfigurationView };`,
    context
  );
  return (context as unknown as { __dashboardTestHooks: {
    state: Record<string, any>;
    loadConfigurationView: () => Promise<void>;
  }}).__dashboardTestHooks;
}

describe('dashboard setup/provider health UI', () => {
  it('loads setup/provider health in project scope and renders aggregate-only status', async () => {
    const cfg = new TestElement();
    const requested: string[] = [];
    const hooks = loadViewsWithElements({ 'cfg-content': cfg }, async (url) => {
      requested.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/api/health/setup') {
        return { json: async () => ({
          status: 'needs-setup',
          setup: {
            scope: 'project',
            storage: { status: 'ok', totalEvents: 12, vectorCount: 8, rawPath: 'PRIVATE_STORAGE_PATH_SHOULD_NOT_LEAK' },
            outbox: { pending: 1, processing: 0, failed: 0, stuckProcessing: 0, rawIds: ['PRIVATE_OUTBOX_ID_SHOULD_NOT_LEAK'] },
          },
          providers: {
            claudeCli: { status: 'missing', command: 'claude', authSignal: 'not-detected', rawError: 'PRIVATE_CLAUDE_ERROR_SHOULD_NOT_LEAK' },
            embeddings: { status: 'enabled', backend: '@huggingface/transformers' },
          },
          recommendations: ['Install or authenticate Claude CLI to enable Ask Memory assistant responses.'],
        }) };
      }
      if (parsed.pathname === '/api/stats') {
        return { json: async () => ({ memory: { heapUsed: 10, heapTotal: 20 }, storage: { eventCount: 12, vectorCount: 8 } }) };
      }
      if (parsed.pathname === '/api/stats/graduation') {
        return { json: async () => ({ criteria: {}, description: {} }) };
      }
      if (parsed.pathname === '/api/stats/endless') {
        return { json: async () => ({ mode: 'session', continuityScore: 0 }) };
      }
      return { json: async () => ({}) };
    });
    hooks.state.currentProject = 'project-safe-hash';

    await hooks.loadConfigurationView();

    const setupRequest = requested.map(url => new URL(url)).find(url => url.pathname === '/api/health/setup');
    expect(setupRequest?.searchParams.get('project')).toBe('project-safe-hash');
    expect(cfg.innerHTML).toContain('Setup & Provider Health');
    expect(cfg.innerHTML).toContain('needs-setup');
    expect(cfg.innerHTML).toContain('Claude CLI');
    expect(cfg.innerHTML).toContain('missing');
    expect(cfg.innerHTML).toContain('@huggingface/transformers');
    expect(cfg.innerHTML).toContain('12 events');
    expect(cfg.innerHTML).toContain('1 pending');
    expect(cfg.innerHTML).toContain('Install or authenticate Claude CLI');

    for (const privateSentinel of [
      'PRIVATE_STORAGE_PATH_SHOULD_NOT_LEAK',
      'PRIVATE_OUTBOX_ID_SHOULD_NOT_LEAK',
      'PRIVATE_CLAUDE_ERROR_SHOULD_NOT_LEAK',
    ]) {
      expect(cfg.innerHTML).not.toContain(privateSentinel);
    }
  });
});
