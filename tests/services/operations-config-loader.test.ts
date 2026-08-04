import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  clearMemoryOperationsConfigCache,
  loadMemoryOperationsConfig,
  resolveOperationsConfigPath
} from '../../src/services/operations-config-loader.js';

const tempDirs: string[] = [];
const ENV_KEY = 'CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH';

function useConfigFile(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-ops-config-'));
  tempDirs.push(dir);
  const file = join(dir, 'operations.json');
  if (content !== null) writeFileSync(file, content);
  process.env[ENV_KEY] = file;
  clearMemoryOperationsConfigCache();
  return file;
}

afterEach(() => {
  delete process.env[ENV_KEY];
  clearMemoryOperationsConfigCache();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('operations config loader', () => {
  it('loads and validates flags from the config file, applying schema defaults', () => {
    useConfigFile(JSON.stringify({ enabled: true, codifyLite: { enabled: true } }));

    const config = loadMemoryOperationsConfig();

    expect(config?.codifyLite.enabled).toBe(true);
    // Untouched subfeatures keep their schema defaults (ranking-changing ones stay off).
    expect(config?.graphExpansion.enabled).toBe(false);
    expect(config?.retention.enabled).toBe(false);
  });

  it('returns undefined when the file is missing (previous behavior preserved)', () => {
    useConfigFile(null);
    expect(loadMemoryOperationsConfig()).toBeUndefined();
  });

  it('returns undefined for malformed JSON instead of throwing (hooks must not crash)', () => {
    useConfigFile('{ not valid json');
    expect(loadMemoryOperationsConfig()).toBeUndefined();
  });

  it('returns undefined for schema-invalid values instead of throwing', () => {
    useConfigFile(JSON.stringify({ codifyLite: { enabled: 'yes-please' } }));
    expect(loadMemoryOperationsConfig()).toBeUndefined();
  });

  it('caches per path and picks up a new path after cache clear', () => {
    useConfigFile(JSON.stringify({ codifyLite: { enabled: true } }));
    expect(loadMemoryOperationsConfig()?.codifyLite.enabled).toBe(true);

    const second = useConfigFile(JSON.stringify({ codifyLite: { enabled: false } }));
    expect(resolveOperationsConfigPath()).toBe(second);
    expect(loadMemoryOperationsConfig()?.codifyLite.enabled).toBe(false);
  });
});
