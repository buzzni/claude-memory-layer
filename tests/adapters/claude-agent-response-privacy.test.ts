import { describe, expect, it } from 'vitest';

import { normalizeAgentResponse } from '../../src/adapters/claude/hooks/agent-response-normalization.js';

/**
 * Stop and the SessionEnd reconcile both store an assistant message as
 * normalizeAgentResponse returns it, so its content is the stored row.
 */
describe('agent response privacy', () => {
  it('stores nothing after an unclosed <private> tag', () => {
    const { content, privacy } = normalizeAgentResponse('The deploy is done. <private>The approver was codename-orchid');

    expect(content).toBe('The deploy is done. [PRIVATE: unclosed]');
    expect(privacy.hasUnmatchedTags).toBe(true);
  });

  it('keeps the text after a closed <private> section', () => {
    expect(normalizeAgentResponse('Done. <private>codename-orchid</private> Next: tests.').content)
      .toBe('Done. [PRIVATE]\nNext: tests.');
  });
});
