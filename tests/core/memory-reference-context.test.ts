import { describe, expect, it } from 'vitest';

import {
  formatMemoryReferenceContext,
  memoryEventReferenceItem,
  memoryReferenceSummary,
  memoryReferenceTitle
} from '../../src/core/memory-reference-context.js';
import type { MemoryEvent } from '../../src/core/types.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';

function event(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: EVENT_ID,
    eventType: 'agent_response',
    sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
    timestamp: new Date('2026-08-11T03:04:05.000Z'),
    content: 'Codex 자동 적재를 구현했습니다. 전체 원문에는 아주 긴 세부 구현 내용이 이어집니다. '.repeat(40),
    canonicalKey: 'key',
    dedupeKey: 'dedupe',
    metadata: { turnId: 'turn-1234567890-long', importedFrom: '/private/transcript.jsonl' },
    ...overrides
  };
}

describe('memory reference context', () => {
  it('renders compact title, summary, source ref, and safe source location', () => {
    const source = event();
    const context = formatMemoryReferenceContext([memoryEventReferenceItem(source)], {
      heading: 'Memory index for this question',
      query: 'Codex 자동 적재'
    });

    expect(context).toContain('## Memory index for this question');
    expect(context).toContain('Title: "Codex 자동 적재를 구현했습니다."');
    expect(context).toContain('Source document: project memory event [mem:');
    expect(context).toContain('2026-08-11T03:04:05.000Z · session abcdef12 · turn turn-1234567');
    expect(context).toContain('`mem-source-ref`');
    expect(context).toContain('`mem-details`');
    expect(context).toContain('📎 Recalled memories:');
    expect(context).not.toContain('/private/transcript.jsonl');
    expect(context.length).toBeLessThan(source.content.length);
  });

  it('routes curated lessons to their own lookup tool instead of an unresolvable event citation', () => {
    const context = formatMemoryReferenceContext([{
      id: 'lesson-safe-deploy',
      type: 'lesson',
      sourceKind: 'lesson',
      content: 'Safe deployment. Verify the canary before promoting.'
    }], { heading: 'Index' });

    expect(context).toContain('curated project lesson [lesson:lesson-safe-deploy]');
    expect(context).toContain('`mem-lesson-list`');
    expect(context).toContain('project curated lesson catalog');
    expect(context).not.toContain('project memory event [mem:');
  });

  it('does not cut a title at a slash inside a source path', () => {
    expect(memoryReferenceTitle('Updated src/core/retriever.ts to preserve source locations. More details.'))
      .toBe('Updated src/core/retriever.ts to preserve source locations.');
  });

  it('omits entries without a resolvable event id', () => {
    expect(formatMemoryReferenceContext(
      [{ type: 'lesson', content: 'id가 없는 메모리' }],
      { heading: 'Index' }
    )).toBe('');
  });

  it('redacts sensitive fields and collapses code in routing text', () => {
    const content = 'Deploy policy. api_key=should-not-leak\n```ts\nconst secret = 42;\n```';
    expect(memoryReferenceTitle(content)).not.toContain('should-not-leak');
    expect(memoryReferenceSummary(content)).toContain('[code]');
    expect(memoryReferenceSummary(content)).not.toContain('const secret');
  });
});
