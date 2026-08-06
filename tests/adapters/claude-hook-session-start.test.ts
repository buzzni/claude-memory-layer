import { describe, expect, it } from 'vitest';
import {
  formatCoreMemoryBlockContext,
  selectSessionStartMemories,
  sessionStartExcerpt
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

  it('prefers a real session_summary over a more recent agent_response', () => {
    const selected = selectSessionStartMemories(
      [
        event('agent_response', 'Renamed the helper to resolveHashBasisPath.', '2026-08-06T10:00:00.000Z'),
        event('session_summary', '- 결정: 워크트리 해시를 메인 체크아웃으로 리다이렉트', '2026-08-01T10:00:00.000Z')
      ],
      2
    );

    expect(selected.map((e) => e.eventType)).toEqual(['session_summary', 'agent_response']);
  });

  it('orders newest first inside the same tier', () => {
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
