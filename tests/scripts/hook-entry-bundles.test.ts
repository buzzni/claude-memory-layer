import { readdirSync } from 'node:fs';
import * as path from 'node:path';

import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * What each hook process loads before its hook runs, read from the bundles
 * scripts/build.ts makes (dependencies stay external there as here). A
 * module loaded with await import() is not in this list.
 */

const repoRoot = process.cwd();
const hooksDir = path.join(repoRoot, 'src', 'hooks');
const NATIVE_BACKENDS = ['@lancedb/lancedb', '@huggingface/transformers', '@xenova/transformers'];
/** Entries that run on every edit or tool call and often stop before storing anything. */
const LIGHT_ENTRIES = ['pre-tool-use', 'post-tool-use'];

let staticImports: Map<string, string[]>;
let bundledInputs: Map<string, string[]>;

beforeAll(async () => {
  const entries = readdirSync(hooksDir).filter((file) => file.endsWith('.ts')).map((file) => path.join(hooksDir, file));
  const result = await esbuild.build({
    entryPoints: entries,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    packages: 'external',
    outdir: path.join(repoRoot, 'hook-bundle-test-out'),
    write: false,
    metafile: true,
    logLevel: 'silent'
  });
  staticImports = new Map();
  bundledInputs = new Map();
  for (const output of Object.values(result.metafile.outputs)) {
    if (!output.entryPoint) continue;
    const name = path.basename(output.entryPoint, '.ts');
    staticImports.set(name, output.imports.filter((ref) => ref.kind === 'import-statement').map((ref) => ref.path));
    bundledInputs.set(name, Object.keys(output.inputs));
  }
}, 60_000);

describe('hook entry bundles', () => {
  it('load no native vector or embedding backend before the hook runs', () => {
    expect(staticImports.size).toBeGreaterThan(10);
    for (const [name, imports] of staticImports) {
      expect(imports.filter((specifier) => NATIVE_BACKENDS.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))), name)
        .toEqual([]);
    }
  });

  it.each(LIGHT_ENTRIES)('%s loads neither SQLite, zod nor the memory service before deciding to store', (name) => {
    expect(staticImports.get(name)).toBeDefined();
    expect(staticImports.get(name)!.filter((specifier) => specifier === 'better-sqlite3' || specifier === 'zod' || specifier.startsWith('zod/')))
      .toEqual([]);
    expect(bundledInputs.get(name)!.filter((input) => input.includes('services/memory-service'))).toEqual([]);
  });
});
