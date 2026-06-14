import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';

describe('dashboard UX shell affordances', () => {
  it('declares global project scope context and empty-state containers in the dashboard shell', () => {
    const html = readFileSync(join(process.cwd(), 'src/apps/dashboard/index.html'), 'utf-8');

    expect(html).toContain('id="scope-context-bar"');
    expect(html).toContain('id="scope-context-label"');
    expect(html).toContain('id="scope-context-detail"');
    expect(html).toContain('id="global-empty-state"');
    expect(html).toContain('id="disclosure-scope-badge"');
    expect(html).toContain('Search → Expand → Source');
  });

  it('ships a dashboard smoke command that exercises the browser-facing dashboard contract', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['smoke:dashboard']).toBe('tsx scripts/dashboard-smoke.ts');
    expect(existsSync(join(process.cwd(), 'scripts/dashboard-smoke.ts'))).toBe(true);

    const smoke = readFileSync(join(process.cwd(), 'scripts/dashboard-smoke.ts'), 'utf-8');
    expect(smoke).toContain('/health');
    expect(smoke).toContain('/api/projects');
    expect(smoke).toContain('disclosure-search-btn');
    expect(smoke).toContain('Open in Sessions');
    expect(smoke).toContain('scope-context-bar');
  });

  it('declares a Playground dry-run replay page wired to the dashboard API', () => {
    const html = readFileSync(join(process.cwd(), 'src/apps/dashboard/index.html'), 'utf-8');
    const views = readFileSync(join(process.cwd(), 'src/apps/dashboard/assets/js/views.js'), 'utf-8');

    expect(html).toContain('data-nav="playground"');
    expect(html).toContain('id="view-playground"');
    expect(html).toContain('id="playground-run-btn"');
    expect(html).toContain('Dry-run Replay');
    expect(views).toContain('case \'playground\': return loadPlaygroundView();');
    expect(views).toContain('/api/playground/dry-run');
    expect(views).toContain('renderPlaygroundDryRun');
    expect(views).toContain('replayTrace');
  });

  it('renders Playground dry-run results without a missing highlighter runtime error', () => {
    const dashboardDir = join(process.cwd(), 'src/apps/dashboard/assets/js');
    const source = ['state.js', 'disclosure.js', 'views.js']
      .map(file => readFileSync(join(dashboardDir, file), 'utf-8'))
      .join('\n');
    const playgroundOutput = { innerHTML: '' };
    const context = {
      console,
      URL,
      window: { location: { origin: 'http://localhost:37777' } },
      document: {
        addEventListener() {},
        querySelectorAll() { return []; },
        querySelector() { return null; },
        getElementById(id: string) { return id === 'playground-output' ? playgroundOutput : null; },
      },
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      setTimeout,
      clearTimeout,
    };

    vm.runInNewContext(`${source}\n;globalThis.__renderPlaygroundDryRun = renderPlaygroundDryRun;`, context);
    const renderPlaygroundDryRun = (context as unknown as { __renderPlaygroundDryRun: (result: unknown) => void }).__renderPlaygroundDryRun;

    expect(() => renderPlaygroundDryRun({
      dryRun: true,
      mutated: false,
      query: 'memoryhub',
      selectedResultId: 'event:e1',
      replayTrace: ['search', 'expand:event:e1', 'source:event:e1'],
      search: { results: [{ id: 'event:e1', resultType: 'source', snippet: 'memoryhub benchmark hit', score: 0.88, reasons: ['keyword_match'] }] },
      expansion: { surroundingFacts: [{ snippet: 'expanded fact' }] },
      source: { rawEvents: [{ content: 'source evidence' }] },
    })).not.toThrow();
    expect(playgroundOutput.innerHTML).toContain('Replay Trace');
    expect(playgroundOutput.innerHTML).toContain('no memory writes');
    expect(playgroundOutput.innerHTML).toContain('memoryhub');
  });
});
