import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { applyCredentialRedaction, planSqliteRedaction, redactText } from '../../src/core/operations/credential-redaction.js';
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

/** Redact one tool_observation row through the real store and return what was stored. */
async function redactRow(content: string): Promise<string> {
  const { store, storagePath } = await openStore();
  const id = await legacyRow(store, 'tool_observation', content);
  await apply(store, storagePath);
  return contentOf(store, id);
}

describe('repair redact-credentials on tool_observation rows (#290)', () => {
  it('keeps the JSON parseable when a value holds a closed <private> section, and a second run changes nothing', async () => {
    const { store, storagePath } = await openStore();
    // The row from the issue.
    const id = await legacyRow(store, 'tool_observation', '{"toolName":"Bash","toolInput":{"command":"echo <private>x</private> done"},"toolOutput":"ok","success":true}');

    await apply(store, storagePath);

    const stored = contentOf(store, id);
    expect(stored).toBe('{"toolName":"Bash","toolInput":{"command":"echo [PRIVATE] done"},"toolOutput":"ok","success":true}');
    const observation = parseToolObservation(stored);
    expect(observation).toMatchObject({ toolName: 'Bash', toolInput: { command: 'echo [PRIVATE] done' }, toolOutput: 'ok' });
    expect(JSON.parse(stored).success).toBe(true);

    expect(planSqliteRedaction(store.getDatabase()).rowChanges).toEqual([]);
    const second = await apply(store, storagePath);
    expect(second.rowChanges).toEqual([]);
    expect(contentOf(store, id)).toBe(stored);
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

  it('masks a <private> section opened in one value and closed in another inside both values', async () => {
    const stored = await redactRow(JSON.stringify({
      toolName: 'Bash', toolInput: { command: 'echo <private>first-half' }, toolOutput: 'second-half</private> done', success: true
    }));

    expect(JSON.parse(stored)).toEqual({
      toolName: 'Bash', toolInput: { command: 'echo [PRIVATE]' }, toolOutput: '[PRIVATE] done', success: true
    });
  });

  it('masks a section whose closing tag a code span across values hid from a per-value filter', async () => {
    // Read as one text, the backtick in the command opens a code span that ends at the first backtick of the
    // output, so the tags after it are outside any code span and are masked. The output alone reads them as code.
    const original = JSON.stringify({ toolName: 'Bash', toolInput: { command: 'grep "`" a.md' }, toolOutput: '` <private>hidden-word</private> `b`', success: true });
    expect(redactText(original)).not.toContain('hidden-word');

    const stored = await redactRow(original);

    expect(stored).not.toContain('hidden-word');
    expect(JSON.parse(stored).toolInput.command).toBe('grep "`" a.md');
  });

  it('keeps masking text that a credential match ran into past an escaped newline', async () => {
    // As JSON text the newline is the two characters `\n`, so the value of API_KEY runs on into the next line.
    const original = JSON.stringify({ toolName: 'Bash', toolInput: { command: 'export API_KEY=abc\nnextline -la' }, toolOutput: '', success: true });
    expect(redactText(original)).not.toContain('nextline');

    const stored = await redactRow(original);

    expect(stored).not.toContain('nextline');
    expect(JSON.parse(stored).toolInput.command).toBe('export [REDACTED] -la');
  });

  it('rewrites only the values it masks, so other text keeps its exact form', async () => {
    const stored = await redactRow(
      '{"toolName":"Bash", "toolInput":{"command":"echo <private>x</private>"},\n "toolOutput":"caf\\u00e9 \\/ok", "metadata":{"bytes":12345678901234567890}}'
    );

    expect(stored).toBe(
      '{"toolName":"Bash", "toolInput":{"command":"echo [PRIVATE]"},\n "toolOutput":"caf\\u00e9 \\/ok", "metadata":{"bytes":12345678901234567890}}'
    );
  });

  it('keeps the text after an unclosed tag, as for every row stored before #269', async () => {
    const { store } = await openStore();
    await legacyRow(store, 'tool_observation', JSON.stringify({ toolName: 'Bash', toolInput: { command: 'grep -n "<private>" src' }, toolOutput: 'src/a.ts:1', success: true }));

    expect(planSqliteRedaction(store.getDatabase()).rowChanges).toEqual([]);
  });

  it('still redacts other event types as one text', async () => {
    const { store, storagePath } = await openStore();
    const content = '{"note":"echo <private>x</private> done"}';
    const id = await legacyRow(store, 'user_prompt', content);

    await apply(store, storagePath);

    expect(contentOf(store, id)).toBe(redactText(content));
    expect(contentOf(store, id)).toBe('{"note":"echo [PRIVATE]\ndone"}');
  });
});
