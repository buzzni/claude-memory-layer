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

/**
 * Delivery evidence for injected memories (specs/recent-memory-patterns R3).
 *
 * Selecting and formatting a memory is not delivering it. A hook body registers
 * a reporter while it still holds the trace context; the runtime invokes it
 * after the stdout write actually settles, so `emitted` means the bytes left
 * this process and `failed` means the write reported an error. Neither claims
 * the model read anything.
 */
export type HookDeliveryOutcome = { status: 'emitted' | 'failed'; error?: unknown };
export type HookDeliveryReporter = (outcome: HookDeliveryOutcome) => void | Promise<void>;

let pendingDeliveryReporter: HookDeliveryReporter | null = null;

export function registerHookDeliveryReporter(reporter: HookDeliveryReporter | null): void {
  pendingDeliveryReporter = reporter;
}

/** Invoke and clear the registered reporter. Safe to call when none is set. */
export async function reportHookDelivery(outcome: HookDeliveryOutcome): Promise<void> {
  const reporter = pendingDeliveryReporter;
  pendingDeliveryReporter = null;
  if (!reporter) return;
  try {
    await reporter(outcome);
  } catch {
    // Delivery telemetry must never break the hook envelope.
  }
}
