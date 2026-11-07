import { describe, expect, it } from 'vitest';
import {
  extractAssistantTextMessages,
  generateSessionSummary
} from '../../../src/adapters/claude/transcript/turn-reconstructor.js';

describe('Claude turn reconstructor', () => {
  it('extracts assistant text blocks and joins multi-part text content', () => {
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

    expect(messages).toEqual([{ text: 'first\nsecond' }]);
  });

  it('keeps each assistant entry at its own transcript timestamp', () => {
    const messages = extractAssistantTextMessages([
      { type: 'user', timestamp: '2026-10-01T09:00:00.000Z', message: { content: 'question' } },
      { type: 'assistant', timestamp: '2026-10-01T09:00:05.000Z', message: { content: [{ type: 'text', text: 'looking' }] } },
      { type: 'assistant', timestamp: '2026-10-01T09:00:06.000Z', message: { content: [{ type: 'tool_use', id: 'tool-1' }] } },
      { type: 'assistant', timestamp: '2026-10-01T09:03:40.000Z', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'untimed' }] } }
    ]);

    expect(messages).toEqual([
      { text: 'looking', timestamp: '2026-10-01T09:00:05.000Z' },
      { text: 'done', timestamp: '2026-10-01T09:03:40.000Z' },
      { text: 'untimed' }
    ]);
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
