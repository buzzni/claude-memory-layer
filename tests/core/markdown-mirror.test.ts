import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { buildMirrorPath, MarkdownMirror } from '../../src/core/markdown-mirror.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

describe('markdown mirror', () => {
  it('builds sanitized path with defaults', () => {
    const event = {
      id: randomUUID(),
      eventType: 'user_prompt' as const,
      sessionId: 's1',
      timestamp: new Date('2026-02-24T00:49:00.000Z'),
      content: 'hello',
      canonicalKey: 'k',
      dedupeKey: 'd',
      metadata: {
        namespace: 'Team ../Prod',
        categoryPath: ['Ops & Alerts', 'Night Shift']
      }
    };

    const out = buildMirrorPath('/tmp/root', event);
    expect(out).toContain(path.join('memory', 'team-prod', 'ops-alerts', 'night-shift', '2026-02-24.md'));
  });

  it('appends without overwriting existing content', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-md-mirror-'));
    try {
      const file = path.join(root, 'memory', 'default', 'session_summary', '2026-02-24.md');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'PREEXISTING\n', 'utf8');

      const mirror = new MarkdownMirror(root);
      await mirror.append({
        id: randomUUID(),
        eventType: 'session_summary',
        sessionId: 's2',
        timestamp: new Date('2026-02-24T11:00:00.000Z'),
        content: 'summary line',
        canonicalKey: 'k2',
        dedupeKey: 'd2',
        metadata: {}
      });

      const content = await fs.readFile(file, 'utf8');
      expect(content.startsWith('PREEXISTING\n')).toBe(true);
      expect(content).toContain('summary line');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('is wired to sqlite append flow', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-md-flow-'));
    try {
      const store = new SQLiteEventStore(path.join(root, 'events.sqlite'), {
        markdownMirrorRoot: root
      });
      const ts = new Date('2026-02-24T12:00:00.000Z');
      const result = await store.append({
        eventType: 'agent_response',
        sessionId: 'sess-flow',
        timestamp: ts,
        content: 'flow content',
        metadata: { namespace: 'app', category: 'responses' }
      });

      expect(result.success).toBe(true);

      // Written before append resolves: read synchronously, without giving the event loop a turn.
      const file = path.join(root, 'memory', 'app', 'responses', '2026-02-24.md');
      expect(readFileSync(file, 'utf8')).toContain('flow content');

      await store.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('is wired to the sqlite import flow that mongo-sync pulls use', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-md-import-'));
    try {
      const store = new SQLiteEventStore(path.join(root, 'events.sqlite'), {
        markdownMirrorRoot: root
      });
      const result = await store.importEvents([{
        id: randomUUID(),
        eventType: 'user_prompt',
        sessionId: 'sess-import',
        timestamp: new Date('2026-02-24T12:00:00.000Z'),
        content: 'imported content',
        canonicalKey: 'import-k',
        dedupeKey: 'import-d',
        metadata: { namespace: 'app', category: 'prompts' }
      }]);

      expect(result.inserted).toBe(1);

      const file = path.join(root, 'memory', 'app', 'prompts', '2026-02-24.md');
      expect(readFileSync(file, 'utf8')).toContain('imported content');

      await store.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the sqlite append when the mirror write fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-md-fail-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A directory where the day's file goes makes the synchronous append throw.
      await fs.mkdir(path.join(root, 'memory', 'app', 'responses', '2026-02-24.md'), { recursive: true });
      const store = new SQLiteEventStore(path.join(root, 'events.sqlite'), {
        markdownMirrorRoot: root
      });
      const result = await store.append({
        eventType: 'agent_response',
        sessionId: 'sess-fail',
        timestamp: new Date('2026-02-24T12:00:00.000Z'),
        content: 'kept in sqlite',
        metadata: { namespace: 'app', category: 'responses' }
      });

      expect(result.success).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        '[SQLiteEventStore] markdown mirror append failed:',
        expect.objectContaining({ code: 'EISDIR' })
      );
      expect((await store.getEvent(result.eventId!))?.content).toBe('kept in sqlite');

      await store.close();
    } finally {
      warn.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the sqlite append when the mirror directory cannot be created', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cml-md-mkdir-fail-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A file where the namespace directory goes makes creating the day's directory throw.
      await fs.mkdir(path.join(root, 'memory'), { recursive: true });
      writeFileSync(path.join(root, 'memory', 'app'), 'not a directory');
      const store = new SQLiteEventStore(path.join(root, 'events.sqlite'), {
        markdownMirrorRoot: root
      });
      const result = await store.append({
        eventType: 'agent_response',
        sessionId: 'sess-mkdir-fail',
        timestamp: new Date('2026-02-24T12:00:00.000Z'),
        content: 'kept despite mkdir',
        metadata: { namespace: 'app', category: 'responses' }
      });

      expect(result.success).toBe(true);
      expect(warn).toHaveBeenCalledWith('[SQLiteEventStore] markdown mirror append failed:', expect.any(Error));
      expect((await store.getEvent(result.eventId!))?.content).toBe('kept despite mkdir');

      await store.close();
    } finally {
      warn.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
