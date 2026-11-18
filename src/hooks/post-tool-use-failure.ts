#!/usr/bin/env node
/**
 * Entrypoint for the Claude PostToolUseFailure hook: a tool call that started
 * and then failed, which Claude Code reports here and never to PostToolUse.
 *
 * Built like post-tool-use.ts: it decides whether to store the call before
 * loading SQLite and zod, then imports the same post-tool-use-handler.js.
 */
import { reportHookLoadFailure } from '../adapters/claude/hooks/hook-load-failure.js';
import { runHook } from '../adapters/claude/hooks/hook-runtime.js';
import { readToolFailureInput } from '../adapters/claude/hooks/post-tool-use-filter.js';
import type { captureToolFailure } from '../adapters/claude/hooks/post-tool-use.js';

void runHook({ name: 'post-tool-use-failure', fallbackOutput: '{}' }, async () => {
  const input = await readToolFailureInput();
  if (!input) return '{}';
  let handler: { captureToolFailure: typeof captureToolFailure };
  try {
    handler = await import(new URL('./post-tool-use-handler.js', import.meta.url).href);
  } catch (error) {
    reportHookLoadFailure('post-tool-use-failure', 'post-tool-use-handler.js', 'this failed tool call was not stored', error);
    return '{}';
  }
  return handler.captureToolFailure(input);
});
