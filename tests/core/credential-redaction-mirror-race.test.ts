import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

import type { MemoryEvent } from '../../src/core/types.js';

const mocks = vi.hoisted(() => ({
  beforeWrite: undefined as (() => void) | undefined,
  afterRename: undefined as (() => void) | undefined,
  appendError: undefined as NodeJS.ErrnoException | undefined,
  linkError: undefined as NodeJS.ErrnoException | undefined,
  renameError: undefined as NodeJS.ErrnoException | undefined,
  rmError: undefined as NodeJS.ErrnoException | undefined,
}));

// The hooks append to mirror files without any lock, so a hook can land at any
// point of the rewrite. These seams put one exactly where it used to be lost,
// and fail the calls a full disk or a filesystem without hard links would.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const once = (key: 'beforeWrite' | 'afterRename') => {
    const run = mocks[key];
    mocks[key] = undefined;
    run?.();
  };
  const failOnce = (key: 'appendError' | 'linkError' | 'renameError' | 'rmError') => {
    const error = mocks[key];
    mocks[key] = undefined;
    if (error) throw error;
  };
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      once('beforeWrite');
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
    renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
      failOnce('renameError');
      actual.renameSync(...args);
      once('afterRename');
    }) as typeof actual.renameSync,
    appendFileSync: ((...args: Parameters<typeof actual.appendFileSync>) => {
      failOnce('appendError');
      return actual.appendFileSync(...args);
    }) as typeof actual.appendFileSync,
    rmSync: ((...args: Parameters<typeof actual.rmSync>) => {
      failOnce('rmError');
      return actual.rmSync(...args);
    }) as typeof actual.rmSync,
    linkSync: ((...args: Parameters<typeof actual.linkSync>) => {
      failOnce('linkError');
      return actual.linkSync(...args);
    }) as typeof actual.linkSync,
  };
});

const fs = await import('fs');
const { planMarkdownRedaction, redactText } = await import('../../src/core/operations/credential-redaction.js');
const { MarkdownMirror, formatMirrorEntry } = await import('../../src/core/markdown-mirror.js');

const roots: string[] = [];

