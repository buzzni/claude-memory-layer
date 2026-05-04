import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTranscriptTailEntries } from '../../../src/adapters/claude/transcript/transcript-reader.js';
import {
  extractAssistantTextMessages,
  extractAssistantMessages,
  generateSessionSummary
} from '../../../src/adapters/claude/transcript/turn-reconstructor.js';

describe('Claude transcript reader', () => {
  it('reads JSONL transcript tail entries and skips malformed partial lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cml-transcript-'));
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(
      transcriptPath,
      [
        '{"type":"user","message":{"content":"hello"}}',
        'not-json',
        'null',
        '42',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"answer"}]}}'
      ].join('\n'),
      'utf8'
    );

    const entries = await readTranscriptTailEntries(transcriptPath);

    expect(entries.map((entry) => entry.type)).toEqual(['user', 'assistant']);
  });

  it('skips a partial first line when tail reading starts mid-record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cml-transcript-'));
    const transcriptPath = join(dir, 'transcript.jsonl');
    const firstLine = `{"type":"user","message":{"content":"${'x'.repeat(500)}"}}`;
    const secondLine = '{"type":"user","message":{"content":"recent question"}}';
    const thirdLine = '{"type":"assistant","message":{"content":[{"type":"text","text":"recent answer"}]}}';
    await writeFile(transcriptPath, [firstLine, secondLine, thirdLine].join('\n'), 'utf8');

    const maxBytes = Buffer.byteLength(`${secondLine}\n${thirdLine}`) + 10;
    const entries = await readTranscriptTailEntries(transcriptPath, { maxBytes });

    expect(entries.map((entry) => entry.type)).toEqual(['user', 'assistant']);
    expect(entries[0]?.message?.content).toBe('recent question');
  });

  it('returns an empty entry list for missing transcript files', async () => {
    await expect(readTranscriptTailEntries('/tmp/non-existent-claude-transcript.jsonl')).resolves.toEqual([]);
  });
});

describe('Claude turn reconstructor', () => {
  it('extracts assistant text blocks and joins multi-part text content', async () => {
    const messages = extractAssistantTextMessages([
      { type: 'user', message: { content: 'ignored' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'tool_use', id: 'tool-1' },
            { type: 'text', text: 'second' }
          ]
        }
      },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-2' }] } }
    ]);

    expect(messages).toEqual(['first\nsecond']);
  });

  it('reads assistant text messages from a transcript file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cml-transcript-'));
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(
      transcriptPath,
      '{"type":"assistant","message":{"content":[{"type":"text","text":"final answer"}]}}\n',
      'utf8'
    );

    await expect(extractAssistantMessages(transcriptPath)).resolves.toEqual(['final answer']);
  });

  it('generates deterministic summaries from session events', () => {
    const summary = generateSessionSummary([
      { eventType: 'user_prompt', content: 'How should we refactor transcript parsing?' },
      { eventType: 'agent_response', content: 'Move it behind adapter modules.' },
      { eventType: 'tool_observation', content: 'ignored' }
    ]);

    expect(summary).toBe(
      'Session with 1 user prompts and 1 responses.\n' +
      'Topics discussed:\n' +
      '- How should we refactor transcript parsing?'
    );
  });
});
