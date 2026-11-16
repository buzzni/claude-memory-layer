/**
 * Capture policy: which hook inputs are not stored.
 *
 * Skipping means "do not store", never "block the session": a caller that
 * skips still emits its normal hook output.
 *
 * A subagent is recognized by `agent_id`, which Claude Code adds to the input
 * of hooks that fire inside a subagent (PreToolUse/PostToolUse; verified with
 * Claude Code 2.1.325). `agent_type` alone is not a subagent signal: a main
 * session started with `claude --agent <name>` carries it too.
 */

import { loadMemoryOperationsConfig } from '../../../services/operations-config-loader.js';

export const CAPTURE_SKIP_REASONS = ['subagent'] as const;
export type CaptureSkipReason = typeof CAPTURE_SKIP_REASONS[number];

export interface CapturePolicy {
  /** Subagent `agent_type` values to skip; '*' matches every subagent. */
  skipSubagentTypes: readonly string[];
}

export type CaptureDecision = { capture: true } | { capture: false; reason: CaptureSkipReason };

export const NO_CAPTURE_SKIPS: CapturePolicy = { skipSubagentTypes: [] };

/** operations.json `capturePolicy`; skips nothing when the file is absent or invalid. */
export function loadCapturePolicy(): CapturePolicy {
  return loadMemoryOperationsConfig()?.capturePolicy ?? NO_CAPTURE_SKIPS;
}

export function decideCapture(
  input: { agent_id?: unknown; agent_type?: unknown },
  policy: CapturePolicy
): CaptureDecision {
  if (typeof input.agent_id !== 'string' || input.agent_id === '') return { capture: true };
  const agentType = typeof input.agent_type === 'string' ? input.agent_type : '';
  const skipped = policy.skipSubagentTypes.some((type) => type === '*' || type === agentType);
  return skipped ? { capture: false, reason: 'subagent' } : { capture: true };
}
