import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { normalizeAgentResponse } from '../../src/adapters/claude/hooks/agent-response-normalization.js';
import { redactForStorage } from '../../src/adapters/claude/hooks/user-prompt-submit.js';
import { buildMirrorPath } from '../../src/core/markdown-mirror.js';
import { planPromptStorage } from '../../src/core/prompt-normalizer.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import type { MemoryEventInput } from '../../src/core/types.js';

/**
 * #269: text after an unclosed `<private>` tag must reach none of the stored
 * copies: the events row, its full-text index entry and the Markdown mirror.
 * Each text goes through the function its writer stores it with: the
 * UserPromptSubmit hook, the session-history importer and the Stop hook (the
 * SessionEnd reconcile uses the same one). The tool paths are covered end to
 * end in claude-post-tool-use-privacy.test.ts.
 */

const roots: string[] = [];
const stores: SQLiteEventStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function storedCopies(input: MemoryEventInput): Promise<{ row: string; fts: string; mirror: string }> {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-unclosed-private-'));
  roots.push(root);
  const store = new SQLiteEventStore(path.join(root, 'events.sqlite'), { markdownMirrorRoot: root });
  stores.push(store);
  const { eventId } = await store.append(input);

  const db = store.getDatabase();
  const row = (db.prepare('SELECT content FROM events WHERE id = ?').get(eventId) as { content: string }).content;
  const fts = (db.prepare('SELECT content FROM events_fts WHERE event_id = ?').get(eventId) as { content: string }).content;
  const mirrorFile = buildMirrorPath(root, { ...input, id: eventId! } as Parameters<typeof buildMirrorPath>[1]);
  // The mirror append is fire-and-forget: wait for the entry (#281).
  const mirror = await vi.waitFor(() => readFileSync(mirrorFile, 'utf8'), { timeout: 10_000 });
  return { row, fts, mirror };
}

const event = (eventType: MemoryEventInput['eventType'], content: string): MemoryEventInput => ({
  eventType,
  sessionId: 'session-unclosed-private',
  timestamp: new Date('2026-11-21T00:00:00.000Z'),
  content
});

const PROMPT = 'Explain the approval flow. <private>The prod approver is codename-orchid\nand the backup is codename-lily';

describe('unclosed <private> tag in stored copies', () => {
  it.each([
    ['UserPromptSubmit', redactForStorage(PROMPT)],
    ['session-history importer', planPromptStorage(PROMPT).storedText]
  ])('keeps the prompt text after the tag out of the row, the index and the mirror (%s)', async (_writer, stored) => {
    const copies = await storedCopies(event('user_prompt', stored));

    expect(copies.row).toBe('Explain the approval flow. [PRIVATE: unclosed]');
    for (const copy of Object.values(copies)) {
      expect(copy).toContain('[PRIVATE: unclosed]');
      expect(copy).not.toContain('codename-orchid');
      expect(copy).not.toContain('codename-lily');
    }
  });

  it('keeps the response text after the tag out of the row, the index and the mirror', async () => {
    const { content, privacy } = normalizeAgentResponse('Deployed. <private>Signed off by codename-orchid');
    const copies = await storedCopies(event('agent_response', content));

    expect(privacy.hasUnmatchedTags).toBe(true);
    expect(copies.row).toBe('Deployed. [PRIVATE: unclosed]');
    for (const copy of Object.values(copies)) {
      expect(copy).toContain('[PRIVATE: unclosed]');
      expect(copy).not.toContain('codename-orchid');
    }
  });
});
