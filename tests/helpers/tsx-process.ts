import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// Launch TypeScript entry points as `node --import <tsx loader> <entry>`: one
// node process, where `npx tsx` starts npm, then the tsx CLI, then the real
// node child. Each extra process start is what times tests out under load.
//
// The loader is resolved through module resolution instead of a hardcoded
// node_modules path: a git worktree without its own install inherits
// node_modules from an ancestor.
//
// vitest.config.ts runs every test file that imports this helper in the
// serial `cli` project.
const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(
  path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')
).href;

export const tsxCommand = process.execPath;

export function tsxArgs(entry: string, ...args: string[]): string[] {
  return ['--import', tsxLoader, entry, ...args];
}
