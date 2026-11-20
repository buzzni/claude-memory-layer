import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { planMarkdownRedaction, redactText } from '../../src/core/operations/credential-redaction.js';
import { formatMirrorEntry } from '../../src/core/markdown-mirror.js';
import type { MemoryEvent } from '../../src/core/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let n = 0;
function event(content: string): MemoryEvent {
  n += 1;
  return {
    id: `e${n}`,
    eventType: 'user_prompt',
    sessionId: 's1',
    timestamp: new Date(Date.parse('2026-01-01T00:00:00.000Z') + n),
    content,
    contentHash: `h${n}`,
    metadata: {}
  } as MemoryEvent;
}

function writeMirror(events: MemoryEvent[]): string {
  const storagePath = mkdtempSync(path.join(tmpdir(), 'cml-redact-mirror-'));
  roots.push(storagePath);
  const dir = path.join(storagePath, 'memory', 'default', 'user_prompt');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '2026-01-01.md'), events.map(formatMirrorEntry).join(''), 'utf8');
  return storagePath;
}

const mirrorOf = (storagePath: string) =>
  readFileSync(path.join(storagePath, 'memory', 'default', 'user_prompt', '2026-01-01.md'), 'utf8');

/** What the mirror would hold had each event been written already redacted, as its row is. */
const redactedRows = (events: MemoryEvent[]) =>
  events.map((e) => formatMirrorEntry({ ...e, content: redactText(e.content) })).join('');

describe('planMarkdownRedaction on mirror entries', () => {
  it('keeps the next entry header on its own line when a credential ends an entry', () => {
    const events = [event('token=fake-value-1234567890'), event('second entry')];
    const storagePath = writeMirror(events);

    const changes = planMarkdownRedaction(storagePath, { apply: true });

    expect(changes).toHaveLength(1);
    const mirror = mirrorOf(storagePath);
    expect(mirror).toBe(redactedRows(events));
    expect(mirror).toContain('\n\n- ts: ');
    expect(mirror).not.toContain('fake-value');
  });

  it('keeps the indentation of the line after a private tag', () => {
    const events = [event('<private>hidden note</private> ok\nnext line\nlast line'), event('second entry')];
    const storagePath = writeMirror(events);

    planMarkdownRedaction(storagePath, { apply: true });

    const mirror = mirrorOf(storagePath);
    expect(mirror).toBe(redactedRows(events));
    expect(mirror).toContain('\n    last line\n');
    expect(mirror).not.toContain('hidden note');
  });

  it('matches row-by-row redaction across mixed entries', () => {
    const events = [
      event('first\npassword=fake-pass-123 trailing\n  indented line'),
      event('clean entry'),
      event('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123\nafter'),
      event('end with api_key=fake-key-abcdef'),
      event('<private>a</private>\n<private>b</private>\nkept')
    ];
    const storagePath = writeMirror(events);

    planMarkdownRedaction(storagePath, { apply: true });

    expect(mirrorOf(storagePath)).toBe(redactedRows(events));
    expect(planMarkdownRedaction(storagePath, { apply: true })).toEqual([]);
  });

  it('never lets an unclosed private tag swallow the entries after it', () => {
    const events = [event('<private>opened but never closed'), event('kept entry'), event('closing </private> here')];
    const storagePath = writeMirror(events);

    planMarkdownRedaction(storagePath, { apply: true });

    expect(mirrorOf(storagePath)).toContain('    kept entry\n');
  });

  it('redacts every line when a category forges a content block', () => {
    // formatMirrorEntry writes the category unescaped, so it can hold header lines.
    const forged = {
      ...event('real token=fake-real-1234567890'),
      metadata: { category: 'x\n  content: |\n    password=fake-forged-123\n  id: forged' }
    } as MemoryEvent;
    const storagePath = writeMirror([forged, event('second entry')]);

    planMarkdownRedaction(storagePath, { apply: true });

    const mirror = mirrorOf(storagePath);
    expect(mirror).not.toContain('fake-forged');
    expect(mirror).not.toContain('fake-real');
    expect(mirror).toContain('\n\n- ts: ');
    expect(mirror).toContain('    second entry\n');
  });

  it('still redacts a file that is not in the mirror format, keeping its lines', () => {
    const storagePath = mkdtempSync(path.join(tmpdir(), 'cml-redact-mirror-'));
    roots.push(storagePath);
    const dir = path.join(storagePath, 'memory', 'notes');
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'free.md');
    writeFileSync(filePath, '## heading\ntoken=fake-value-1234567890\n  indented\n', 'utf8');

    const changes = planMarkdownRedaction(storagePath, { apply: true });

    expect(changes).toHaveLength(1);
    expect(readFileSync(filePath, 'utf8')).toBe('## heading\n[REDACTED]\n  indented\n');
  });
});
