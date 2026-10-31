#!/usr/bin/env node
/**
 * Compatibility entrypoint for the Claude session-end hook.
 *
 * Implementation lives in the Claude adapter layer so core stays platform-agnostic.
 */
import { main } from '../adapters/claude/hooks/session-end.js';
import { runHook } from '../adapters/claude/hooks/hook-runtime.js';

void runHook({ name: 'session-end', fallbackOutput: '{}' }, main);
