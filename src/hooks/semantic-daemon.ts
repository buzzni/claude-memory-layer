#!/usr/bin/env node
/**
 * Compatibility entrypoint for the Claude semantic daemon hook runtime.
 *
 * Implementation lives in the Claude adapter layer so core stays platform-agnostic.
 */
import { main } from '../adapters/claude/hooks/semantic-daemon.js';

main().catch(() => {
  process.exit(1);
});
