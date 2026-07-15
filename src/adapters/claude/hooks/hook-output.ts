export type ClaudeContextHookEvent = 'SessionStart' | 'UserPromptSubmit';

export interface ClaudeContextHookOutput {
  hookSpecificOutput: {
    hookEventName: ClaudeContextHookEvent;
    additionalContext?: string;
  };
}

/** Build the JSON envelope Claude Code actually consumes for context injection. */
export function formatClaudeContextHookOutput(
  hookEventName: ClaudeContextHookEvent,
  context: string
): string {
  const output: ClaudeContextHookOutput = {
    hookSpecificOutput: {
      hookEventName,
      ...(context ? { additionalContext: context } : {})
    }
  };
  return JSON.stringify(output);
}

export function isHookEvaluationMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_MEMORY_EVAL_MODE === 'true';
}
