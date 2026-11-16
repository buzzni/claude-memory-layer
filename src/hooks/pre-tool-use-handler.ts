#!/usr/bin/env node
/**
 * The Claude PreToolUse hook, loaded by pre-tool-use.js once the pre-edit
 * check is switched on.
 *
 * Implementation lives in the Claude adapter layer so core stays platform-agnostic.
 */
import { main, PRE_TOOL_USE_TIMEOUT_MS } from '../adapters/claude/hooks/pre-tool-use.js';
import { runHook } from '../adapters/claude/hooks/hook-runtime.js';

void runHook({ name: 'pre-tool-use', fallbackOutput: '', timeoutMs: PRE_TOOL_USE_TIMEOUT_MS }, main);
