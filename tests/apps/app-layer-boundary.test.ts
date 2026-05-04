import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const apiModules = [
  'chat',
  'citations',
  'events',
  'health',
  'projects',
  'search',
  'sessions',
  'stats',
  'turns',
  'utils'
];

describe('app-layer entrypoint boundaries', () => {
  it('keeps CLI implementation under src/apps/cli while preserving src/cli compatibility', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const buildScript = readFileSync('scripts/build.ts', 'utf8');
    const cliCompatSource = readFileSync('src/cli/index.ts', 'utf8');
    const cliDisclosureCompatSource = readFileSync('src/cli/retrieval-disclosure-output.ts', 'utf8');

    expect(packageJson.scripts?.dev).toBe('tsx src/apps/cli/index.ts');
    expect(buildScript).toContain("entryPoints: ['src/apps/cli/index.ts']");
    expect(cliCompatSource).toContain("../apps/cli/index.js");
    expect(cliDisclosureCompatSource).toContain("../apps/cli/retrieval-disclosure-output.js");
  });

  it('keeps server implementation under src/apps/server while preserving src/server compatibility', () => {
    const buildScript = readFileSync('scripts/build.ts', 'utf8');
    const serverCompatSource = readFileSync('src/server/index.ts', 'utf8');
    const apiIndexCompatSource = readFileSync('src/server/api/index.ts', 'utf8');

    expect(buildScript).toContain("entryPoints: ['src/apps/server/index.ts']");
    expect(buildScript).toContain("entryPoints: ['src/apps/server/api/index.ts']");
    expect(serverCompatSource).toContain("../apps/server/index.js");
    expect(apiIndexCompatSource).toContain("../../apps/server/api/index.js");

    for (const moduleName of apiModules) {
      const compatPath = `src/server/api/${moduleName}.ts`;
      expect(existsSync(compatPath), `${compatPath} should exist`).toBe(true);
      expect(readFileSync(compatPath, 'utf8')).toContain(`../../apps/server/api/${moduleName}.js`);
    }
  });
});
