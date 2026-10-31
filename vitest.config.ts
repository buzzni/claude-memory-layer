import { readdirSync, readFileSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';

// Load-sensitive test files run in their own serial `cli` project. A file is
// load-sensitive when it launches a TypeScript entry point through
// tests/helpers/tsx-process.ts (every such launch is a full node start plus a
// module graph load), or when it carries the `@load-sensitive` marker with a
// reason. The rule is read from file contents, so new files classify
// themselves.
const LOAD_SENSITIVE = /from '[./]+(?:helpers\/)?tsx-process\.js'|@load-sensitive/;

const loadSensitiveFiles = readdirSync('tests', { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => `tests/${file}`)
  .filter((file) => LOAD_SENSITIVE.test(readFileSync(file, 'utf8')))
  .sort();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 15_000,
    env: {
      // Host-launched test runners must still exercise native recall by default.
      // Host ownership tests supply their own explicit marker.
      CLAUDE_MEMORY_LESSON_OWNER: '',
      CLAUDE_MEMORY_RECALL_OWNER: '',
      // Tests must not pick up the developer's real operations.json — the
      // default registry loads it, so pin the loader to a nonexistent path.
      // Individual tests override this env var for their own fixtures.
      CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH: '/nonexistent/cml-test-operations.json',
      // Tests that run `npm run ...` assert on stderr; npm's update notice
      // must not leak into it.
      NPM_CONFIG_UPDATE_NOTIFIER: 'false'
    },
    // `extends: true` concatenates arrays, so each project owns its include.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...loadSensitiveFiles]
        }
      },
      {
        extends: true,
        test: {
          name: 'cli',
          include: loadSensitiveFiles,
          // A single-worker project runs after the parallel `unit` project
          // has finished, so these files never compete with its workers.
          fileParallelism: false,
          // The slowest test here took 15s when it ran serially at load
          // average ~140 on 14 cores; 60s is 4x that worst case.
          testTimeout: 60_000
        }
      }
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts']
    }
  }
});
