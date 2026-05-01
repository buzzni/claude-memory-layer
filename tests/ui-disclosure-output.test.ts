import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

class TestElement {
  innerHTML = '';
  textContent = '';
  style: Record<string, string> = {};
  disabled = false;
  classList = { add() {}, remove() {}, toggle() {} };
  dataset: Record<string, string> = {};
  options: unknown[] = [];
  addEventListener() {}
  querySelectorAll() { return []; }
  appendChild() {}
}

function loadDashboardWithElements(elements: Record<string, TestElement>) {
  const appPath = join(process.cwd(), 'src/ui/app.js');
  const source = readFileSync(appPath, 'utf-8');
  const context = {
    console,
    URL,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    window: { location: { origin: 'http://localhost:37777' } },
    document: {
      addEventListener() {},
      getElementById(id: string) { return elements[id] ?? null; },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      createElement() { return new TestElement(); }
    },
    setTimeout,
    clearTimeout
  };

  vm.runInNewContext(
    `${source}\n;globalThis.__dashboardTestHooks = { state, renderDisclosureResults, renderDisclosureDrilldown };`,
    context
  );
  return (context as unknown as { __dashboardTestHooks: {
    state: Record<string, any>;
    renderDisclosureResults: () => void;
    renderDisclosureDrilldown: () => void;
  }}).__dashboardTestHooks;
}

describe('dashboard retrieval disclosure provenance output', () => {
  it('renders shared search results with source/project/topics provenance', () => {
    const elements = { 'disclosure-results': new TestElement() };
    const hooks = loadDashboardWithElements(elements);

    hooks.state.isDisclosureLoading = false;
    hooks.state.disclosureSelectedId = 'shared:shared-1';
    hooks.state.disclosureMeta = { total: 1, usedVector: true, usedKeyword: true, fallbackApplied: false };
    hooks.state.disclosureResults = [
      {
        id: 'shared:shared-1',
        resultType: 'rule',
        title: 'Shared checkout troubleshooting',
        snippet: 'clear cache and retry',
        score: 0.88,
        reasons: ['semantic_match'],
        sourceRef: 'shared:shared-1',
        metadata: {
          sourceProjectHash: 'project-a',
          sourceEntryId: 'e-shared',
          topics: ['checkout']
        }
      }
    ];

    hooks.renderDisclosureResults();

    const html = elements['disclosure-results'].innerHTML;
    expect(html).toContain('shared:shared-1');
    expect(html).toContain('Shared checkout troubleshooting');
    expect(html).toContain('sourceProjectHash');
    expect(html).toContain('project-a');
    expect(html).toContain('topics');
    expect(html).toContain('checkout');
  });

  it('renders shared drilldown with explicit source metadata and no fake raw event', () => {
    const elements = { 'disclosure-drilldown': new TestElement() };
    const hooks = loadDashboardWithElements(elements);

    hooks.state.disclosureSelectedId = 'shared:shared-1';
    hooks.state.disclosureExpansion = {
      target: {
        id: 'shared:shared-1',
        resultType: 'rule',
        title: 'Shared checkout troubleshooting',
        snippet: 'clear cache and retry',
        score: 0.88,
        reasons: ['semantic_match'],
        sourceRef: 'shared:shared-1',
        metadata: { sourceProjectHash: 'project-a', sourceEntryId: 'e-shared', topics: ['checkout'] }
      },
      relatedSources: [
        {
          sourceRef: 'shared:shared-1',
          sourceType: 'shared_troubleshooting',
          eventIds: [],
          metadata: { sourceProjectHash: 'project-a', sourceEntryId: 'e-shared', topics: ['checkout'] }
        }
      ],
      expandedContext: '[shared_troubleshooting] Shared checkout troubleshooting\nRoot cause: stale cache\nSolution: clear cache and retry'
    };
    hooks.state.disclosureSource = {
      sourceRef: 'shared:shared-1',
      sourceType: 'shared_troubleshooting',
      eventIds: [],
      rawEvents: [],
      metadata: {
        sourceProjectHash: 'project-a',
        sourceEntryId: 'e-shared',
        topics: ['checkout'],
        rootCause: 'stale cache',
        solution: 'clear cache and retry'
      }
    };

    hooks.renderDisclosureDrilldown();

    const html = elements['disclosure-drilldown'].innerHTML;
    expect(html).toContain('shared_troubleshooting');
    expect(html).toContain('Shared source provenance');
    expect(html).toContain('sourceProjectHash');
    expect(html).toContain('project-a');
    expect(html).toContain('rootCause');
    expect(html).toContain('stale cache');
    expect(html).toContain('solution');
    expect(html).toContain('clear cache and retry');
    expect(html).toContain('No local raw events for this shared source.');
  });
});
