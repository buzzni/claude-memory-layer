import { describe, expect, it } from 'vitest';
import type { MemoryLesson } from '../../src/core/types.js';
import type { CanonicalMemoryInjection } from '../../src/core/operations/canonical-memory-injection-service.js';

const { appendCuratedLessons } = await import('../../src/extensions/mcp/handlers.js');

// specs/lesson-learning-reliability R4 — 전달한 lesson ID 는 mem-lesson-get 으로 조회 가능해야 하고
// event 조회 경로(mem-details / mem-source-ref)나 카탈로그 페이징과 혼동되면 안 된다.
function injection(mode: 'direct' | 'summary' | 'reference'): CanonicalMemoryInjection<MemoryLesson> {
  return {
    priority: 0,
    injectionMode: mode,
    value: {
      lessonId: 'l-old', projectHash: 'p', name: 'preview 포트 충돌 복구 절차',
      trigger: 'preview 서버가 EADDRINUSE 로 죽을 때', steps: ['남은 프로세스를 정리해 포트를 회수한다'],
      confidence: 1, sourceSessionIds: [], sourceEventIds: [], failureModes: [], skillCandidate: false,
      sourceClass: 'curated', createdAt: new Date('2026-08-01T00:00:00Z'), updatedAt: new Date('2026-08-01T00:00:00Z')
    }
  };
}

describe('context pack curated lesson section', () => {
  it.each(['direct', 'summary'] as const)('keeps applicability and counterexamples in %s output', mode => {
    const item = injection(mode);
    Object.assign(item.value, { scope: 'Development only', validation: ['Verify the owner first'], reconsiderWhen: 'Ownership changed', failureModes: ['Never stop a production listener'], steps: ['First', 'Second', 'Third'] });
    const lines: string[] = [];
    appendCuratedLessons(lines, [item]);
    const text = lines.join('\n');
    for (const value of ['Development only', 'Verify the owner first', 'Ownership changed', 'Never stop a production listener']) expect(text).toContain(value);
    if (mode === 'summary') expect(text).toContain('Partial');
  });

  it('marks a six-step direct lesson as partial when only five steps fit', () => {
    const item = injection('direct');
    item.value.steps = ['One', 'Two', 'Three', 'Four', 'Five', 'Required final check'];
    const lines: string[] = [];
    appendCuratedLessons(lines, [item]);
    expect(lines.join('\n')).toContain('Partial lesson');
  });

  it('본문 조회는 그 lessonId 로 mem-lesson-get 을 쓰라고 안내한다', () => {
    const lines: string[] = [];
    appendCuratedLessons(lines, [injection('direct')]);
    const text = lines.join('\n');
    expect(text).toContain('- [lesson:l-old] preview 포트 충돌 복구 절차');
    expect(text).toContain('mem-lesson-get');
    expect(text).toContain('lessonId');
    expect(text).not.toContain('mem-details');
    expect(text).not.toContain('mem-source-ref');
  });

  it('reference 모드에서도 단건 조회 경로를 안내한다', () => {
    const lines: string[] = [];
    appendCuratedLessons(lines, [injection('reference')]);
    expect(lines.join('\n')).toContain('mem-lesson-get');
    expect(lines.join('\n')).not.toContain('EADDRINUSE');
    expect(lines.join('\n')).not.toContain('남은 프로세스');
  });

  it('교훈이 없으면 섹션 자체를 만들지 않는다', () => {
    const lines: string[] = [];
    appendCuratedLessons(lines, []);
    expect(lines).toEqual([]);
  });
});
