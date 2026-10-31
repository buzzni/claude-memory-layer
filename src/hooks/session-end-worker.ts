#!/usr/bin/env node
/**
 * Detached worker the Claude session-end hook hands its work to.
 */
import { main } from '../adapters/claude/hooks/session-end-worker.js';

void main();
