import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { buildMirrorPath, MarkdownMirror } from '../src/core/markdown-mirror.js';
import { SQLiteEventStore } from '../src/core/sqlite-event-store.js';

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

      // mirror append is async fire-and-forget; allow small delay
      await new Promise((r) => setTimeout(r, 50));

      const file = path.join(root, 'memory', 'app', 'responses', '2026-02-24.md');
      const content = await fs.readFile(file, 'utf8');
      expect(content).toContain('flow content');

      await store.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
