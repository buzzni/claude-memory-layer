import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryReferenceSummary, memoryReferenceTitle } from '../../src/core/memory-reference-context.js';
import { sessionStartExcerpt } from '../../src/adapters/claude/hooks/session-start.js';
import { selectEvidencePreview } from '../../src/adapters/claude/hooks/user-prompt-submit.js';
import type { EventType, MemoryEvent } from '../../src/core/types.js';

const FLAG = 'CLAUDE_MEMORY_IDENTIFIER_EXCERPT_EXPERIMENT';
const prose = 'The sync worker pulled every document and the dashboard looked healthy. ';
const tail = 'Fixed in src/core/mongo-sync-worker.ts (commit b107516, PR #116, v2.4.17).';
const identifiersAtEnd = `${prose.repeat(10)}${tail}`;

function event(eventType: EventType, content: string): MemoryEvent {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    eventType,
    sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
    timestamp: new Date('2026-10-31T03:04:05.000Z'),
    content,
    canonicalKey: 'key',
    dedupeKey: 'dedupe'
  };
}

/** Excerpt text without the leading/trailing truncation markers. */
const body = (excerpt: string) => excerpt.replace(/^\.\.\./, '').replace(/\.\.\.$/, '');

describe(`${FLAG}=true`, () => {
  beforeEach(() => { vi.stubEnv(FLAG, 'true'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  describe('sessionStartExcerpt', () => {
    it('excerpts the identifier-dense window within the same budget', () => {
      const excerpt = sessionStartExcerpt(event('agent_response', identifiersAtEnd));

      expect(excerpt.startsWith('...')).toBe(true);
      expect(excerpt).toContain('src/core/mongo-sync-worker.ts');
      expect(excerpt).toContain('b107516');
      expect(body(excerpt).length).toBeLessThanOrEqual(400);
    });

    it('keeps the head when the head is as dense as any other window', () => {
      const content = `${tail} ${prose.repeat(10)}`;
      vi.stubEnv(FLAG, undefined);
      const legacy = sessionStartExcerpt(event('agent_response', content));
      vi.stubEnv(FLAG, 'true');

      expect(sessionStartExcerpt(event('agent_response', content))).toBe(legacy);
    });

    it('does not cut away identifiers of the chosen window at a sentence boundary', () => {
      const content = `#1 ${'word '.repeat(150)}#2 ${'word '.repeat(55)}. #3 ${'word '.repeat(100)}`;
      const excerpt = sessionStartExcerpt(event('agent_response', content));

      expect(excerpt).toContain('#2');
      expect(excerpt).toContain('#3');
    });

    it('redacts secrets before choosing the window', () => {
      const content = `${prose.repeat(10)}api_key=deadbeef1234567 then edited src/a.ts and src/b.ts for #9.`;
      const excerpt = sessionStartExcerpt(event('agent_response', content));

      expect(excerpt).not.toContain('deadbeef1234567');
      expect(excerpt).toContain('src/b.ts');
    });
  });

  describe('memoryReferenceSummary', () => {
    it('excerpts the identifier-dense window when there is no query', () => {
      const summary = memoryReferenceSummary(identifiersAtEnd);

      expect(summary).toContain('PR #116');
      expect(body(summary).length).toBeLessThanOrEqual(180);
    });

    it('excerpts the identifier-dense window when the query matches nothing', () => {
      expect(memoryReferenceSummary(identifiersAtEnd, '전혀 관련 없는 질문')).toContain('PR #116');
    });

    it('keeps the query anchor ahead of identifier density', () => {
      const content = `${prose.repeat(3)}TARGET_PORT moved to 37803. ${prose.repeat(6)}${tail}`;
      vi.stubEnv(FLAG, undefined);
      const legacy = memoryReferenceSummary(content, 'TARGET_PORT');
      vi.stubEnv(FLAG, 'true');

      expect(memoryReferenceSummary(content, 'TARGET_PORT')).toBe(legacy);
    });

    it('keeps the identifiers of a code block instead of dropping the block', () => {
      const content = 'Rebased the branch.\n```bash\ngit checkout fix/mongo-pull-cursor\ngit show b107516\n```\nDone.';

      expect(memoryReferenceSummary(content)).toBe('Rebased the branch. [code: fix/mongo-pull-cursor b107516] Done.');
      expect(memoryReferenceTitle('```\nvi src/a.ts\n```')).toBe('[code: src/a.ts]');
      expect(memoryReferenceSummary('```bash\nFILE=src/a.ts\n```')).toBe('[code: src/a.ts]');
    });
  });

  describe('selectEvidencePreview', () => {
    it('excerpts the identifier-dense window when the query matches nothing', () => {
      const preview = selectEvidencePreview(identifiersAtEnd, '전혀 관련 없는 질문', 300);

      expect(preview).toContain('src/core/mongo-sync-worker.ts');
      expect(body(preview).length).toBeLessThanOrEqual(300);
    });

    it('keeps the query anchor ahead of identifier density', () => {
      const content = `${prose.repeat(3)}TARGET_PORT moved to 37803. ${prose.repeat(6)}${tail}`;
      vi.stubEnv(FLAG, undefined);
      const legacy = selectEvidencePreview(content, 'TARGET_PORT', 160);
      vi.stubEnv(FLAG, 'true');

      expect(selectEvidencePreview(content, 'TARGET_PORT', 160)).toBe(legacy);
    });

    it('redacts secrets before excerpting', () => {
      const content = `password: hunter2-secret ${prose.repeat(10)}`;

      expect(selectEvidencePreview(content, '')).not.toContain('hunter2-secret');
    });
  });
});
