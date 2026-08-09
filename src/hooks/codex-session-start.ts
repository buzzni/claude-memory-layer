#!/usr/bin/env node
/**
 * Codex and Claude Code currently share the SessionStart input/output envelope.
 * Keep a Codex-specific executable path so installation, trust, and removal do
 * not rely on identifying a generic Claude hook filename.
 */
import { main } from '../adapters/claude/hooks/session-start.js';
import { runHook } from '../adapters/claude/hooks/hook-runtime.js';

void runHook({
  name: 'codex-session-start',
  fallbackOutput: '{"hookSpecificOutput":{"hookEventName":"SessionStart"}}'
}, main);
