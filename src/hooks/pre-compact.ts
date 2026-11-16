#!/usr/bin/env node
/**
 * Compatibility entrypoint for the Claude pre-compact hook.
 *
 * Implementation lives in the Claude adapter layer so core stays platform-agnostic.
 */
import { main } from '../adapters/claude/hooks/pre-compact.js';
import { runHook } from '../adapters/claude/hooks/hook-runtime.js';

void runHook({ name: 'pre-compact', fallbackOutput: '' }, main);
