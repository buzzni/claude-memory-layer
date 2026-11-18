import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { DISABLED_SHARED_STORE_CONFIG, MemoryService } from '../../src/services/memory-service.js';

/**
 * #274: ingest also appended every event's text to `<project>/memory/`. forget,
 * the dashboard delete and redact-credentials only clean the store, so deleted
 * or redacted text stayed in the project directory, where it can be committed.
 */

vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  scheduleSessionSummary: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../../src/adapters/llm/session-summary-llm.js', () => ({ isLlmSummaryEnabled: () => false }));

let root = '';
let service: MemoryService | undefined;

afterEach(async () => {
  await service?.shutdown();
  service = undefined;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('MemoryService ingest', () => {
  it('writes no event text into the project directory', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'cml-project-directory-mirror-'));
    vi.stubEnv('HOME', root);
    const projectPath = path.join(root, 'project');
    mkdirSync(projectPath);
    service = new MemoryService({
      storagePath: path.join(root, 'store'),
      projectHash: 'project-directory-mirror',
      projectPath,
      lightweightMode: true,
      analyticsEnabled: false,
      sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
    });
    await service.initialize();

    const result = await service.storeUserPrompt('s1', 'project mirror leak probe');

    expect(result.success).toBe(true);
    expect(existsSync(path.join(projectPath, 'memory'))).toBe(false);
  });
});
