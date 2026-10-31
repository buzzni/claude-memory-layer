import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { readUnprocessedAssistantMessages } from '../../../src/adapters/claude/transcript/stop-transcript-cursor.js';

const SESSION = 'session-cursor-unit';

let root = '';
let transcriptPath = '';

function assistantLine(text: string): string {
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`;
}

function promptLine(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { content: text } })}\n`;
}

function toolResultLine(bytes: number): string {
  return `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(bytes) }] } })}\n`;
}

function read(options?: Parameters<typeof readUnprocessedAssistantMessages>[2]) {
  return readUnprocessedAssistantMessages(SESSION, transcriptPath, options);
}

function texts(batch: ReturnType<typeof read>): string[] {
  return batch.messages.map((message) => message.text);
}

function cursorOffset(): number {
  return JSON.parse(readFileSync(path.join(root, '.claude-code', 'memory', `.stop-cursor-${SESSION}.json`), 'utf8')).offset;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cml-stop-cursor-unit-'));
  transcriptPath = path.join(root, 'transcript.jsonl');
  vi.stubEnv('HOME', root);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('Stop transcript cursor', () => {
  it('returns nothing for a missing transcript', () => {
    expect(texts(read())).toEqual([]);
  });

  it('reads the whole current turn but no earlier turn when the session has no cursor', () => {
    writeFileSync(transcriptPath, [
      promptLine('earlier request'),
      assistantLine('earlier answer'),
      promptLine('current request'),
      assistantLine('current first'),
      toolResultLine(300 * 1024),
      assistantLine('current final')
    ].join(''));

    expect(texts(read())).toEqual(['current first', 'current final']);
  });

  it('treats a tool result as part of the turn, not as a new prompt', () => {
    writeFileSync(transcriptPath, promptLine('request') + assistantLine('before tool') + toolResultLine(10) + assistantLine('after tool'));

    expect(texts(read())).toEqual(['before tool', 'after tool']);
  });

  it('reads only what was appended after the committed cursor', () => {
    writeFileSync(transcriptPath, assistantLine('one'));
    read().commit();
    appendFileSync(transcriptPath, assistantLine('two'));

    const batch = read();
    batch.commit();

    expect(texts(batch)).toEqual(['two']);
    expect(texts(read())).toEqual([]);
  });

  it('re-reads the same range when a batch is not committed', () => {
    writeFileSync(transcriptPath, assistantLine('one'));
    read().commit();
    appendFileSync(transcriptPath, assistantLine('two'));

    read();

    expect(texts(read())).toEqual(['two']);
  });

  it('leaves a record that is still being written for the next Stop', () => {
    writeFileSync(transcriptPath, assistantLine('one'));
    read().commit();
    const pending = assistantLine('two');
    appendFileSync(transcriptPath, pending.slice(0, 20));

    const first = read();
    first.commit();
    appendFileSync(transcriptPath, pending.slice(20));

    expect(texts(first)).toEqual([]);
    expect(texts(read())).toEqual(['two']);
  });

  it('caps one read to the newest bytes of a larger backlog and moves the cursor to the end', () => {
    writeFileSync(transcriptPath, assistantLine('opening'));
    read().commit();
    appendFileSync(transcriptPath, assistantLine('dropped') + toolResultLine(4096) + assistantLine('kept'));

    const batch = read({ maxReadBytes: 2048 });
    batch.commit();

    expect(texts(batch)).toEqual(['kept']);
    expect(cursorOffset()).toBe(statSync(transcriptPath).size);
  });

  it('falls back to the current turn when a new, longer file replaces the transcript at the same path', () => {
    writeFileSync(transcriptPath, assistantLine('old one') + assistantLine('old two'));
    read().commit();

    writeFileSync(transcriptPath, assistantLine('new one') + assistantLine('new two') + assistantLine('new three'));

    // The bytes before the old offset changed, so the cursor no longer applies.
    expect(texts(read())).toEqual(['new one', 'new two', 'new three']);
  });

  it('falls back to the current turn when the transcript is shorter than the cursor', () => {
    writeFileSync(transcriptPath, assistantLine('one') + assistantLine('two') + assistantLine('three'));
    read().commit();

    writeFileSync(transcriptPath, promptLine('summary of the compacted conversation') + assistantLine('compacted'));

    expect(texts(read())).toEqual(['compacted']);
  });

  it('does not move the cursor back when an older concurrent Stop commits last', () => {
    writeFileSync(transcriptPath, assistantLine('one'));
    read().commit();
    appendFileSync(transcriptPath, assistantLine('two'));
    const slower = read();
    appendFileSync(transcriptPath, assistantLine('three'));
    const faster = read();

    faster.commit();
    slower.commit();

    expect(texts(slower)).toEqual(['two']);
    expect(texts(faster)).toEqual(['two', 'three']);
    expect(cursorOffset()).toBe(statSync(transcriptPath).size);
  });

  it('accepts an older offset once the cursor it would replace no longer matches the file', () => {
    writeFileSync(transcriptPath, assistantLine('one') + assistantLine('two'));
    read().commit();
    writeFileSync(transcriptPath, assistantLine('short'));

    read().commit();

    expect(cursorOffset()).toBe(statSync(transcriptPath).size);
  });
});
