#!/usr/bin/env node
import { main } from '../adapters/codex/hooks/session-end.js';
import { runHook } from '../adapters/claude/hooks/hook-runtime.js';

void runHook({ name: 'codex-session-end', fallbackOutput: '{}', timeoutMs: 2_500 }, main);
