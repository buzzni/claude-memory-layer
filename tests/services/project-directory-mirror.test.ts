import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Embedder } from '../../src/extensions/vector/embedder.js';
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
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function readTree(dir: string): string {
  if (!existsSync(dir)) return '';
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
}

describe('MemoryService ingest', () => {
  it('writes no event text into the project directory and keeps every event in the store mirror', async () => {
    // Lightweight mode never loads the embedding model; fail fast instead of downloading it if that changes.
    vi.spyOn(Embedder.prototype, 'initialize').mockRejectedValue(new Error('this test must not load the embedding model'));
    root = mkdtempSync(path.join(tmpdir(), 'cml-project-directory-mirror-'));
    vi.stubEnv('HOME', root);
    const projectPath = path.join(root, 'project');
    const storagePath = path.join(root, 'store');
    mkdirSync(projectPath);
    service = new MemoryService({
      storagePath,
      projectHash: 'project-directory-mirror',
      projectPath,
      lightweightMode: true,
      analyticsEnabled: false,
      sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
    });
    await service.initialize();

    const results = [
      await service.storeUserPrompt('s1', 'project mirror leak probe: prompt'),
      await service.storeAgentResponse('s1', 'project mirror leak probe: response'),
      await service.storeSessionSummary('s1', 'project mirror leak probe: summary'),
      await service.storeToolObservation('s1', {
        toolName: 'Bash',
        toolInput: { command: 'echo probe' },
        toolOutput: 'project mirror leak probe: tool output',
        durationMs: 1,
        success: true
      })
    ];

    for (const result of results) expect(result).toMatchObject({ success: true, isDuplicate: false });
    // The store mirror append is fire-and-forget: wait for the entries, not for a fixed delay (#281).
    await vi.waitFor(() => {
      const mirrored = readTree(path.join(storagePath, 'memory'));
      for (const result of results) expect(mirrored).toContain(`id: ${result.eventId}`);
    }, { timeout: 10_000 });
    expect(existsSync(path.join(projectPath, 'memory'))).toBe(false);
  });
});
