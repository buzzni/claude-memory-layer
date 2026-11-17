#!/usr/bin/env node
/**
 * Entrypoint for the Claude PostToolUse hook.
 *
 * It runs after every tool call and about a third of calls are not stored
 * (excluded tools, quiet Bash output), so it decides that first, before
 * loading SQLite and zod. The storing part is built as a separate file,
 * post-tool-use-handler.js, and imported only for a call that is stored.
 */
import { reportHookLoadFailure } from '../adapters/claude/hooks/hook-load-failure.js';
import { runHook } from '../adapters/claude/hooks/hook-runtime.js';
import { readToolObservationInput } from '../adapters/claude/hooks/post-tool-use-filter.js';
import type { captureToolObservation } from '../adapters/claude/hooks/post-tool-use.js';

void runHook({ name: 'post-tool-use', fallbackOutput: '{}' }, async () => {
  const input = await readToolObservationInput();
  if (!input) return '{}';
  let handler: { captureToolObservation: typeof captureToolObservation };
  try {
    handler = await import(new URL('./post-tool-use-handler.js', import.meta.url).href);
  } catch (error) {
    reportHookLoadFailure('post-tool-use', 'post-tool-use-handler.js', 'this tool call was not stored', error);
    return '{}';
  }
  return handler.captureToolObservation(input);
});
