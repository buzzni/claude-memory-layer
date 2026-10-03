import type { ClaudeContextHookEvent } from './hook-output.js';

type RecallStage = 'input' | 'registry' | 'service' | 'retrieval' | 'complete' | 'runtime';
type RecallOutcome = 'selected' | 'empty' | 'skipped' | 'delegated' | 'error';
const ERROR_CODES = new Set([
  'EPERM', 'EACCES', 'SQLITE_CANTOPEN', 'SQLITE_READONLY', 'SQLITE_BUSY',
  'SQLITE_LOCKED', 'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'invalid_input', 'timeout'
]);

/** Never serialize exceptions: their messages/stacks often contain store paths. */
export function reportRecallDiagnostic(input: {
  event: ClaudeContextHookEvent;
  stage: RecallStage;
  outcome: RecallOutcome;
  contextChars?: number;
  error?: unknown;
}): void {
  const owner = process.env.CLAUDE_MEMORY_RECALL_OWNER;
  const mode = owner === 'host' || owner === 'host-worker' ? owner : 'native';
  const code = input.error && typeof input.error === 'object' && 'code' in input.error
    ? (input.error as { code: unknown }).code : undefined;
  const errorCode = typeof code === 'string' && ERROR_CODES.has(code) ? code : 'other';
  const record = {
    version: 1,
    event: input.event,
    stage: input.stage,
    outcome: input.outcome,
    mode,
    ...(input.contextChars !== undefined ? { contextChars: input.contextChars } : {}),
    ...(input.error !== undefined ? { errorCode } : {})
  };
  try {
    console.error(`[cml-recall] ${JSON.stringify(record)}`);
  } catch {
    // Diagnostics must not interfere with the single safe stdout envelope.
  }
}
