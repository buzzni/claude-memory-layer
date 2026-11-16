#!/usr/bin/env node
/**
 * Entrypoint for the Claude PreToolUse hook (edit tools only).
 *
 * It runs before every edit, so while the pre-edit check is switched off it
 * stops here, before loading SQLite and zod. The hook itself is built as a
 * separate file, pre-tool-use-handler.js, and imported only when it is on.
 */
import { preEditCheckSwitchedOn } from '../adapters/claude/hooks/pre-edit-check-switch.js';

if (preEditCheckSwitchedOn()) {
  try {
    await import(new URL('./pre-tool-use-handler.js', import.meta.url).href);
  } catch (error) {
    // Fail open: no output and exit 0, so the edit goes ahead.
    if (process.env.CLAUDE_MEMORY_DEBUG) console.error('PreToolUse hook could not load:', error);
  }
}
