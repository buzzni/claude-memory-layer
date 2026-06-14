import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
});
