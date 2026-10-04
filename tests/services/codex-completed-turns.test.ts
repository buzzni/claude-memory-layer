import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CodexCompletedTurnError, parseCodexCompletedTurns, readCodexCompletedTurns
} from '../../src/services/codex-completed-turns.js';

const options = { sessionId: 'session-one', throughTurnId: 'turn-two' };
const time = '2026-10-04T08:00:00.000Z';
const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: time, type, payload });
const meta = (id = options.sessionId, cwd = '/repo/project') => line('session_meta', { id, cwd });
const start = (id: string) => line('event_msg', { type: 'task_started', turn_id: id });
const complete = (id: string, response?: string) => line('event_msg', {
  type: 'task_complete', turn_id: id, ...(response !== undefined ? { last_agent_message: response } : {})
});
const context = (id: string, cwd = '/repo/project') => line('turn_context', { turn_id: id, cwd });
const message = (role: string, text: string, phase?: string) => line('response_item', {
  type: 'message', role, ...(phase ? { phase } : {}),
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }]
});
const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

describe('completed Codex transcript frames', () => {
  it('imports completed frames with stable native ids only through the acknowledged turn', () => {
    const parsed = parseCodexCompletedTurns([
      meta(), start('turn-one'), context('turn-one'), message('user', 'first question'),
      message('assistant', 'progress', 'commentary'), message('assistant', 'first answer', 'final_answer'),
      complete('turn-one', 'first answer'), start('turn-two'), context('turn-two'),
      message('user', 'second question'), message('user', 'steering question'),
      message('assistant', 'second answer', 'final_answer'), complete('turn-two'),
      start('turn-three'), message('user', 'later question'), complete('turn-three', 'later answer')
    ], options);
    expect(parsed).toEqual({ sessionId: options.sessionId, cwd: '/repo/project', turns: [
      { turnId: 'turn-one', cwd: '/repo/project', userMessages: ['first question'], assistantResponse: 'first answer', startedAt: time, completedAt: time },
      { turnId: 'turn-two', cwd: '/repo/project', userMessages: ['second question', 'steering question'], assistantResponse: 'second answer', startedAt: time, completedAt: time }
    ] });
  });

  it('ignores aborted, orphaned fork-history and superseded unfinished frames', () => {
    const parsed = parseCodexCompletedTurns([
      meta(), complete('copied-history', 'parent answer'), start('aborted'), message('user', 'aborted question'),
      line('event_msg', { type: 'turn_aborted', turn_id: 'aborted' }), complete('aborted', 'not durable'),
      start('unfinished'), message('user', 'unfinished question'), start('turn-two'),
      message('user', 'completed question'), complete('turn-two', 'completed answer')
    ], options);
    expect(parsed.turns.map(t => t.turnId)).toEqual(['turn-two']);
    expect(parsed.turns[0].assistantResponse).toBe('completed answer');
  });

  it('uses epoch-ms lifecycle timestamps from the actual Codex payload', () => {
    const parsed = parseCodexCompletedTurns([
      meta(), line('event_msg', { type: 'task_started', turn_id: 'turn-two', started_at: Date.parse(time) - 1000 }),
      message('user', 'question'), line('event_msg', { type: 'task_complete', turn_id: 'turn-two', completed_at: Date.parse(time) + 1000, last_agent_message: 'answer' })
    ], options);
    expect(parsed.turns[0].startedAt).toBe('2026-10-04T07:59:59.000Z');
    expect(parsed.turns[0].completedAt).toBe('2026-10-04T08:00:01.000Z');
  });

  it('also accepts Unix-second lifecycle timestamps without moving source activity to 1970', () => {
    const parsed = parseCodexCompletedTurns([
      meta(), line('event_msg', { type: 'task_started', turn_id: 'turn-two', started_at: Date.parse(time) / 1000 - 1 }),
      message('user', 'question'), line('event_msg', { type: 'task_complete', turn_id: 'turn-two', completed_at: Date.parse(time) / 1000 + 1 })
    ], options);
    expect(parsed.turns[0].startedAt).toBe('2026-10-04T07:59:59.000Z');
    expect(parsed.turns[0].completedAt).toBe('2026-10-04T08:00:01.000Z');
  });

  it('rejects a mismatched thread before reconstructing its messages', () => {
    expect(() => parseCodexCompletedTurns([meta('different-session'), start('turn-two'), complete('turn-two')], options))
      .toThrowError(new CodexCompletedTurnError('session_mismatch'));
  });

  it('uses the explicit sub-agent suffix boundary to exclude inherited parent turns', () => {
    const ownMeta = line('session_meta', {
      id: options.sessionId, cwd: '/repo/project', forked_from_id: 'parent-thread', parent_thread_id: 'parent-thread',
      thread_source: 'subagent', subagent_history_start_ordinal: 6
    });
    const parsed = parseCodexCompletedTurns([
      ownMeta, meta('parent-thread'), start('inherited-turn'), message('user', 'inherited question'),
      message('assistant', 'inherited answer', 'final_answer'), complete('inherited-turn'),
      line('event_msg', { type: 'thread_settings_applied' }), start('turn-two'), message('user', 'own question'),
      complete('turn-two', 'own answer')
    ], options);
    expect(parsed.turns.map(t => t.turnId)).toEqual(['turn-two']);
    expect(parsed.turns[0].userMessages).toEqual(['own question']);
  });

  it('fails closed on forks without a verified own suffix boundary', () => {
    const forkMeta = (extra: Record<string, unknown>) => line('session_meta', {
      id: options.sessionId, cwd: '/repo/project', forked_from_id: 'parent-thread', ...extra
    });
    for (const extra of [
      {}, { thread_source: 'subagent', parent_thread_id: 'parent-thread', subagent_history_start_ordinal: 1 },
      { thread_source: 'subagent', parent_thread_id: 'other-thread', subagent_history_start_ordinal: 6 },
      { thread_source: 'subagent', parent_thread_id: 'parent-thread', subagent_history_start_ordinal: -1 },
      { thread_source: 'subagent', parent_thread_id: 'parent-thread', subagent_history_start_ordinal: 3.5 }
    ]) {
      expect(() => parseCodexCompletedTurns([forkMeta(extra), start('turn-two'), complete('turn-two')], options))
        .toThrowError('invalid_transcript');
    }
  });

  it('rejects mismatched copied headers and an ordinal beyond the own transcript', () => {
    const ownMeta = line('session_meta', {
      id: options.sessionId, cwd: '/repo/project', forked_from_id: 'parent-thread', parent_thread_id: 'parent-thread',
      thread_source: 'subagent', subagent_history_start_ordinal: 6
    });
    expect(() => parseCodexCompletedTurns([ownMeta, meta('unrelated-thread')], options)).toThrowError('invalid_transcript');
    expect(() => parseCodexCompletedTurns([ownMeta, meta('parent-thread'), '', start('turn-two'), complete('turn-two')], options))
      .toThrowError('invalid_transcript');
    expect(() => parseCodexCompletedTurns([ownMeta, meta('parent-thread'), '{malformed copied prefix'], options))
      .toThrowError('invalid_transcript');
    expect(() => parseCodexCompletedTurns([ownMeta, meta('parent-thread'), start('turn-two'), complete('turn-two')], options))
      .toThrowError('incomplete_turn');
  });

  it('requires valid metadata and a completed acknowledged frame before returning prior turns', () => {
    expect(() => parseCodexCompletedTurns([start('turn-two'), complete('turn-two')], options))
      .toThrowError(new CodexCompletedTurnError('invalid_transcript'));
    expect(() => parseCodexCompletedTurns([meta(), start('turn-one'), complete('turn-one'), start('turn-two')], options))
      .toThrowError(new CodexCompletedTurnError('incomplete_turn'));
    expect(() => parseCodexCompletedTurns([meta(), complete('turn-two')], options))
      .toThrowError(new CodexCompletedTurnError('incomplete_turn'));
  });

  it('does not combine unrelated completion ids, context ids or developer/tool text', () => {
    const parsed = parseCodexCompletedTurns([
      meta(), start('turn-two'), context('another-turn', '/unrelated'),
      message('developer', 'private instructions'), message('tool', 'tool output'),
      message('user', 'question'), message('assistant', 'legacy answer'), complete('another-turn', 'stale answer'),
      context('turn-two', '/repo/project/subdir'), complete('turn-two')
    ], options);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]).toMatchObject({ cwd: '/repo/project/subdir', userMessages: ['question'], assistantResponse: 'legacy answer' });
  });

  it('does not store commentary in place of a final answer and uses the completion fallback once', () => {
    const parsed = parseCodexCompletedTurns([
      meta(), start('turn-one'), message('user', 'first question'), message('assistant', 'commentary only', 'commentary'),
      complete('turn-one'), start('turn-two'), message('user', 'second question'),
      message('assistant', 'more commentary', 'commentary'), complete('turn-two', 'actual final answer')
    ], options);
    expect(parsed.turns[0].assistantResponse).toBe('');
    expect(parsed.turns[1].assistantResponse).toBe('actual final answer');
  });

  it('rejects malformed or invalid active frames without exposing their private contents', () => {
    const transcript = [meta(), start('turn-two'), message('user', 'question'), '{private incomplete data', complete('turn-two')];
    expect(() => parseCodexCompletedTurns(transcript, options)).toThrowError('incomplete_turn');
    expect(() => parseCodexCompletedTurns([meta(), start('turn-two'), context('turn-two', ''), complete('turn-two')], options))
      .toThrowError('incomplete_turn');
    expect(() => parseCodexCompletedTurns([meta(), start('turn-two'), '{"type":"response_item","payload":null}', complete('turn-two')], options))
      .toThrowError('incomplete_turn');
  });

  it('rejects a partially malformed message rather than saving only its valid text blocks', () => {
    const malformed = line('response_item', { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'valid fragment' }, { type: 'input_text', text: { malformed: true } }
    ] });
    expect(() => parseCodexCompletedTurns([meta(), start('turn-two'), malformed, complete('turn-two', 'answer')], options))
      .toThrowError('incomplete_turn');
    const withImage = line('response_item', { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'actual request' }, { type: 'input_image', image_url: 'fixture-image' }
    ] });
    expect(parseCodexCompletedTurns([meta(), start('turn-two'), withImage, complete('turn-two', 'answer')], options).turns[0].userMessages)
      .toEqual(['actual request']);
  });

  it('streams a real file without reading later unacknowledged records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cml-completed-turns-')); paths.push(dir);
    const file = join(dir, 'rollout.jsonl');
    await writeFile(file, [meta(), start('turn-two'), message('user', 'question'), complete('turn-two', 'answer'), '{malformed later data'].join('\n'));
    const parsed = await readCodexCompletedTurns(file, options);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].assistantResponse).toBe('answer');
  });

  it('returns only safe classifications for missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cml-completed-turns-')); paths.push(dir);
    await expect(readCodexCompletedTurns(join(dir, 'private-missing.jsonl'), options))
      .rejects.toThrowError(new CodexCompletedTurnError('invalid_transcript'));
  });
});
