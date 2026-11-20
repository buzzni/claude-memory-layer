import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

import type { MemoryEvent } from '../../src/core/types.js';

const mocks = vi.hoisted(() => ({
  beforeWrite: undefined as (() => void) | undefined,
  afterRename: undefined as (() => void) | undefined,
}));

// The hooks append to mirror files without any lock, so a hook can land at any
// point of the rewrite. These seams put one exactly where it used to be lost.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const once = (key: 'beforeWrite' | 'afterRename') => {
    const run = mocks[key];
    mocks[key] = undefined;
    run?.();
  };
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      once('beforeWrite');
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
    renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
      actual.renameSync(...args);
      once('afterRename');
    }) as typeof actual.renameSync,
  };
});

const fs = await import('fs');
const { planMarkdownRedaction, redactText } = await import('../../src/core/operations/credential-redaction.js');
const { MarkdownMirror, formatMirrorEntry } = await import('../../src/core/markdown-mirror.js');

const roots: string[] = [];

afterEach(() => {
  mocks.beforeWrite = undefined;
  mocks.afterRename = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SECRET = 'api_key=sk-live-1234567890abcdef';

let n = 0;
function event(content: string): MemoryEvent {
  n += 1;
  return {
    id: `e${n}`,
    eventType: 'user_prompt',
    sessionId: 's1',
    timestamp: new Date(2026, 0, 1, 0, 0, 0, n),
    content,
    metadata: {}
  } as MemoryEvent;
}

/** A store whose mirror file was written by MarkdownMirror.append, as the hooks write it. */
async function mirrorWith(first: MemoryEvent): Promise<{ storagePath: string; filePath: string }> {
  const storagePath = fs.mkdtempSync(path.join(tmpdir(), 'cml-redact-mirror-race-'));
  roots.push(storagePath);
  const filePath = await new MarkdownMirror(storagePath).append(first);
  return { storagePath, filePath };
}

/** What a hook writes for `ev`: the entry MarkdownMirror.append would add to the same file. */
function hookAppends(filePath: string, ev: MemoryEvent): void {
  fs.appendFileSync(filePath, formatMirrorEntry(ev), 'utf8');
}

/** What the mirror would hold had each event been written already redacted, as its row is. */
const redactedRows = (events: MemoryEvent[]) =>
  events.map((e) => formatMirrorEntry({ ...e, content: redactText(e.content) })).join('');

describe('planMarkdownRedaction while hooks append to the mirror', () => {
  it('keeps an entry a hook appends after the file was read', async () => {
    const first = event(`call 0 with ${SECRET}`);
    const hook = event('hook entry');
    const { storagePath, filePath } = await mirrorWith(first);
    mocks.beforeWrite = () => hookAppends(filePath, hook);

    const changes = planMarkdownRedaction(storagePath, { apply: true });

    expect(changes).toEqual([expect.objectContaining({ filePath })]);
    expect(changes[0].writeFailed).toBeUndefined();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(redactedRows([first, hook]));
  });

  it('redacts the appended entry entry by entry, keeping the next header on its own line', async () => {
    const first = event(`call 0 with ${SECRET}`);
    const hook = event(`hook call ends with ${SECRET}`);
    const later = event('later entry');
    const { storagePath, filePath } = await mirrorWith(first);
    mocks.beforeWrite = () => hookAppends(filePath, hook);

    planMarkdownRedaction(storagePath, { apply: true });
    hookAppends(filePath, later);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toBe(redactedRows([first, hook, later]));
    expect(content).not.toContain('sk-live');
  });

  it('keeps an entry from a hook that opened the file before the swap and wrote after it', async () => {
    const first = event(`call 0 with ${SECRET}`);
    const slow = event('slow hook entry');
    const { storagePath, filePath } = await mirrorWith(first);
    let hookFd: number | undefined;
    mocks.beforeWrite = () => { hookFd = fs.openSync(filePath, 'a'); };
    mocks.afterRename = () => {
      fs.writeSync(hookFd!, formatMirrorEntry(slow));
      fs.closeSync(hookFd!);
    };

    planMarkdownRedaction(storagePath, { apply: true });

    expect(fs.readFileSync(filePath, 'utf8')).toBe(redactedRows([first, slow]));
  });

  it('keeps an entry a hook appends after the swap and leaves no staging file', async () => {
    const first = event(`call 0 with ${SECRET}`);
    const later = event('later hook entry');
    const { storagePath, filePath } = await mirrorWith(first);
    mocks.afterRename = () => hookAppends(filePath, later);

    planMarkdownRedaction(storagePath, { apply: true });

    expect(fs.readFileSync(filePath, 'utf8')).toBe(redactedRows([first, later]));
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([path.basename(filePath)]);
  });

  it('keeps the file mode the umask would narrow on a new file', async () => {
    const { storagePath, filePath } = await mirrorWith(event(`call 0 with ${SECRET}`));
    fs.chmodSync(filePath, 0o664);
    const umask = process.umask(0o022);
    try {
      planMarkdownRedaction(storagePath, { apply: true });
    } finally {
      process.umask(umask);
    }

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o664);
  });

  it('redacts a hard-linked file under every name', async () => {
    const first = event(`call 0 with ${SECRET}`);
    const { storagePath, filePath } = await mirrorWith(first);
    const otherName = path.join(storagePath, 'linked-copy.txt');
    fs.linkSync(filePath, otherName);

    planMarkdownRedaction(storagePath, { apply: true });

    expect(fs.readFileSync(filePath, 'utf8')).toBe(redactedRows([first]));
    expect(fs.readFileSync(otherName, 'utf8')).toBe(redactedRows([first]));
  });
});
