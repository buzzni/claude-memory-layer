import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { applyCredentialRedaction, redactText } from '../../src/core/operations/credential-redaction.js';
import { buildMirrorPath, formatMirrorEntry } from '../../src/core/markdown-mirror.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import type { MemoryEvent, MemoryEventInput } from '../../src/core/types.js';

/**
 * Rows stored before #269 keep the text after an unclosed `<private>` tag, and
 * they are not masked retroactively: `repair redact-credentials` re-filters
 * them without masking to the end. Doing so cut a tool_observation row's JSON
 * at the tag and left it unparseable. Closed tags and credentials in those
 * rows are still redacted as before.
 */

const roots: string[] = [];
const stores: SQLiteEventStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let tick = Date.parse('2026-11-21T00:00:00.000Z');
const event = (
  content: string,
  options: { eventType?: MemoryEventInput['eventType']; category?: string } = {}
): MemoryEventInput => ({
  eventType: options.eventType ?? 'user_prompt',
  sessionId: 'session-unclosed-mirror',
  timestamp: new Date(tick++),
  content,
  // One category, so every entry lands in the same mirror file.
  metadata: { category: options.category ?? 'notes' }
});

const toolRow = (toolInput: Record<string, unknown>, toolOutput: string) =>
  event(JSON.stringify({ toolName: 'Bash', toolInput, toolOutput, success: true }), { eventType: 'tool_observation' });

/** A store whose rows and mirror hold `inputs` as written, the way rows stored before #269 do. */
async function storeWithMirror(inputs: MemoryEventInput[]): Promise<{ store: SQLiteEventStore; storagePath: string; events: MemoryEvent[]; mirrorFile: string }> {
  const storagePath = mkdtempSync(path.join(tmpdir(), 'cml-redact-unclosed-'));
  roots.push(storagePath);
  const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'), { markdownMirrorRoot: storagePath });
  await store.initialize();
  stores.push(store);
  const events: MemoryEvent[] = [];
  let mirrorFile = '';
  for (const input of inputs) {
    const { eventId } = await store.append(input);
    events.push((await store.getEvent(eventId!))!);
    mirrorFile = buildMirrorPath(storagePath, events[0]);
    // The mirror append is fire-and-forget: wait for each entry, so they land in order (#281).
    await vi.waitFor(() => expect(readFileSync(mirrorFile, 'utf8')).toBe(events.map(formatMirrorEntry).join('')), { timeout: 10_000 });
  }
  return { store, storagePath, events, mirrorFile };
}

const redact = (store: SQLiteEventStore, storagePath: string) =>
  applyCredentialRedaction(store.getDatabase(), storagePath, { actor: 'test', deleteEventVectors: async () => {} });

const contentOf = (store: SQLiteEventStore, id: string) =>
  (store.getDatabase().prepare('SELECT content FROM events WHERE id = ?').get(id) as { content: string }).content;

describe('redact-credentials over rows with an unclosed <private> tag', () => {
  it('leaves those rows and mirror entries as they were, tool_observation JSON included', async () => {
    const { store, storagePath, events, mirrorFile } = await storeWithMirror([
      event('old row <private>kept-orchid\nsecond line of it'),
      toolRow({ command: "grep -n '<private>open' src" }, 'line 1: <private>open\nline 2'),
      event('third entry'),
      event('closing </private> in a later entry')
    ]);
    const mirrorBefore = readFileSync(mirrorFile, 'utf8');

    const plan = await redact(store, storagePath);

    expect(plan.affectedEventIds).toEqual([]);
    expect(plan.fileChanges).toEqual([]);
    for (const e of events) expect(contentOf(store, e.id)).toBe(e.content);
    expect(JSON.parse(contentOf(store, events[1].id))).toEqual(JSON.parse(events[1].content));
    expect(readFileSync(mirrorFile, 'utf8')).toBe(mirrorBefore);
  });

  it('still masks credentials in such a row, and its JSON stays valid', async () => {
    const { store, storagePath, events, mirrorFile } = await storeWithMirror([
      toolRow({ command: 'deploy api_key=sk-live-1234567890abcdef' }, 'deployed <private>kept-tail'),
      event('second entry')
    ]);

    const plan = await redact(store, storagePath);

    expect(plan.affectedEventIds).toEqual([events[0].id]);
    const stored = JSON.parse(contentOf(store, events[0].id));
    expect(stored.toolInput.command).toBe('deploy [REDACTED] ');
    expect(stored.toolOutput).toBe('deployed <private>kept-tail');
    expect(contentOf(store, events[1].id)).toBe('second entry');

    const mirror = readFileSync(mirrorFile, 'utf8');
    expect(mirror).not.toContain('sk-live');
    expect(mirror).toBe(events.map((e) => formatMirrorEntry({ ...e, content: redactText(e.content) })).join(''));
    expect(mirror.match(/^- ts: /gm)).toHaveLength(2);

    // A second run finds nothing left to change.
    const again = await redact(store, storagePath);
    expect(again.rowChanges).toEqual([]);
    expect(again.fileChanges).toEqual([]);
  });

  it('keeps the content header of an entry whose category holds an unclosed tag', async () => {
    // formatMirrorEntry writes the category unescaped, so a header line can carry a tag.
    const { store, storagePath, events, mirrorFile } = await storeWithMirror([
      event('first api_key=sk-live-1234567890abcdef', { category: 'notes <private>' }),
      event('second entry', { category: 'notes <private>' })
    ]);

    await redact(store, storagePath);

    const mirror = readFileSync(mirrorFile, 'utf8');
    expect(mirror).not.toContain('sk-live');
    expect(mirror.match(/^ {2}content: \|$/gm)).toHaveLength(2);
    expect(mirror).toContain('  id: ' + events[1].id + '\n');
    expect(mirror).toContain('    second entry\n');
    expect((await redact(store, storagePath)).fileChanges).toEqual([]);
  });
});
