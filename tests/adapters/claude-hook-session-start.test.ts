import { describe, expect, it } from 'vitest';
import {
  formatCoreMemoryBlockContext,
  registerSessionBestEffort,
  selectSessionStartMemories,
  sessionStartExcerpt,
  formatLessonIndexContext,
  sessionStartLessonBudget
} from '../../src/adapters/claude/hooks/session-start.js';
import type { CoreMemoryBlock, EventType, MemoryEvent } from '../../src/core/types.js';

function block(overrides: Partial<CoreMemoryBlock> = {}): CoreMemoryBlock {
  return {
    projectHash: 'proj-1',
    blockKey: 'project',
    content: 'This project uses SQLite + LanceDB.',
    sourceEventIds: [],
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides
  };
}

describe('formatCoreMemoryBlockContext', () => {
  it('returns an empty string when there are no blocks', () => {
    expect(formatCoreMemoryBlockContext([])).toBe('');
  });

  it('skips blocks whose content is empty or whitespace-only', () => {
    expect(formatCoreMemoryBlockContext([block({ content: '   ' })])).toBe('');
  });

  it('renders a labeled section per non-empty block, unconditionally (no query/scoring)', () => {
    const context = formatCoreMemoryBlockContext([
      block({ blockKey: 'project', content: 'Prefer plain function edits over new abstractions.' }),
      block({ blockKey: 'user', content: 'Terse responses, no trailing summaries.' })
    ]);

    expect(context).toContain('## Core Memory');
    expect(context).toContain('**Project**: Prefer plain function edits over new abstractions.');
    expect(context).toContain('**User**: Terse responses, no trailing summaries.');
  });

  it('drops only the empty block while keeping the non-empty one', () => {
    const context = formatCoreMemoryBlockContext([
      block({ blockKey: 'project', content: 'Kept content.' }),
      block({ blockKey: 'user', content: '' })
    ]);

    expect(context).toContain('**Project**: Kept content.');
    expect(context).not.toContain('**User**:');
  });

  it('honors summary and reference binding delivery modes without exposing direct content', () => {
    const content = 'A'.repeat(400);
    const context = formatCoreMemoryBlockContext([
      { value: block({ blockKey: 'project', content }), injectionMode: 'summary', priority: 1 },
      { value: block({ blockKey: 'user', content: 'Private user preference' }), injectionMode: 'reference', priority: 0 }
    ]);

    expect(context).toContain(`${'A'.repeat(317)}...`);
    expect(context).not.toContain(content);
    expect(context).toContain('[reference: use mem-core-block-get for user block]');
    expect(context).not.toContain('Private user preference');
  });
});

describe('registerSessionBestEffort', () => {
  it('keeps SessionStart available when the auxiliary registry cannot be written', () => {
    expect(registerSessionBestEffort('session-1', '/repo/project', () => {
      throw new Error('registry lock unavailable');
    })).toBe(false);
  });

  it('reports a successful auxiliary registration', () => {
    let registered: [string, string] | null = null;
    expect(registerSessionBestEffort('session-2', '/repo/project', (sessionId, projectPath) => {
      registered = [sessionId, projectPath];
      return 'registration-id';
    })).toBe(true);
    expect(registered).toEqual(['session-2', '/repo/project']);
  });
});

let eventSeq = 0;

