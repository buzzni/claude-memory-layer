#!/usr/bin/env node
/**
 * Compatibility entrypoint for the Claude stop hook.
 *
 * Implementation lives in the Claude adapter layer so core stays platform-agnostic.
 */
import { main } from '../adapters/claude/hooks/stop.js';
import { runHook } from '../adapters/claude/hooks/hook-runtime.js';

void runHook({ name: 'stop', fallbackOutput: '{}' }, main);
