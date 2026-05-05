import { describe, expect, it } from 'vitest';

import {
  isClaudeLocalCommandArtifact,
  isWorthStoringPrompt
} from '../../src/services/session-history-importer.js';

describe('session history importer prompt filtering', () => {
  it('drops Claude local-command artifacts that dilute retrieval quality', () => {
    const artifact = `<command-name>/model</command-name>\n<local-command-stdout>Using model opus</local-command-stdout>`;

    expect(isClaudeLocalCommandArtifact(artifact)).toBe(true);
    expect(isWorthStoringPrompt(artifact)).toBe(false);
  });

  it('keeps substantive imported user prompts', () => {
    expect(isWorthStoringPrompt('이 프로젝트에서 memory retrieval 구조를 더 가볍게 개선해줘')).toBe(true);
  });
});
