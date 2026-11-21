import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { applyCredentialRedaction, redactText } from '../../src/core/operations/credential-redaction.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

/**
 * A credential match can take the code fence or backtick that hid a closing
 * `</private>` tag, so the next run of the filter sees the tag and masks
 * more. The text path is filtered until nothing changes, as tool_observation
 * rows are, and running the repair again finds nothing to redact (#308).
 */

let seed = 308;
function random(): number {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
const alnum = (n: number) => Array.from({ length: n }, () => pick([...'abcdefghijklmnopqrstuvwxyz0123456789'])).join('');

/** A tag assembled from a tag split by another, `depth` times: each pass of the filter takes one level apart. */
function assembledTag(depth: number): string {
  let tag = '<private>';
  for (let i = 0; i < depth; i++) tag = tag.replace('<private>', '<pri<private></private>vate>');
  return tag;
}

const FRAGMENTS: Array<() => string> = [
  () => 'word', () => ' ', () => '\n', () => '"', () => "'", () => assembledTag(1 + Math.floor(random() * 14)),
  () => '<private>', () => '</private>', () => '<private>', () => '</private>',
  () => '`', () => '```', () => '`code`',
  () => 'password=', () => 'api_key: ', () => 'token=', () => '--token ', () => 'secret: ',
  () => `Bearer ${alnum(20)}`, () => `ghp_${alnum(36)}`,
  () => '[PRIVATE]', () => '[REDACTED]', () => '[PRIVATE: unclosed]', () => 'echo ', () => '='
];

describe('redactText settles (#308)', () => {
  it('masks the private section whose closing tag a removed code fence uncovered', () => {
    const once = redactText('a <private>api_key: ``` b</private>```');

    expect(once).not.toContain(' b');
    expect(redactText(once)).toBe(once);
  });

  it('takes a tag assembled from split tags apart in one run', () => {
    const once = redactText(`a ${assembledTag(14)} hidden b</private> c`);

    expect(once).not.toContain('hidden');
    expect(redactText(once)).toBe(once);
  });

  it('masks text still changing after the last pass whole', () => {
    const once = redactText(`a ${assembledTag(150)} hidden b</private> c`);

    expect(once).toBe('[PRIVATE]\n');
    expect(redactText(once)).toBe(once);
  });

  it('is idempotent over random text mixing credentials, tags, code fences and markers', () => {
    const changed: Array<{ original: string; once: string }> = [];
    for (let i = 0; i < 5000; i++) {
      const original = Array.from({ length: Math.floor(random() * 12) }, () => pick(FRAGMENTS)()).join('');
      const once = redactText(original);
      if (redactText(once) !== once) changed.push({ original, once });
    }
    expect(changed).toEqual([]);
  });
});

describe('redact-credentials over a text row whose credential match removed a code fence', () => {
  const roots: string[] = [];
  const stores: SQLiteEventStore[] = [];
  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('hides the section in the first run and finds nothing in the second', async () => {
    const storagePath = mkdtempSync(path.join(tmpdir(), 'cml-redact-settle-'));
    roots.push(storagePath);
    const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
    await store.initialize();
    stores.push(store);
    const { eventId } = await store.append({
      eventType: 'user_prompt',
      sessionId: 'session-settle',
      timestamp: new Date('2026-11-21T00:00:00.000Z'),
      content: 'a <private>api_key: ``` secret-orchid</private>```',
      metadata: {}
    });
    const redact = () => applyCredentialRedaction(store.getDatabase(), storagePath, { actor: 'test', deleteEventVectors: async () => {} });

    const first = await redact();
    const content = (store.getDatabase().prepare('SELECT content FROM events WHERE id = ?').get(eventId) as { content: string }).content;
    const second = await redact();

    expect(first.affectedEventIds).toEqual([eventId]);
    expect(content).not.toContain('secret-orchid');
    expect(second.affectedEventIds).toEqual([]);
    expect(second.rowChanges).toEqual([]);
  });
});