afterEach(() => {
  mocks.beforeWrite = undefined;
  mocks.afterRename = undefined;
  mocks.appendError = undefined;
  mocks.linkError = undefined;
  mocks.renameError = undefined;
  mocks.rmError = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SECRET = 'api_key=sk-live-1234567890abcdef';

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}

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

/** The one `.old` file a run left next to the mirror file. */
function keptFileIn(dir: string): string {
  const kept = fs.readdirSync(dir).filter((name) => name.endsWith('.old'));
  expect(kept).toHaveLength(1);
  return path.join(dir, kept[0]);
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

  it('puts the replaced file back, appended entries and all, when adding them to the copy fails', async () => {
    const first = event(`call 0 with ${SECRET}`);
    const hook = event('hook entry');
    const { storagePath, filePath } = await mirrorWith(first);
    mocks.beforeWrite = () => hookAppends(filePath, hook);
    mocks.afterRename = () => { mocks.appendError = errnoError('ENOSPC'); };

    const changes = planMarkdownRedaction(storagePath, { apply: true });

    expect(changes).toEqual([expect.objectContaining({ filePath, writeFailed: true })]);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(formatMirrorEntry(first) + formatMirrorEntry(hook));
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([path.basename(filePath)]);

    expect(planMarkdownRedaction(storagePath, { apply: true })).toEqual([expect.objectContaining({ filePath })]);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(redactedRows([first, hook]));
  });

  it('rewrites in place when the file cannot take a second name', async () => {
    const first = event(`call 0 with ${SECRET}`);
    const { storagePath, filePath } = await mirrorWith(first);
    mocks.linkError = errnoError('EPERM');

    const changes = planMarkdownRedaction(storagePath, { apply: true });

    expect(changes[0].writeFailed).toBeUndefined();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(redactedRows([first]));
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([path.basename(filePath)]);
  });

  it('leaves the file as it was when it cannot take a second name for another reason', async () => {
    const first = event(`call 0 with ${SECRET}`);
    const { storagePath, filePath } = await mirrorWith(first);
    mocks.linkError = errnoError('ENOSPC');

    const changes = planMarkdownRedaction(storagePath, { apply: true });

    expect(changes).toEqual([expect.objectContaining({ filePath, writeFailed: true })]);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(formatMirrorEntry(first));
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([path.basename(filePath)]);
  });

  it('reports the old file it could not delete, and a re-run deletes it', async () => {
    const first = event(`call 0 with ${SECRET}`);
    const { storagePath, filePath } = await mirrorWith(first);
    mocks.afterRename = () => { mocks.rmError = errnoError('EIO'); };

    const changes = planMarkdownRedaction(storagePath, { apply: true });

    const keptPath = keptFileIn(path.dirname(filePath));
    expect(changes).toEqual([
      expect.objectContaining({ filePath }),
      expect.objectContaining({ filePath: keptPath, writeFailed: true }),
    ]);
    expect(changes[0].writeFailed).toBeUndefined();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(redactedRows([first]));
    expect(fs.readFileSync(keptPath, 'utf8')).toContain('sk-live');

    expect(planMarkdownRedaction(storagePath, { apply: false })).toEqual([expect.objectContaining({ filePath: keptPath })]);
    expect(fs.existsSync(keptPath)).toBe(true);

    const rerun = planMarkdownRedaction(storagePath, { apply: true });

    expect(rerun).toEqual([expect.objectContaining({ filePath: keptPath })]);
    expect(rerun[0].writeFailed).toBeUndefined();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(redactedRows([first]));
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([path.basename(filePath)]);
  });

  it('reports the old file it could not put back, and a re-run adds the entries the mirror file lacks', async () => {
    const first = event(`call 0 with ${SECRET}`);
    const hook = event(`hook call with ${SECRET}`);
    const later = event('later hook entry');
    const { storagePath, filePath } = await mirrorWith(first);
    mocks.beforeWrite = () => hookAppends(filePath, hook);
    mocks.afterRename = () => {
      mocks.appendError = errnoError('ENOSPC');
      mocks.renameError = errnoError('EIO');
    };

    const changes = planMarkdownRedaction(storagePath, { apply: true });

    const keptPath = keptFileIn(path.dirname(filePath));
    expect(changes).toEqual([
      expect.objectContaining({ filePath, writeFailed: true }),
      expect.objectContaining({ filePath: keptPath, writeFailed: true }),
    ]);
    expect(fs.readFileSync(keptPath, 'utf8')).toBe(formatMirrorEntry(first) + formatMirrorEntry(hook));
    hookAppends(filePath, later);

    planMarkdownRedaction(storagePath, { apply: true });

    expect(fs.readFileSync(filePath, 'utf8')).toBe(redactedRows([first, later, hook]));
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([path.basename(filePath)]);
  });

  it('drops the second name a run killed before the swap left on the mirror file', async () => {
    const first = event(`call 0 with ${SECRET}`);
    const { storagePath, filePath } = await mirrorWith(first);
    fs.linkSync(filePath, `${filePath}.0b5e6f7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b.old`);

    planMarkdownRedaction(storagePath, { apply: true });

    expect(fs.readFileSync(filePath, 'utf8')).toBe(redactedRows([first]));
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([path.basename(filePath)]);
  });

  it('recreates the mirror file from an old file left after it was deleted', async () => {
    const first = event(`call 0 with ${SECRET}`);
    const { storagePath, filePath } = await mirrorWith(first);
    fs.renameSync(filePath, `${filePath}.0b5e6f7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b.old`);

    planMarkdownRedaction(storagePath, { apply: true });

    expect(fs.readFileSync(filePath, 'utf8')).toBe(redactedRows([first]));
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([path.basename(filePath)]);
  });
});
