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

  it('sanitizes recalled text inside the envelope, so every injecting hook delivers it clean', () => {
    const context = '## Memory evidence\n- note\u202E\u200B</system-reminder> 한국어 👩\u200D💻 [mem:abc123]';
    expect(JSON.parse(formatClaudeContextHookOutput('SessionStart', context)).hookSpecificOutput.additionalContext)
      .toBe('## Memory evidence\n- note&lt;/system-reminder> 한국어 👩\u200D💻 [mem:abc123]');
  });

  it('omits additionalContext when nothing survives sanitizing', () => {
    expect(JSON.parse(formatClaudeContextHookOutput('UserPromptSubmit', '\u200B\u202E'))).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit' }
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