function event(eventType: EventType, content: string, isoTimestamp: string): MemoryEvent {
  eventSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(eventSeq).padStart(12, '0')}`,
    eventType,
    sessionId: 'session-1',
    timestamp: new Date(isoTimestamp),
    content,
    canonicalKey: `key-${eventSeq}`,
    dedupeKey: `dedupe-${eventSeq}`
  };
}

const TOOL_JSON = '{"toolName":"Edit","toolInput":{"file_path":"/repo/src/a.ts","old_string":"const a = 1"}}';

describe('selectSessionStartMemories', () => {
  it('drops tool_observation entirely', () => {
    // Measured over 118 session-start injections: content_overlap_score was
    // exactly 0.0 for every tool_observation. Recency alone kept picking them
    // because they are ~84% of all stored events.
    const selected = selectSessionStartMemories(
      [
        event('tool_observation', TOOL_JSON, '2026-08-06T10:00:00.000Z'),
        event('agent_response', 'The crash came from a null cwd in the daemon client.', '2026-08-01T10:00:00.000Z')
      ],
      3
    );

    expect(selected.map((e) => e.eventType)).toEqual(['agent_response']);
  });

  it('drops user_prompt, which is a question without its answer', () => {
    const selected = selectSessionStartMemories(
      [event('user_prompt', 'why is the daemon restarting?', '2026-08-06T10:00:00.000Z')],
      3
    );

    expect(selected).toEqual([]);
  });

  it('drops the rule-based table-of-contents session summary', () => {
    const selected = selectSessionStartMemories(
      [
        event('session_summary', 'Session with 5 user prompts and 8 responses. Topics discussed: - foo', '2026-08-06T10:00:00.000Z'),
        event('agent_response', 'Root cause: the outbox lock was never released.', '2026-08-01T10:00:00.000Z')
      ],
      3
    );

    expect(selected.map((e) => e.eventType)).toEqual(['agent_response']);
  });

  it('drops the rule-based summary even when it has no 주요 작업 line', () => {
    // deriveSessionSummary only emits "주요 작업:" when the session had prompts.
    // A zero-prompt session yields "[date] 0턴 세션. 사용 툴: ..." — same
    // worthless shape, but it slipped past a filter anchored on 주요 작업.
    const selected = selectSessionStartMemories(
      [
        event('session_summary', '[2026-07-31] 0턴 세션. 사용 툴: Bash, Write, Edit', '2026-08-06T10:00:00.000Z'),
        event('agent_response', 'Root cause: the outbox lock was never released.', '2026-08-01T10:00:00.000Z')
      ],
      3
    );

    expect(selected.map((e) => e.eventType)).toEqual(['agent_response']);
  });

  it('does not rank a session_summary above a more recent agent_response', () => {
    // Type used to be the primary sort key, which put summaries first
    // unconditionally. Measured across six stores that dropped session-start
    // grounding from 0.0810 to 0.0084: the concrete tokens the next prompt
    // reuses live in the response, not in the summary's abstract bullets.
    const selected = selectSessionStartMemories(
      [
        event('agent_response', 'Renamed the helper to resolveHashBasisPath.', '2026-08-06T10:00:00.000Z'),
        event('session_summary', '- 결정: 워크트리 해시를 메인 체크아웃으로 리다이렉트', '2026-08-01T10:00:00.000Z')
      ],
      2
    );

    expect(selected.map((e) => e.eventType)).toEqual(['agent_response', 'session_summary']);
  });

  it('keeps at most one session_summary so summaries cannot crowd out responses', () => {
    // A real store always holds more than `limit` summaries inside the scan
    // window, so an uncapped summary preference meant agent_response was never
    // injected at all.
    const selected = selectSessionStartMemories(
      [
        event('session_summary', '- 결정: A', '2026-08-06T10:00:00.000Z'),
        event('session_summary', '- 결정: B', '2026-08-05T10:00:00.000Z'),
        event('session_summary', '- 결정: C', '2026-08-04T10:00:00.000Z'),
        event('agent_response', 'PR #1693 리뷰 완료. HEAD c0ffee12.', '2026-08-03T10:00:00.000Z'),
        event('agent_response', 'outbox lock was never released.', '2026-08-02T10:00:00.000Z')
      ],
      3
    );

    expect(selected.map((e) => e.eventType)).toEqual([
      'session_summary',
      'agent_response',
      'agent_response'
    ]);
    expect(selected[0].content).toBe('- 결정: A');
  });

  it('still injects the summary when it is the only usable memory', () => {
    const selected = selectSessionStartMemories(
      [event('session_summary', '- 결정: 워크트리 해시를 메인 체크아웃으로 리다이렉트', '2026-08-01T10:00:00.000Z')],
      3
    );

    expect(selected.map((e) => e.eventType)).toEqual(['session_summary']);
  });

  it('drops a duplicate memory rather than injecting the same bullet twice', () => {
    // The same outcome gets stored more than once (a Stop-hook write and the
    // crash backfill land as distinct events with byte-identical text).
    // Observed in production as one bullet repeated back-to-back in a recap.
    const selected = selectSessionStartMemories(
      [
        event('agent_response', 'Root cause: the outbox lock was never released.', '2026-08-06T10:00:00.000Z'),
        event('agent_response', 'Root cause: the outbox lock was never released.', '2026-08-05T10:00:00.000Z'),
        event('agent_response', 'distinct finding', '2026-08-04T10:00:00.000Z')
      ],
      3
    );

    expect(selected.map((e) => e.content)).toEqual([
      'Root cause: the outbox lock was never released.',
      'distinct finding'
    ]);
  });

  it('treats memories that differ only in whitespace as duplicates', () => {
    const selected = selectSessionStartMemories(
      [
        event('agent_response', 'Root cause:  the  lock leaked.', '2026-08-06T10:00:00.000Z'),
        event('agent_response', 'Root cause: the lock leaked.\n', '2026-08-05T10:00:00.000Z')
      ],
      3
    );

    expect(selected).toHaveLength(1);
  });

  it('orders newest first', () => {
    const selected = selectSessionStartMemories(
      [
        event('agent_response', 'older finding', '2026-08-01T10:00:00.000Z'),
        event('agent_response', 'newer finding', '2026-08-06T10:00:00.000Z')
      ],
      2
    );

    expect(selected.map((e) => e.content)).toEqual(['newer finding', 'older finding']);
  });

  it('honours the limit', () => {
    const selected = selectSessionStartMemories(
      [
        event('agent_response', 'a', '2026-08-06T10:00:00.000Z'),
        event('agent_response', 'b', '2026-08-05T10:00:00.000Z'),
        event('agent_response', 'c', '2026-08-04T10:00:00.000Z')
      ],
      2
    );

    expect(selected).toHaveLength(2);
  });

  it('returns nothing rather than padding with unusable events', () => {
    expect(
      selectSessionStartMemories(
        [
          event('tool_observation', TOOL_JSON, '2026-08-06T10:00:00.000Z'),
          event('user_prompt', 'fix it', '2026-08-05T10:00:00.000Z')
        ],
        3
      )
    ).toEqual([]);
  });
});

describe('sessionStartExcerpt', () => {
  it('keeps a short memory verbatim, with no truncation marker', () => {
    const content = 'Root cause: the outbox lock was never released.';
    expect(sessionStartExcerpt(event('agent_response', content, '2026-08-06T10:00:00.000Z'))).toBe(content);
  });

  it('gives session summaries a larger budget than agent responses', () => {
    const long = 'x'.repeat(4000);
    const summary = sessionStartExcerpt(event('session_summary', long, '2026-08-06T10:00:00.000Z'));
    const response = sessionStartExcerpt(event('agent_response', long, '2026-08-06T10:00:00.000Z'));

    expect(summary.length).toBeGreaterThan(response.length);
  });

  it('no longer cuts at the old 150-character boundary that split raw JSON mid-token', () => {
    const content = 'A'.repeat(600);
    expect(sessionStartExcerpt(event('agent_response', content, '2026-08-06T10:00:00.000Z')).length)
      .toBeGreaterThan(150);
  });

  it('marks truncation with an ellipsis', () => {
    expect(sessionStartExcerpt(event('agent_response', 'y'.repeat(4000), '2026-08-06T10:00:00.000Z')))
      .toMatch(/\.\.\.$/);
  });

  it('collapses newlines so one memory stays one bullet', () => {
    expect(sessionStartExcerpt(event('session_summary', '- 결정: A\n- 제약: B', '2026-08-06T10:00:00.000Z')))
      .toBe('- 결정: A / - 제약: B');
  });
});

// specs/lesson-recall-hooks R1 — hermes MEMORY.md 처럼 예산 안에서 인덱스를 통째로, 본문은 요청 시.
describe('formatLessonIndexContext', () => {
  const lessons = [
    { name: '자동 병합 성공은 양쪽 변경이 살아남았다는 증거가 아니다', trigger: '공유 브랜치에서 push 가 거부되어 원격을 병합할 때' },
    { name: 'assertion-flake-is-interference-not-load', trigger: '전체 스위트에서만 깨지고 단독 실행하면 통과하는 테스트를 만났을 때' }
  ];

  it('lists name and trigger for each lesson under a Project Lessons heading', () => {
    const out = formatLessonIndexContext(lessons, { budgetChars: 2400, totalCount: 2 });
    expect(out).toContain('## Project Lessons');
    expect(out).toContain('자동 병합 성공은 양쪽 변경이 살아남았다는 증거가 아니다 — 공유 브랜치에서');
    expect(out).toContain('assertion-flake-is-interference-not-load — 전체 스위트에서만');
  });

  it('tells the model how to open a lesson body and how many were not shown', () => {
    const out = formatLessonIndexContext(lessons, { budgetChars: 2400, totalCount: 151 });
    expect(out).toContain('mem-lesson-get');
    expect(out).toMatch(/151/);
  });

  it('stops adding items once the budget would be exceeded and reports the shown count', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `lesson-${i}`, trigger: 'x'.repeat(60) }));
    const out = formatLessonIndexContext(many, { budgetChars: 600, totalCount: 40 });
    expect(out.length).toBeLessThanOrEqual(600);
    const shown = (out.match(/^- lesson-/gm) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(40);
    expect(out).toContain(`${shown}`);
  });

  it('clips a long trigger instead of letting one lesson eat the budget', () => {
    const out = formatLessonIndexContext(
      [{ name: 'n', trigger: 't'.repeat(400) }], { budgetChars: 2400, totalCount: 1 }
    );
    expect(out).not.toContain('t'.repeat(200));
    expect(out).toContain('…');
  });

  it('returns nothing when the budget is zero or there are no lessons', () => {
    expect(formatLessonIndexContext(lessons, { budgetChars: 0, totalCount: 2 })).toBe('');
    expect(formatLessonIndexContext([], { budgetChars: 2400, totalCount: 0 })).toBe('');
  });
});

describe('sessionStartLessonBudget', () => {
  it('defaults to 2400 characters, close to hermes MEMORY.md 2200', () => {
    expect(sessionStartLessonBudget({})).toBe(2400);
  });
  it('honours an explicit override and lets 0 switch the index off', () => {
    expect(sessionStartLessonBudget({ CLAUDE_MEMORY_SESSION_START_LESSON_BUDGET: '900' })).toBe(900);
    expect(sessionStartLessonBudget({ CLAUDE_MEMORY_SESSION_START_LESSON_BUDGET: '0' })).toBe(0);
  });
  it('falls back to the default on garbage', () => {
    expect(sessionStartLessonBudget({ CLAUDE_MEMORY_SESSION_START_LESSON_BUDGET: 'lots' })).toBe(2400);
    expect(sessionStartLessonBudget({ CLAUDE_MEMORY_SESSION_START_LESSON_BUDGET: '-5' })).toBe(2400);
  });
});
