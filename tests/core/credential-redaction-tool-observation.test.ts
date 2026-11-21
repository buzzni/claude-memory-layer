import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { applyCredentialRedaction, planSqliteRedaction } from '../../src/core/operations/credential-redaction.js';
import { parseToolObservation } from '../../src/core/lesson-follow-through.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';

const roots: string[] = [];
const stores: SQLiteEventStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function openStore(): Promise<{ store: SQLiteEventStore; storagePath: string }> {
  const storagePath = mkdtempSync(path.join(tmpdir(), 'cml-redact-tool-'));
  roots.push(storagePath);
  const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
  await store.initialize();
  stores.push(store);
  return { store, storagePath };
}

let tick = Date.parse('2026-01-01T00:00:00.000Z');
/** A row written before the ingest-side filter covered it, still holding its raw text. */
async function legacyRow(store: SQLiteEventStore, eventType: 'tool_observation' | 'user_prompt', content: string): Promise<string> {
  const { eventId } = await store.append({ eventType, sessionId: 's1', timestamp: new Date(tick++), content: `placeholder ${tick}` });
  store.getDatabase().prepare('UPDATE events SET content = ? WHERE id = ?').run(content, eventId);
  return eventId!;
}

function contentOf(store: SQLiteEventStore, eventId: string): string {
  return sqliteAll<{ content: string }>(store.getDatabase(), 'SELECT content FROM events WHERE id = ?', [eventId])[0].content;
}

const apply = (store: SQLiteEventStore, storagePath: string) =>
  applyCredentialRedaction(store.getDatabase(), storagePath, { actor: 'cli', deleteEventVectors: async () => undefined });

describe('repair redact-credentials on tool_observation rows (#290)', () => {
  it('keeps the JSON parseable when a value holds a closed <private> section', async () => {
    const { store, storagePath } = await openStore();
    const id = await legacyRow(store, 'tool_observation', JSON.stringify({
      toolName: 'Bash', toolInput: { command: 'echo <private>x</private> done' }, toolOutput: 'ok', success: true
    }));

    await apply(store, storagePath);

    const stored = contentOf(store, id);
    expect(stored).not.toContain('<private>');
    expect(JSON.parse(stored)).toEqual({
      toolName: 'Bash', toolInput: { command: 'echo [PRIVATE] done' }, toolOutput: 'ok', success: true
    });
    expect(parseToolObservation(stored)?.toolName).toBe('Bash');
  });

  it('redacts each nested string value, keeping the lines around a marker', async () => {
    const { store, storagePath } = await openStore();
    const id = await legacyRow(store, 'tool_observation', JSON.stringify({
      toolName: 'Edit',
      toolInput: { file_path: 'a.ts', new_string: '// <private>note</private>\nconst x = 1;', edits: ['api_key=sk-live-1234567890abcdef'] },
      toolOutput: { stdout: 'password: hunter2-secret' },
      success: true,
      metadata: { durationMs: 3 }
    }));

    const { rowChanges } = planSqliteRedaction(store.getDatabase());
    expect(rowChanges.map((change) => change.rowId)).toEqual([id]);
    await apply(store, storagePath);

    const parsed = JSON.parse(contentOf(store, id));
    expect(parsed.toolInput.new_string).toBe('// [PRIVATE]\nconst x = 1;');
    expect(parsed.toolInput.edits).toEqual(['[REDACTED]']);
    expect(parsed.toolOutput.stdout).toBe('[REDACTED]');
    expect(parsed.metadata).toEqual({ durationMs: 3 });
    expect(parsed.toolInput.file_path).toBe('a.ts');
  });

  it('leaves a tool_observation row with nothing to redact untouched', async () => {
    const { store } = await openStore();
    await legacyRow(store, 'tool_observation', '{"toolName":"Read", "toolInput":{"file_path":"a.ts"}}');

    expect(planSqliteRedaction(store.getDatabase()).rowChanges).toEqual([]);
  });

  it('still redacts a tool_observation row that is not JSON as text', async () => {
    const { store, storagePath } = await openStore();
    const id = await legacyRow(store, 'tool_observation', 'ran with api_key=sk-live-1234567890abcdef');

    await apply(store, storagePath);

    expect(contentOf(store, id)).toBe('ran with [REDACTED] ');
  });
});
