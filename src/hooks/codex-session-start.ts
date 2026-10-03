#!/usr/bin/env node
/**
 * Codex and Claude Code currently share the SessionStart input/output envelope.
 * Keep a Codex-specific executable path so installation, trust, and removal do
 * not rely on identifying a generic Claude hook filename.
 */
import { runHook } from '../adapters/claude/hooks/hook-runtime.js';
import { formatClaudeContextHookOutput } from '../adapters/claude/hooks/hook-output.js';
import { reportRecallDiagnostic } from '../adapters/claude/hooks/recall-diagnostics.js';
import { nativeRecallOwnedByHost } from '../services/recall-host-contract.js';

void runHook({
  name: 'codex-session-start',
  recallEvent: 'SessionStart',
  fallbackOutput: '{"hookSpecificOutput":{"hookEventName":"SessionStart"}}'
}, async () => {
  if (nativeRecallOwnedByHost()) {
    reportRecallDiagnostic({ event: 'SessionStart', stage: 'complete', outcome: 'delegated', contextChars: 0 });
    return formatClaudeContextHookOutput('SessionStart', '');
  }
  const { main } = await import('../adapters/claude/hooks/session-start.js');
  const hostWorker = process.env.CLAUDE_MEMORY_RECALL_OWNER === 'host-worker';
  return main({ contextPresentation: 'reference', deliveryClient: hostWorker ? 'codex-host' : 'codex-hook', ...(hostWorker ? { maintenance: false } : {}) });
});
