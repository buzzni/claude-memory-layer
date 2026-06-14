import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';

class TestElement {
  innerHTML = '';
  textContent = '';
  value = '';
  checked = false;
  style: Record<string, string> = {};
  disabled = false;
  classList = { add() {}, remove() {}, toggle() {} };
  dataset: Record<string, string> = {};
  options: unknown[] = [];
  addEventListener() {}
  querySelectorAll() { return []; }
  appendChild() {}
}

function loadDashboardWithElements(
  elements: Record<string, TestElement>,
  fetchImpl: typeof fetch | (() => Promise<{ ok: boolean; json: () => Promise<unknown> }>) = async () => ({ ok: true, json: async () => ({}) })
) {
  const dashboardDir = join(process.cwd(), 'src/apps/dashboard/assets/js');
  const source = ['state.js', 'views.js', 'disclosure.js']
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
      createElement() { return new TestElement(); }
    },
    setTimeout,
    clearTimeout
  };

  vm.runInNewContext(
    `${source}\n;globalThis.__dashboardTestHooks = { state, handleDisclosureSearch, renderDisclosureResults, renderDisclosureDrilldown };`,
    context
  );
  return (context as unknown as { __dashboardTestHooks: {
    state: Record<string, any>;
    handleDisclosureSearch: () => Promise<void>;
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

  it('renders search results after a successful disclosure search instead of leaving the list loading', async () => {
    const elements = {
      'disclosure-search-input': new TestElement(),
      'disclosure-search-btn': new TestElement(),
      'disclosure-include-shared': new TestElement(),
      'disclosure-strategy': new TestElement(),
      'disclosure-topk': new TestElement(),
      'disclosure-status': new TestElement(),
      'disclosure-results': new TestElement(),
      'disclosure-drilldown': new TestElement(),
    };
    elements['disclosure-search-input'].value = 'memoryhub';
    elements['disclosure-strategy'].value = 'fast';
    elements['disclosure-topk'].value = '5';

    const requestedBodies: unknown[] = [];
    const hooks = loadDashboardWithElements(elements, async (_url, init) => {
      requestedBodies.push(JSON.parse(String(init?.body || '{}')));
      return {
        ok: true,
        json: async () => ({
          results: [
            {
              id: 'event:e1',
              resultType: 'source',
              title: 'User prompt',
              snippet: 'https://memoryhub.ai/ko/',
              score: 0.97,
              reasons: ['keyword_match'],
              sourceRef: 'event:e1',
              metadata: { sourceProjectHash: 'b7f03a73' }
            }
          ],
          meta: { total: 1, usedVector: false, usedKeyword: true, fallbackApplied: false }
        })
      };
    });

    await hooks.handleDisclosureSearch();

    expect(hooks.state.isDisclosureLoading).toBe(false);
    expect(elements['disclosure-search-btn'].disabled).toBe(false);
    expect(elements['disclosure-status'].textContent).toContain('Search layer returned 1 result');
    expect(elements['disclosure-results'].innerHTML).not.toContain('Searching...');
    expect(elements['disclosure-results'].innerHTML).toContain('class="disclosure-result"');
    expect(elements['disclosure-results'].innerHTML).toContain('User prompt');
    expect(elements['disclosure-results'].innerHTML).toContain('https://memoryhub.ai/ko/');
    expect(elements['disclosure-results'].innerHTML).toContain('Inspect evidence');
    expect(elements['disclosure-results'].innerHTML).toContain('Why this ranked');
    expect(elements['disclosure-results'].innerHTML).toContain('<mark>memoryhub</mark>');
    expect(elements['disclosure-results'].innerHTML).toContain('Project-local');
    expect(requestedBodies[0]).toMatchObject({
      query: 'memoryhub',
      options: { strategy: 'fast', topK: 5, includeShared: false }
    });
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
    expect(html).toContain('Search result');
    expect(html).toContain('Expanded context');
    expect(html).toContain('Source evidence');
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

  it('renders local source evidence with safe collapsed raw transcript previews', () => {
    const elements = { 'disclosure-drilldown': new TestElement() };
    const hooks = loadDashboardWithElements(elements);

    hooks.state.disclosureSelectedId = 'event:e1';
    hooks.state.disclosureExpansion = {
      target: {
        id: 'event:e1',
        resultType: 'source',
        title: 'User asked about MemoryHub',
        snippet: 'https://memoryhub.ai/ko/ benchmark dashboard ideas',
        score: 0.91,
        reasons: ['keyword_match', 'recent_relevance'],
        sourceRef: 'event:e1',
        metadata: { sourceProjectHash: 'b7f03a73', eventType: 'user_prompt' }
      },
      relatedSources: [],
      expandedContext: 'The user asked about MemoryHub dashboard ideas and benchmarking.\n[CONTEXT COMPACTION — REFERENCE ONLY] private handoff summary\nDo not show stale hidden transcript details.'
    };
    hooks.state.disclosureSource = {
      sourceRef: 'event:e1',
      sourceType: 'local_event',
      eventIds: ['e1'],
      rawEvents: [{
        id: 'e1',
        eventType: 'user_prompt',
        timestamp: '2026-06-14T00:00:00.000Z',
        content: '[CONTEXT COMPACTION — REFERENCE ONLY] giant raw transcript metadata\nhttps://memoryhub.ai/ko/ benchmark dashboard ideas',
        metadata: { rawPath: '/Users/alice/private-project', secretLike: 'PRIVATE_META_SENTINEL' }
      }],
      metadata: { sourceProjectHash: 'b7f03a73' }
    };

    hooks.renderDisclosureDrilldown();

    const html = elements['disclosure-drilldown'].innerHTML;
    expect(html).toContain('Source evidence');
    expect(html).toContain('Safe preview');
    expect(html).toContain('Show raw/meta text');
    expect(html).toContain('Context compaction boilerplate hidden');
    expect(html).toContain('https://memoryhub.ai/ko/');
    expect(html).not.toContain('[CONTEXT COMPACTION');
    expect(html).not.toContain('private handoff summary');
    expect(html).not.toContain('stale hidden transcript details');
    expect(html).not.toContain('/Users/alice/private-project');
    expect(html).not.toContain('PRIVATE_META_SENTINEL');
  });
});
