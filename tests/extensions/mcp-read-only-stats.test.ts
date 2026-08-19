import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { handleToolCall } from '../../src/extensions/mcp/handlers.js';
import { diffMemoryRootSnapshots, snapshotMemoryRoot } from '../helpers/memory-root-snapshot.js';

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe('MCP mem-stats read-only composition', () => {
  it('returns missing aggregates without creating a project store', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-mcp-stats-missing-'));
    const homeDir = path.join(root, 'home');
    mkdirSync(homeDir);
    process.env.HOME = homeDir;
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const before = snapshotMemoryRoot(memoryRoot);

    const result = await handleToolCall('mem-stats', { projectPath: path.join(root, 'missing-project') });

    expect(result.isError).not.toBe(true);
    expect(String(result.content[0]?.text ?? '')).toContain('Store Status: missing');
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(memoryRoot))).toEqual([]);
  });
});
