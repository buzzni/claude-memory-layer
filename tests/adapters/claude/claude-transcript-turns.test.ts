import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { readTranscriptTurns } from '../../../src/adapters/claude/transcript/transcript-turns.js';

const SESSION = 'session-transcript-turns';

let root = '';
let transcriptPath = '';

function write(lines: string[]): void {
  writeFileSync(transcriptPath, lines.map((line) => `${line}\n`).join(''), 'utf8');
}

function prompt(content: unknown, timestamp: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'user', sessionId: SESSION, timestamp, message: { content }, ...extra });
}

function assistant(text: string, timestamp: string, sessionId = SESSION): string {
  return JSON.stringify({ type: 'assistant', sessionId, timestamp, message: { content: [{ type: 'text', text }] } });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cml-transcript-turns-'));
  transcriptPath = path.join(root, 'transcript.jsonl');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readTranscriptTurns', () => {
  it('groups assistant text under the prompt that opened its turn', async () => {
    write([
      prompt('first request', 't1'),
      assistant('first answer', 't2'),
      JSON.stringify({ type: 'user', sessionId: SESSION, timestamp: 't3', message: { content: [{ type: 'tool_result', content: 'x' }] } }),
      assistant('first follow-up', 't4'),
      prompt([{ type: 'text', text: 'second request' }], 't5'),
      assistant('second answer', 't6')
    ]);

    expect(await readTranscriptTurns(transcriptPath, SESSION)).toEqual([
      {
        startedAt: 't1',
        trigger: 'user',
        messages: [{ text: 'first answer', timestamp: 't2' }, { text: 'first follow-up', timestamp: 't4' }]
      },
      { startedAt: 't5', trigger: 'user', messages: [{ text: 'second answer', timestamp: 't6' }] }
    ]);
  });

  it('marks a turn opened by an automated notification with its trigger', async () => {
    write([
      prompt('<task-notification>\n<task-id>abc</task-id>\n</task-notification>', 't1'),
      assistant('notification reply', 't2')
    ]);

    const [turn] = await readTranscriptTurns(transcriptPath, SESSION);
    expect(turn.trigger).toBe('task_notification');
  });

  it('keeps text written before the first prompt as a turn without a start', async () => {
    write([assistant('resumed answer', 't1'), prompt('request', 't2')]);

    expect(await readTranscriptTurns(transcriptPath, SESSION)).toEqual([
      { trigger: 'user', messages: [{ text: 'resumed answer', timestamp: 't1' }] },
      { startedAt: 't2', trigger: 'user', messages: [] }
    ]);
  });

  it('ignores entries of another session, meta entries and malformed lines', async () => {
    write([
      prompt('request', 't1'),
      assistant('copied from the parent session', 't2', 'parent-session'),
      prompt('hook feedback', 't3', { isMeta: true }),
      '{"type":"assistant", broken',
      assistant('answer', 't4')
    ]);

    expect(await readTranscriptTurns(transcriptPath, SESSION)).toEqual([
      { startedAt: 't1', trigger: 'user', messages: [{ text: 'answer', timestamp: 't4' }] }
    ]);
  });

  it('reads only up to an end offset and skips the record it cuts', async () => {
    write([prompt('request', 't1'), assistant('kept answer', 't2'), assistant('written later', 't3')]);
    const lines = readFileSync(transcriptPath, 'utf8').split('\n');
    const cutInsideThird = lines[0].length + 1 + lines[1].length + 1 + 10;

    expect(await readTranscriptTurns(transcriptPath, SESSION, { endOffset: cutInsideThird })).toEqual([
      { startedAt: 't1', trigger: 'user', messages: [{ text: 'kept answer', timestamp: 't2' }] }
    ]);
    expect(await readTranscriptTurns(transcriptPath, SESSION, { endOffset: 0 })).toEqual([]);
  });

  it('returns no turns for a missing transcript', async () => {
    expect(await readTranscriptTurns(path.join(root, 'missing.jsonl'), SESSION)).toEqual([]);
  });
});
