#!/usr/bin/env node
/**
 * Compatibility entrypoint for the Claude user-prompt-submit hook.
 *
 * Implementation lives in the Claude adapter layer so core stays platform-agnostic.
 */
import { main } from '../adapters/claude/hooks/user-prompt-submit.js';

main().catch(console.error);
