#!/usr/bin/env node
/**
 * Compatibility entrypoint for the Claude stop hook.
 *
 * Implementation lives in the Claude adapter layer so core stays platform-agnostic.
 */
import { main } from '../adapters/claude/hooks/stop.js';

main().catch(console.error);
