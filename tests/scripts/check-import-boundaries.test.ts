import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const checkerPath = path.join(repoRoot, 'scripts', 'check-import-boundaries.mjs');

function makeFixtureRepo(name: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `cml-import-boundary-${name}-`));
  mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'extensions', 'vector'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'adapters', 'claude'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'apps', 'cli'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'services'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'extensions', 'mcp'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'extensions', 'vector', 'index.ts'), 'export const vector = 1;\n', 'utf8');
  writeFileSync(path.join(root, 'src', 'adapters', 'claude', 'index.ts'), 'export const adapter = 1;\n', 'utf8');
  writeFileSync(path.join(root, 'src', 'apps', 'cli', 'index.ts'), 'export const app = 1;\n', 'utf8');
  writeFileSync(path.join(root, 'src', 'services', 'memory-service.ts'), 'export const memoryService = 1;\n', 'utf8');
  return root;
}

function runChecker(root: string, extraArgs: string[] = []) {
  return spawnSync('node', [checkerPath, '--root', root, ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
}

describe('check-import-boundaries architecture guard', () => {
  it('fails on new core imports and re-exports from extension, adapter, app, or service layers', () => {
    const root = makeFixtureRepo('core-forbidden');
    writeFileSync(path.join(root, 'src', 'core', 'violates-extension.ts'), "import { vector } from '../extensions/vector/index.js';\nvoid vector;\n", 'utf8');
    writeFileSync(path.join(root, 'src', 'core', 'violates-adapter.ts'), "export { adapter } from '../adapters/claude/index.js';\n", 'utf8');
    writeFileSync(path.join(root, 'src', 'core', 'violates-app.ts'), "export { app } from '../apps/cli/index.js';\n", 'utf8');
    writeFileSync(path.join(root, 'src', 'core', 'violates-service.ts'), "import { memoryService } from '../services/memory-service.js';\nvoid memoryService;\n", 'utf8');

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Import boundary check failed');
    expect(result.stderr).toContain('src/core/violates-extension.ts -> src/extensions/vector/index.js');
    expect(result.stderr).toContain('src/core/violates-adapter.ts -> src/adapters/claude/index.js');
    expect(result.stderr).toContain('src/core/violates-app.ts -> src/apps/cli/index.js');
    expect(result.stderr).toContain('src/core/violates-service.ts -> src/services/memory-service.js');
    expect(result.stderr).not.toContain(root);
  });

  it('allows only exact documented baseline entries and still fails on unlisted new violations', () => {
    const root = makeFixtureRepo('baseline');
    const baselinePath = path.join(root, 'import-boundary-baseline.json');
    writeFileSync(path.join(root, 'src', 'core', 'existing-debt.ts'), "export { vector } from '../extensions/vector/index.js';\n", 'utf8');
    writeFileSync(path.join(root, 'src', 'core', 'new-debt.ts'), "export { adapter } from '../adapters/claude/index.js';\n", 'utf8');
    writeFileSync(baselinePath, `${JSON.stringify({
      version: 1,
      entries: [
        {
          rule: 'core-no-forbidden-imports',
          from: 'src/core/existing-debt.ts',
          to: 'src/extensions/vector/index.js',
          reason: 'Existing Packet A fixture debt; remove during Packet C boundary inversion.'
        }
      ]
    }, null, 2)}\n`, 'utf8');

    const result = runChecker(root, ['--baseline', baselinePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/core/new-debt.ts -> src/adapters/claude/index.js');
    expect(result.stderr).not.toContain('src/core/existing-debt.ts -> src/extensions/vector/index.js');
  });

  it('fails on forbidden layer barrel-root imports from core modules', () => {
    const root = makeFixtureRepo('core-layer-roots');
    writeFileSync(path.join(root, 'src', 'core', 'violates-extension-root.ts'), "import * as extensions from '../extensions';\nvoid extensions;\n", 'utf8');
    writeFileSync(path.join(root, 'src', 'core', 'violates-app-root.ts'), "export * as apps from '../apps';\n", 'utf8');
    writeFileSync(path.join(root, 'src', 'core', 'violates-service-root.ts'), "import * as services from '../services';\nvoid services;\n", 'utf8');

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/core/violates-extension-root.ts -> src/extensions');
    expect(result.stderr).toContain('src/core/violates-app-root.ts -> src/apps');
    expect(result.stderr).toContain('src/core/violates-service-root.ts -> src/services');
    expect(result.stderr).not.toContain(root);
  });

  it('fails on namespace re-exports from forbidden layers', () => {
    const root = makeFixtureRepo('namespace-export');
    writeFileSync(path.join(root, 'src', 'core', 'violates-namespace-export.ts'), "export * as vector from '../extensions/vector/index.js';\n", 'utf8');

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/core/violates-namespace-export.ts -> src/extensions/vector/index.js');
    expect(result.stderr).not.toContain(root);
  });

  it('fails on forbidden layer root and barrel imports from core', () => {
    const root = makeFixtureRepo('layer-roots');
    writeFileSync(path.join(root, 'src', 'core', 'violates-extension-root.ts'), "import { vector } from '../extensions';\nvoid vector;\n", 'utf8');
    writeFileSync(path.join(root, 'src', 'core', 'violates-adapter-root.ts'), "export * from '../adapters';\n", 'utf8');
    writeFileSync(path.join(root, 'src', 'core', 'violates-app-root.ts'), "import { app } from 'src/apps';\nvoid app;\n", 'utf8');
    writeFileSync(path.join(root, 'src', 'core', 'violates-service-root.ts'), "export { memoryService } from '../services';\n", 'utf8');

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/core/violates-extension-root.ts -> src/extensions');
    expect(result.stderr).toContain('src/core/violates-adapter-root.ts -> src/adapters');
    expect(result.stderr).toContain('src/core/violates-app-root.ts -> src/apps');
    expect(result.stderr).toContain('src/core/violates-service-root.ts -> src/services');
    expect(result.stderr).not.toContain(root);
  });

  it('ignores import-looking text inside comments and string literals', () => {
    const root = makeFixtureRepo('comments-and-strings');
    writeFileSync(path.join(root, 'src', 'core', 'safe-comments.ts'), [
      "// import { vector } from '../extensions/vector/index.js';",
      "const example = \"export { adapter } from '../adapters/claude/index.js';\";",
      "void example;",
      ""
    ].join('\n'), 'utf8');

    const result = runChecker(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Import boundary check passed');
    expect(result.stdout).not.toContain(root);
    expect(result.stderr).toBe('');
  });

  it('fails when an extensions module imports the legacy MemoryService facade', () => {
    const root = makeFixtureRepo('extensions-service');
    writeFileSync(path.join(root, 'src', 'extensions', 'mcp', 'handlers.ts'), "import { MemoryService } from '../../services/memory-service.js';\nvoid MemoryService;\n", 'utf8');

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[extensions-no-memory-service]');
    expect(result.stderr).toContain('src/extensions/mcp/handlers.ts -> src/services/memory-service.js');
    expect(result.stderr).not.toContain(root);
  });

  it('passes for allowed imports and reports active baseline counts without absolute paths', () => {
    const root = makeFixtureRepo('passing');
    const baselinePath = path.join(root, 'import-boundary-baseline.json');
    writeFileSync(path.join(root, 'src', 'core', 'safe.ts'), "import { sibling } from './sibling.js';\nvoid sibling;\n", 'utf8');
    writeFileSync(path.join(root, 'src', 'core', 'sibling.ts'), 'export const sibling = 1;\n', 'utf8');
    writeFileSync(path.join(root, 'src', 'core', 'existing-debt.ts'), "export { vector } from '../extensions/vector/index.js';\n", 'utf8');
    writeFileSync(baselinePath, `${JSON.stringify({
      version: 1,
      entries: [
        {
          rule: 'core-no-forbidden-imports',
          from: 'src/core/existing-debt.ts',
          to: 'src/extensions/vector/index.js',
          reason: 'Existing Packet A fixture debt; remove during Packet C boundary inversion.'
        }
      ]
    }, null, 2)}\n`, 'utf8');

    const result = runChecker(root, ['--baseline', baselinePath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Import boundary check passed');
    expect(result.stdout).toContain('Baseline entries still active: 1');
    expect(result.stdout).not.toContain(root);
    expect(result.stderr).toBe('');
  });
});
