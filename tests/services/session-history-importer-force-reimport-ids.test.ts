import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { MemoryService } from '../../src/services/memory-service.js';

/**
 * #250: `import --force` deletes the session's rows and imports the
 * transcript again. The rows it re-created got new event ids, so whatever
 * pointed at the old ids (helpfulness and usefulness observations, retrieval
 * traces, actions, facets, ...) pointed at nothing. A re-created row must keep
 * its id, and still take the turn grouping of the new import.
 */

const fixture = vi.hoisted(() => ({ storagePath: '', service: null as unknown }));

vi.mock('../../src/services/memory-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/memory-service.js')>();
  return {
    ...actual,
    getLightweightMemoryServiceForProject: () => {
      fixture.service ??= new actual.MemoryService({
        storagePath: fixture.storagePath,
        projectHash: 'importer-force-reimport-ids-project',
        lightweightMode: true,
        analyticsEnabled: false,
        sharedStoreConfig: actual.DISABLED_SHARED_STORE_CONFIG
      });
      return fixture.service;
    }
  };
});
vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  scheduleSessionSummary: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../../src/adapters/llm/session-summary-llm.js', () => ({ isLlmSummaryEnabled: () => false }));

const SESSION = 'importer-force-reimport-ids';

let root = '';
let transcriptPath = '';

async function service(): Promise<MemoryService> {
  const memoryService = await import('../../src/services/memory-service.js');
  return memoryService.getLightweightMemoryServiceForProject(root);
}

function append(entry: Record<string, unknown>): void {
  appendFileSync(transcriptPath, `${JSON.stringify({ sessionId: SESSION, timestamp: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

function turn(prompt: string, answer: string): void {
  append({ type: 'user', message: { role: 'user', content: prompt } });
  append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
}

async function importSession(options: { force?: boolean } = {}) {
  const { SessionHistoryImporter } = await import('../../src/services/session-history-importer.js');
  return new SessionHistoryImporter(await service()).importSessionFile(transcriptPath, options);
}

async function rows() {
  const events = await (await service()).getSessionHistory(SESSION);
  return new Map(events.map((event) => [event.content, { id: event.id, turnId: event.metadata?.turnId }]));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cml-importer-force-ids-'));
  fixture.storagePath = path.join(root, 'store');
  fixture.service = null;
  // The importer takes the session id from the file name.
  transcriptPath = path.join(root, `${SESSION}.jsonl`);
  vi.stubEnv('HOME', root);
});

afterEach(async () => {
  await (fixture.service as { shutdown?: () => Promise<void> } | null)?.shutdown?.();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});

describe('Claude session force reimport', () => {
  it('re-creates the imported rows under their old event ids', async () => {
    turn('please fix the release workflow guard', 'The release guard now compares the tag with package.json before it publishes anything to npm.');
    turn('now explain the vector store bug please', 'The vector store kept rows of deleted events because the purge never reached the event_vectors tables at all.');

    expect(await importSession()).toMatchObject({ importedPrompts: 2, importedResponses: 2, errors: [] });
    const before = await rows();
    expect(before.size).toBe(4);

    expect(await importSession({ force: true })).toMatchObject({ importedPrompts: 2, importedResponses: 2, errors: [] });
    const after = await rows();

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [content, row] of before) {
      expect(after.get(content)!.id).toBe(row.id);
      // The force reimport still regroups the turns.
      expect(after.get(content)!.turnId).not.toBe(row.turnId);
    }
  });
});
