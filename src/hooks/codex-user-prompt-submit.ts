#!/usr/bin/env node
/** Codex prompt-time retrieval with compact, on-demand memory references. */
import { runHook } from '../adapters/claude/hooks/hook-runtime.js';
import { formatClaudeContextHookOutput } from '../adapters/claude/hooks/hook-output.js';
import { reportRecallDiagnostic } from '../adapters/claude/hooks/recall-diagnostics.js';
import { nativeRecallOwnedByHost } from '../services/recall-host-contract.js';

void runHook({
  name: 'codex-user-prompt-submit',
  recallEvent: 'UserPromptSubmit',
  fallbackOutput: '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit"}}'
}, async () => {
  if (nativeRecallOwnedByHost()) {
    reportRecallDiagnostic({ event: 'UserPromptSubmit', stage: 'complete', outcome: 'delegated', contextChars: 0 });
    return formatClaudeContextHookOutput('UserPromptSubmit', '');
  }
  const { main } = await import('../adapters/claude/hooks/user-prompt-submit.js');
  const hostWorker = process.env.CLAUDE_MEMORY_RECALL_OWNER === 'host-worker';
  return main({ contextPresentation: 'reference', persistPrompt: false, deliveryClient: hostWorker ? 'codex-host' : 'codex-hook', ...(hostWorker ? { maintenance: false, allowDaemonStart: false } : {}) });
});
