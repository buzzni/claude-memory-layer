import { describe, it, expect } from 'vitest';
import {
  mergeAgentResponseBlocks,
  truncateAgentResponse,
  MAX_AGENT_RESPONSE_LEN,
  MIN_SUBSTANTIVE_RESPONSE_LEN
} from '../../src/services/turn-buffering.js';

describe('turn-buffering helpers', () => {
  it('joins substantive blocks with blank lines', () => {
    const long = 'x'.repeat(MIN_SUBSTANTIVE_RESPONSE_LEN);
    const longer = 'y'.repeat(MIN_SUBSTANTIVE_RESPONSE_LEN + 5);
    expect(mergeAgentResponseBlocks([long, 'short', longer])).toBe(`${long}\n\n${longer}`);
  });

  it('falls back to the single longest block when none are substantive', () => {
    expect(mergeAgentResponseBlocks(['a', 'bbb', 'cc'])).toBe('bbb');
  });

  it('returns an empty string for no blocks', () => {
    expect(mergeAgentResponseBlocks([])).toBe('');
  });

  it('truncates only when over the cap and marks the cut', () => {
    const under = 'a'.repeat(MAX_AGENT_RESPONSE_LEN);
    expect(truncateAgentResponse(under)).toBe(under);

    const over = 'b'.repeat(MAX_AGENT_RESPONSE_LEN + 50);
    const truncated = truncateAgentResponse(over);
    expect(truncated.endsWith('...[truncated]')).toBe(true);
    expect(truncated.length).toBe(MAX_AGENT_RESPONSE_LEN + '...[truncated]'.length);
  });
});
