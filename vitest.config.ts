import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    env: {
      // Host-launched test runners must still exercise native recall by default.
      // Host ownership tests supply their own explicit marker.
      CLAUDE_MEMORY_LESSON_OWNER: '',
      // Tests must not pick up the developer's real operations.json — the
      // default registry loads it, so pin the loader to a nonexistent path.
      // Individual tests override this env var for their own fixtures.
      CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH: '/nonexistent/cml-test-operations.json'
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts']
    }
  }
});
