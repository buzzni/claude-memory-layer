#!/usr/bin/env node
/** Codex prompt-time retrieval with compact, on-demand memory references. */
import { main } from '../adapters/claude/hooks/user-prompt-submit.js';
import { runHook } from '../adapters/claude/hooks/hook-runtime.js';

void runHook({
  name: 'codex-user-prompt-submit',
  fallbackOutput: '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit"}}'
}, () => main({ contextPresentation: 'reference', persistPrompt: false }));
