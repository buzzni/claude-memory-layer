// @load-sensitive: imports 600-line sessions twice into a real sqlite store (#227 repro);
// under a loaded parallel run one test can pass the 15s unit timeout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { MemoryService } from '../../src/services/memory-service.js';

/**
 * #227 through the MCP tools with the real importer and store: a force
 * reimport the message limit cannot cut short runs and keeps the hook rows;
 * one it could cut short is skipped with the reason, explicit and automatic
 * context-pack refreshes included.
 */

const fixture = vi.hoisted(() => ({ service: null as unknown }));

vi.mock('../../src/services/memory-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/memory-service.js')>();
  return {
    ...actual,
    getMemoryServiceForProject: () => fixture.service,
    getDefaultMemoryService: () => fixture.service
  };
});
vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  scheduleSessionSummary: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../../src/adapters/llm/session-summary-llm.js', () => ({ isLlmSummaryEnabled: () => false }));

const SESSION = 'mcp-force-reimport';
const SKIPPED = 'force reimport skipped for 1 session(s), nothing deleted (a message limit would drop the rows past it';

let root = '';
let projectPath = '';
let service: MemoryService;

function writeTranscript(pairs: number): void {
  const dir = path.join(root, '.claude', 'projects', projectPath.replace(/[\\/]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SESSION}.jsonl`);
  for (let i = 0; i < pairs; i++) {
    appendFileSync(file, `${JSON.stringify({
      sessionId: SESSION, type: 'user', timestamp: new Date(Date.UTC(2026, 9, 1, 9, 0, i)).toISOString(),
      message: { role: 'user', content: `please review release step number ${i}` }
    })}\n`);
    appendFileSync(file, `${JSON.stringify({
      sessionId: SESSION, type: 'assistant', timestamp: new Date(Date.UTC(2026, 9, 1, 10, 0, i)).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: `Step ${i}: ${'The release guard checks the tag against the package version. '.repeat(3)}` }] }
    })}\n`);
  }
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const { handleToolCall } = await import('../../src/extensions/mcp/handlers.js');
  const result = await handleToolCall(name, { projectPath, sources: ['claude'], refreshSources: ['claude'], ...args });
  return { text: result.content.map((item) => ('text' in item ? item.text : '')).join('\n'), isError: result.isError };
}

async function counts(): Promise<Record<string, number>> {
  const events = await service.getSessionHistory(SESSION);
  const byType: Record<string, number> = { total: events.length };
  for (const event of events) byType[event.eventType] = (byType[event.eventType] ?? 0) + 1;
  return byType;
}

async function importWithHookRows(pairs: number): Promise<Record<string, number>> {
  writeTranscript(pairs);
  await call('mem-import-latest', { messageLimit: 1000 });
  await service.storeSessionSummary(SESSION, 'Reviewed every release step and fixed the tag guard.');
  await service.storeToolObservation(SESSION, { toolName: 'Bash', toolInput: {}, toolOutput: 'ok', durationMs: 1, success: true });
  const before = await counts();
  expect(before).toMatchObject({ user_prompt: pairs, agent_response: pairs, session_summary: 1, tool_observation: 1 });
  return before;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'cml-mcp-force-reimport-'));
  projectPath = path.join(root, 'work', 'app');
  mkdirSync(projectPath, { recursive: true });
  vi.stubEnv('HOME', root);
  const { MemoryService, DISABLED_SHARED_STORE_CONFIG } = await import('../../src/services/memory-service.js');
  service = new MemoryService({
    storagePath: path.join(root, 'store'),
    projectHash: 'mcp-force-reimport',
    lightweightMode: true,
    analyticsEnabled: false,
    sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
  });
  fixture.service = service;
});

afterEach(async () => {
  await service.shutdown();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('MCP force reimport', () => {
  it('runs when the message limit cannot cut the session short, and keeps the hook rows', async () => {
    const before = await importWithHookRows(30);

    const result = await call('mem-import-latest', { force: true, messageLimit: 61 });

    expect(result.isError).not.toBe(true);
    expect(result.text).toContain('- claude: sessions=1 messages=60 prompts=30 responses=30 skipped=0 errors=0');
    expect(await counts()).toEqual(before);
  });

  it.each([
    ['mem-import-latest', {}],
    ['mem-context-pack', { refreshLatest: true, query: 'continue' }],
    ['mem-context-pack', { query: 'continue' }]
  ])('%s with the default limit skips a longer session and says why (%o)', async (name, args) => {
    const before = await importWithHookRows(300);

    const result = await call(name, { force: true, refreshForce: true, ...args });

    expect(result.text).toContain(`- claude: ${SKIPPED}`);
    expect(await counts()).toEqual(before);
  });
});
