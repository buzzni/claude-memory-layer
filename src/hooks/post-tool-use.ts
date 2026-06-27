#!/usr/bin/env node
/**
 * Compatibility entrypoint for the Claude post-tool-use hook.
 *
 * Implementation lives in the Claude adapter layer so core stays platform-agnostic.
 */
import { main } from '../adapters/claude/hooks/post-tool-use.js';
import { runHook } from '../adapters/claude/hooks/hook-runtime.js';

void runHook({ name: 'post-tool-use', fallbackOutput: '{}' }, main);
