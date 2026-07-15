import { describe, expect, it } from 'vitest';

import {
  formatClaudeContextHookOutput,
  isHookEvaluationMode
} from '../../src/adapters/claude/hooks/hook-output.js';

describe('Claude hook context output', () => {
  it('uses the official hookSpecificOutput additionalContext envelope', () => {
    expect(JSON.parse(formatClaudeContextHookOutput('UserPromptSubmit', 'memory evidence'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'memory evidence'
      }
    });
  });

  it('omits empty additionalContext and detects isolated evaluation mode', () => {
    expect(JSON.parse(formatClaudeContextHookOutput('SessionStart', ''))).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart' }
    });
    expect(isHookEvaluationMode({ CLAUDE_MEMORY_EVAL_MODE: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isHookEvaluationMode({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
