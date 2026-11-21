import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { applyCredentialRedaction, redactText } from '../../src/core/operations/credential-redaction.js';
import { applyPrivacyFilter } from '../../src/core/privacy/filter.js';
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

/** Plain text in CJK characters, each used once per text, so where a shown one came from is exact. */
const FIRST_TRACKED = 0x4e00;
let nextTracked = FIRST_TRACKED;
const tracked = () => Array.from({ length: 1 + Math.floor(random() * 4) }, () => String.fromCharCode(nextTracked++)).join('');

/** A tag assembled from a tag split by another, `depth` times: each pass of the filter takes one level apart. */
function assembledTag(depth: number): string {
  let tag = '<private>';
  for (let i = 0; i < depth; i++) tag = tag.replace('<private>', '<pri<private></private>vate>');
  return tag;
}

const FRAGMENTS: Array<() => string> = [
  tracked, tracked, () => 'word', () => ' ', () => '\n', () => '"', () => "'", () => assembledTag(1 + Math.floor(random() * 14)),
  () => '<private>', () => '</private>', () => '<private>', () => '</private>',
  () => '`', () => '```', () => '`code`',
  () => 'password=', () => 'api_key: ', () => 'token=', () => '--token ', () => 'secret: ',
  () => `Bearer ${alnum(20)}`, () => `ghp_${alnum(36)}`,
  () => '[PRIVATE]', () => '[REDACTED]', () => '[PRIVATE: unclosed]', () => 'echo ', () => '=',
  // What #304 changed: markers a credential value runs into, URL credentials, the config patterns as bare words.
  () => '[REDACTED: unclosed]', () => `postgres://admin:${alnum(8)}@`, () => `https://u:${alnum(8)}@host/x`, () => alnum(12),
  () => 'password', () => 'secret', () => 'bearer', () => 'token',
  // Tags the repair does not mask: mixed case, and the bracket and comment formats.
  () => '<PRIVATE>', () => '</Private>', () => '[private]', () => '[/private]', () => '<!-- private -->', () => '<!-- /private -->'
];

/** One pass of the repair's filter: what redactText did before #308. */
const redactOnce = (text: string) => applyPrivacyFilter(text, {
  excludePatterns: ['password', 'secret', 'api_key', 'token', 'bearer'],
  anonymize: false,
  privateTags: { enabled: true, marker: '[PRIVATE]', preserveLineCount: false, supportedFormats: ['xml'] }
}, { maskUnclosed: false }).content;

/**
 * Whether `settled` shows only characters `once` shows, in the same order,
 * apart from markers and whitespace: a marker is not text, so `D` is not
 * shown by `[REDACTED]`. Removing a tag joins the text around it, so this
 * compares characters rather than the pieces showsAllTextOf compares.
 */
function showsNoMoreThan(once: string, settled: string): boolean {
  const text = (value: string) => value.replace(/\[(?:PRIVATE|REDACTED)\]/g, '').replace(/\s+/g, '');
  const shown = text(once);
  let at = 0;
  for (const char of text(settled)) {
    at = shown.indexOf(char, at) + 1;
    if (at === 0) return false;
  }
  return true;
}

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

  it('masks a credential URL that a first pass leaves whole after the token it runs on from', () => {
    // The URL rule needs a word boundary before the scheme, and `ghp_…postgres`
    // has none; masking the token makes one.
    const once = redactText(`see ghp_${'a1'.repeat(18)}postgres://admin:pw-orchid@db.internal/app`);

    expect(once).not.toContain('pw-orchid');
    expect(redactText(once)).toBe(once);
  });

  it('masks text still changing after the last pass whole', () => {
    const once = redactText(`a ${assembledTag(150)} hidden b</private> c`);

    expect(once).toBe('[PRIVATE]\n');
    expect(redactText(once)).toBe(once);
  });

  it('masks the text outside the section too when only the last pass settles it', () => {
    // A tag split 98 deep takes 98 passes apart, a 99th masks the section and a
    // 100th finds nothing to change. Split 99 deep, the 100th pass masks the
    // section and no pass is left to show the text would not change again.
    const text = (depth: number) => `PUBLIC head ${assembledTag(depth)} hidden</private> PUBLIC tail`;

    expect(redactText(text(98))).toBe('PUBLIC head [PRIVATE]\nPUBLIC tail');
    expect(redactText(text(99))).toBe('[PRIVATE]\n');
  });

  it('shows no marker letter as text', () => {
    expect(showsNoMoreThan('[REDACTED] ', 'D')).toBe(false);
  });

  it('is idempotent over random text mixing credentials, tags, code fences and markers, and shows nothing one pass hid', () => {
    const changed: Array<{ original: string; once: string }> = [];
    const shown: Array<{ original: string; once: string }> = [];
    for (let i = 0; i < 5000; i++) {
      nextTracked = FIRST_TRACKED;
      const original = Array.from({ length: Math.floor(random() * 12) }, () => pick(FRAGMENTS)()).join('');
      const once = redactText(original);
      const onePass = redactOnce(original);
      if (redactText(once) !== once) changed.push({ original, once });
      const shownByPosition = Array.from({ length: nextTracked - FIRST_TRACKED }, (_, k) => String.fromCharCode(FIRST_TRACKED + k))
        .some((char) => once.includes(char) && !onePass.includes(char));
      if (shownByPosition || !showsNoMoreThan(onePass, once)) shown.push({ original, once });
    }
    expect(changed).toEqual([]);
    expect(shown).toEqual([]);
  });
});

describe('redact-credentials over a text row whose credential match removed a code fence', () => {
  const roots: string[] = [];
  const stores: SQLiteEventStore[] = [];
  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('hides the section in the first run, in the row and its mirror entry, and finds nothing in the second', async () => {
    const storagePath = mkdtempSync(path.join(tmpdir(), 'cml-redact-settle-'));
    roots.push(storagePath);
    const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'), { markdownMirrorRoot: storagePath });
    await store.initialize();
    stores.push(store);
    const eventIds: string[] = [];
    // The second one still changes after the last pass, and is masked whole.
    for (const [i, content] of ['a <private>api_key: ``` secret-orchid</private>```', `a ${assembledTag(150)} secret-iris</private> c`].entries()) {
      const { eventId } = await store.append({
        eventType: 'user_prompt',
        sessionId: 'session-settle',
        timestamp: new Date(Date.parse('2026-11-21T12:00:00.000Z') + i),
        content,
        metadata: {}
      });
      eventIds.push(eventId);
    }
    const redact = () => applyCredentialRedaction(store.getDatabase(), storagePath, { actor: 'test', deleteEventVectors: async () => {} });

    const first = await redact();
    const rows = eventIds.map((id) => (store.getDatabase().prepare('SELECT content FROM events WHERE id = ?').get(id) as { content: string }).content);
    const mirror = readFileSync(first.fileChanges[0].filePath, 'utf8');
    const second = await redact();

    expect([...first.affectedEventIds].sort()).toEqual([...eventIds].sort());
    expect(rows[1]).toBe('[PRIVATE]\n');
    for (const row of rows) {
      expect(row).not.toContain('secret-');
      expect(mirror).toContain(`  content: |\n${row.split('\n').map((line) => `    ${line}`).join('\n')}\n`);
    }
    expect(mirror).not.toContain('secret-');
    expect(second.affectedEventIds).toEqual([]);
    expect(second.rowChanges).toEqual([]);
    expect(second.fileChanges).toEqual([]);
  });
});
