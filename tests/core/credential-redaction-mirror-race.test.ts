import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

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

const roots: string[] = [];

afterEach(() => {
  mocks.beforeWrite = undefined;
  mocks.afterRename = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SECRET = 'api_key=sk-live-1234567890abcdef';
const ORIGINAL = `## 00:00\ncall 0 with ${SECRET}\n`;

function writeMirrorFile(): { storagePath: string; filePath: string } {
  const storagePath = fs.mkdtempSync(path.join(tmpdir(), 'cml-redact-mirror-race-'));
  roots.push(storagePath);
  const dir = path.join(storagePath, 'memory', 'default', 'user_prompt');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, '2026-01-01.md');
  fs.writeFileSync(filePath, ORIGINAL, 'utf8');
  return { storagePath, filePath };
}

describe('planMarkdownRedaction while hooks append to the mirror', () => {
  it('keeps an entry a hook appends after the file was read', () => {
    const { storagePath, filePath } = writeMirrorFile();
    mocks.beforeWrite = () => fs.appendFileSync(filePath, '\n## 00:01\nhook entry\n', 'utf8');

    const changes = planMarkdownRedaction(storagePath, { apply: true });

    const content = fs.readFileSync(filePath, 'utf8');
    expect(changes).toEqual([expect.objectContaining({ filePath })]);
    expect(changes[0].writeFailed).toBeUndefined();
    expect(content).toBe(`${redactText(ORIGINAL)}\n## 00:01\nhook entry\n`);
    expect(content).not.toContain('sk-live');
  });

  it('redacts a credential in the entry appended during the rewrite', () => {
    const { storagePath, filePath } = writeMirrorFile();
    mocks.beforeWrite = () => fs.appendFileSync(filePath, `\n## 00:01\nhook call with ${SECRET}\n`, 'utf8');

    planMarkdownRedaction(storagePath, { apply: true });

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('hook call with');
    expect(content).not.toContain('sk-live');
  });

  it('keeps an entry from a hook that opened the file before the swap and wrote after it', () => {
    const { storagePath, filePath } = writeMirrorFile();
    let hookFd: number | undefined;
    mocks.beforeWrite = () => { hookFd = fs.openSync(filePath, 'a'); };
    mocks.afterRename = () => {
      fs.writeSync(hookFd!, '\n## 00:01\nslow hook entry\n');
      fs.closeSync(hookFd!);
    };

    planMarkdownRedaction(storagePath, { apply: true });

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toBe(`${redactText(ORIGINAL)}\n## 00:01\nslow hook entry\n`);
    expect(content).not.toContain('sk-live');
  });

  it('keeps an entry a hook appends after the swap and leaves no staging file', () => {
    const { storagePath, filePath } = writeMirrorFile();
    mocks.afterRename = () => fs.appendFileSync(filePath, '\n## 00:02\nlater hook entry\n', 'utf8');

    planMarkdownRedaction(storagePath, { apply: true });

    expect(fs.readFileSync(filePath, 'utf8')).toBe(`${redactText(ORIGINAL)}\n## 00:02\nlater hook entry\n`);
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['2026-01-01.md']);
  });
});
