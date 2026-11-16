import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decideCapture, loadCapturePolicy, NO_CAPTURE_SKIPS } from '../../src/adapters/claude/hooks/capture-policy.js';
import { clearMemoryOperationsConfigCache } from '../../src/services/operations-config-loader.js';

/**
 * Hook input shapes as Claude Code 2.1.325 sent them to a project hook in a
 * `claude -p` run that called Bash itself and then through a general-purpose
 * subagent (field names and the agent fields only; values shortened).
 * PreCompact did not fire in that run; its shape follows the hooks docs.
 * A second run with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 and a teammate
 * started through the Agent tool sent its tool events with exactly the same
 * fields. `agent_id` / `agent_type` appear only on tool events fired inside
 * the subagent or teammate, and on SubagentStop, which this plugin does not
 * register.
 */
const MAIN = { session_id: 's', transcript_path: '/t.jsonl', cwd: '/repo', prompt_id: 'p' };
const SUBAGENT = { agent_id: 'abd298ea289d71725', agent_type: 'general-purpose' };
const TEAMMATE = { agent_id: 'b7c1f02e9d4a65310', agent_type: 'general-purpose' };
const HOOK_INPUTS: Array<{ hook: string; input: Record<string, unknown>; subagent: boolean }> = [
  { hook: 'SessionStart', input: { ...MAIN, hook_event_name: 'SessionStart', source: 'startup' }, subagent: false },
  { hook: 'UserPromptSubmit', input: { ...MAIN, hook_event_name: 'UserPromptSubmit', prompt: 'x' }, subagent: false },
  { hook: 'PreToolUse (main)', input: { ...MAIN, hook_event_name: 'PreToolUse', tool_name: 'Bash' }, subagent: false },
  { hook: 'PostToolUse (main)', input: { ...MAIN, hook_event_name: 'PostToolUse', tool_name: 'Bash' }, subagent: false },
  { hook: 'PreToolUse (subagent)', input: { ...MAIN, ...SUBAGENT, hook_event_name: 'PreToolUse', tool_name: 'Bash' }, subagent: true },
  { hook: 'PostToolUse (subagent)', input: { ...MAIN, ...SUBAGENT, hook_event_name: 'PostToolUse', tool_name: 'Bash' }, subagent: true },
  // A teammate named through the Agent tool sent the same fields as a subagent in the same run.
  { hook: 'PostToolUse (in-process teammate)', input: { ...MAIN, ...TEAMMATE, hook_event_name: 'PostToolUse', tool_name: 'Bash' }, subagent: true },
  { hook: 'Stop', input: { ...MAIN, hook_event_name: 'Stop', stop_hook_active: false }, subagent: false },
  { hook: 'PreCompact', input: { ...MAIN, hook_event_name: 'PreCompact', trigger: 'auto' }, subagent: false },
  { hook: 'SessionEnd', input: { ...MAIN, hook_event_name: 'SessionEnd', reason: 'other' }, subagent: false }
];

const SKIP_ALL = { skipSubagentTypes: ['*'] };

describe('decideCapture', () => {
  it('captures every hook input under the default policy', () => {
    for (const { input } of HOOK_INPUTS) {
      expect(decideCapture(input, NO_CAPTURE_SKIPS)).toEqual({ capture: true });
    }
  });

  it.each(HOOK_INPUTS)('skips $hook only when it fired inside a subagent', ({ input, subagent }) => {
    const expected = subagent ? { capture: false, reason: 'subagent_or_teammate' } : { capture: true };
    expect(decideCapture(input, SKIP_ALL)).toEqual(expected);
  });

  it('skips only the listed subagent types', () => {
    const policy = { skipSubagentTypes: ['Explore'] };
    expect(decideCapture({ agent_id: 'a1', agent_type: 'Explore' }, policy)).toEqual({ capture: false, reason: 'subagent_or_teammate' });
    expect(decideCapture({ agent_id: 'a2', agent_type: 'general-purpose' }, policy)).toEqual({ capture: true });
  });

  it('treats agent_type without agent_id as the main session (claude --agent)', () => {
    expect(decideCapture({ agent_type: 'Explore' }, { skipSubagentTypes: ['*', 'Explore'] })).toEqual({ capture: true });
  });

  it('matches agent types exactly: case-sensitive, and only a lone * is a wildcard', () => {
    const explore = { agent_id: 'a1', agent_type: 'Explore' };
    expect(decideCapture(explore, { skipSubagentTypes: ['explore'] })).toEqual({ capture: true });
    expect(decideCapture(explore, { skipSubagentTypes: ['Expl*'] })).toEqual({ capture: true });
    expect(decideCapture(explore, { skipSubagentTypes: ['**'] })).toEqual({ capture: true });
    expect(decideCapture({ agent_id: 'a2' }, { skipSubagentTypes: ['*'] })).toEqual({ capture: false, reason: 'subagent_or_teammate' });
    expect(decideCapture({ agent_id: 'a2' }, { skipSubagentTypes: ['Explore'] })).toEqual({ capture: true });
  });

  it('ignores an empty or non-string agent_id', () => {
    expect(decideCapture({ agent_id: '', agent_type: 'Explore' }, SKIP_ALL)).toEqual({ capture: true });
    expect(decideCapture({ agent_id: 42 }, SKIP_ALL)).toEqual({ capture: true });
  });
});

describe('loadCapturePolicy', () => {
  let dir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    clearMemoryOperationsConfigCache();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function useConfig(body: string): void {
    dir = mkdtempSync(join(tmpdir(), 'cml-capture-policy-'));
    const configPath = join(dir, 'operations.json');
    writeFileSync(configPath, body);
    vi.stubEnv('CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH', configPath);
    clearMemoryOperationsConfigCache();
  }

  it('skips nothing when operations.json is absent', () => {
    vi.stubEnv('CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH', join(tmpdir(), 'cml-capture-policy-missing', 'operations.json'));
    clearMemoryOperationsConfigCache();
    expect(loadCapturePolicy()).toEqual(NO_CAPTURE_SKIPS);
  });

  it('skips nothing when operations.json is invalid', () => {
    useConfig('{"capturePolicy": {"skipSubagentTypes": "Explore"}}');
    expect(loadCapturePolicy()).toEqual(NO_CAPTURE_SKIPS);
  });

  it('trims configured types, so surrounding spaces still match', () => {
    useConfig('{"capturePolicy": {"skipSubagentTypes": [" Explore "]}}');
    const policy = loadCapturePolicy();
    expect(policy).toEqual({ skipSubagentTypes: ['Explore'] });
    expect(decideCapture({ agent_id: 'a1', agent_type: 'Explore' }, policy)).toEqual({ capture: false, reason: 'subagent_or_teammate' });
  });

  it('rejects a blank type as a schema error, which leaves the defaults in place', () => {
    useConfig('{"capturePolicy": {"skipSubagentTypes": ["  "]}}');
    expect(loadCapturePolicy()).toEqual(NO_CAPTURE_SKIPS);
  });

  it('reads the configured subagent types without the top-level switch', () => {
    useConfig('{"capturePolicy": {"skipSubagentTypes": ["Explore"]}}');
    expect(loadCapturePolicy()).toEqual({ skipSubagentTypes: ['Explore'] });
  });
});
