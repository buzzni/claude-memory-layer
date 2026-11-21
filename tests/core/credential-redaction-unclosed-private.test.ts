import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { applyCredentialRedaction, redactText } from '../../src/core/operations/credential-redaction.js';
import { buildMirrorPath, formatMirrorEntry } from '../../src/core/markdown-mirror.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import type { MemoryEvent, MemoryEventInput } from '../../src/core/types.js';

/**
 * Rows stored before #269 keep the text after an unclosed `<private>` tag.
 * `repair redact-credentials` runs them through the privacy filter again, so
 * it now masks that text too, in the rows and in the Markdown mirror. Run over
 * a whole mirror file, an unclosed tag in one entry masked every entry after
 * it; the mirror is redacted entry by entry since #277, and these pin that
 * the other entries are neither removed nor merged.
 */

const roots: string[] = [];
const stores: SQLiteEventStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let tick = Date.parse('2026-11-21T00:00:00.000Z');
const event = (content: string, metadata: Record<string, unknown> = {}): MemoryEventInput => ({
  eventType: 'user_prompt',
  sessionId: 'session-unclosed-mirror',
  timestamp: new Date(tick++),
  content,
  metadata: { category: 'notes', ...metadata }
});

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

describe('redact-credentials over an entry with an unclosed <private> tag', () => {
  it('masks that entry from the tag on and keeps every other entry, in the rows and the mirror', async () => {
    const { store, storagePath, events, mirrorFile } = await storeWithMirror([
      event('first entry'),
      event('old row <private>leaked-orchid\nsecond line of it'),
      event('third entry\nwith two lines'),
      event('closing </private> in a later entry')
    ]);

    const plan = await redact(store, storagePath);

    expect(plan.affectedEventIds).toEqual([events[1].id]);
    expect(contentOf(store, events[1].id)).toBe('old row [PRIVATE: unclosed]');
    for (const i of [0, 2, 3]) expect(contentOf(store, events[i].id)).toBe(events[i].content);

    const mirror = readFileSync(mirrorFile, 'utf8');
    expect(mirror).not.toContain('leaked-orchid');
    expect(mirror).toBe(events.map((e) => formatMirrorEntry({ ...e, content: redactText(e.content) })).join(''));
    expect(mirror.match(/^- ts: /gm)).toHaveLength(4);

    // A second run finds nothing left to change.
    const again = await redact(store, storagePath);
    expect(again.rowChanges).toEqual([]);
    expect(again.fileChanges).toEqual([]);
  });

  it('keeps the content header of an entry whose category holds an unclosed tag', async () => {
    // formatMirrorEntry writes the category unescaped, so a header line can carry a tag.
    const { store, storagePath, events, mirrorFile } = await storeWithMirror([
      event('first <private>leaked-orchid', { category: 'notes <private>' }),
      event('second entry', { category: 'notes <private>' })
    ]);

    await redact(store, storagePath);

    const mirror = readFileSync(mirrorFile, 'utf8');
    expect(mirror).not.toContain('leaked-orchid');
    expect(mirror.match(/^ {2}content: \|$/gm)).toHaveLength(2);
    expect(mirror).toContain('  id: ' + events[1].id + '\n');
    expect(mirror).toContain('    second entry\n');
    expect((await redact(store, storagePath)).fileChanges).toEqual([]);
  });
});
