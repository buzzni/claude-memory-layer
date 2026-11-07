import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkEmbeddingBackend,
  checkHooksInstalled,
  checkMcpClientConfig,
  checkNodeVersion,
  checkPathConsistency,
  checkPluginFiles,
  checkProjectStoreAccess,
  checkSessionEndHandlerLoads,
  checkSessionEndPendingJobs,
  checkSummaryProvider,
  gatherSummaryProviderFacts,
  doctorExitCode,
  findPathInstalls,
  formatDoctorReport,
  type DoctorCheckResult
} from '../../src/apps/cli/doctor.js';
import { getHooksConfig, REQUIRED_HOOK_FILES, type ClaudeSettingsWithHooks } from '../../src/apps/cli/claude-settings-hooks.js';

describe('checkNodeVersion', () => {
  it('passes on a version at or above the minimum', () => {
    expect(checkNodeVersion('v20.19.0').status).toBe('pass');
    expect(checkNodeVersion('v20.19.5').status).toBe('pass');
    expect(checkNodeVersion('v22.10.0').status).toBe('pass');
  });

  it('fails below the minimum minor within the required major', () => {
    const result = checkNodeVersion('v20.18.0');
    expect(result.status).toBe('fail');
    expect(result.fix).toBeDefined();
  });

  it('fails below the minimum major', () => {
    expect(checkNodeVersion('v18.20.0').status).toBe('fail');
  });

  it('fails on an unparseable version string', () => {
    expect(checkNodeVersion('not-a-version').status).toBe('fail');
  });

  it('enforces the engines.node range passed by the caller, not a baked-in constant', () => {
    // doctor reads engines.node from the shipped package.json so a bumped
    // floor is enforced without touching this module.
    expect(checkNodeVersion('v20.19.0', '>=22.0.0').status).toBe('fail');
    expect(checkNodeVersion('v20.18.0', '>=18.0.0').status).toBe('pass');
  });

  it('falls back to the built-in floor when the range is unreadable', () => {
    expect(checkNodeVersion('v20.19.0', 'gibberish').status).toBe('pass');
    expect(checkNodeVersion('v20.18.0', 'gibberish').status).toBe('fail');
  });
});

describe('checkPluginFiles', () => {
  it('passes when every required hook file exists', () => {
    const result = checkPluginFiles('/plugin', () => true);
    expect(result.status).toBe('pass');
  });

  it('fails and names the missing files when any are absent', () => {
    const missing = new Set([REQUIRED_HOOK_FILES[0]]);
    const result = checkPluginFiles('/plugin', (p: string) => !missing.has(p.split('/').pop() as typeof REQUIRED_HOOK_FILES[number]));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(REQUIRED_HOOK_FILES[0]);
    expect(result.fix).toContain('npm install');
  });
});

describe('checkSessionEndHandlerLoads', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function pluginWithHandler(source: string): string {
    root = mkdtempSync(join(tmpdir(), 'cml-doctor-handler-'));
    mkdirSync(join(root, 'hooks'));
    writeFileSync(join(root, 'hooks', 'session-end-handler.js'), source);
    return root;
  }

  it('passes when the session-end work the worker loads after acknowledging imports cleanly', () => {
    const result = checkSessionEndHandlerLoads(pluginWithHandler('export const handleClaudeSessionEnd = async () => {};'));
    expect(result).toMatchObject({ name: 'session-end-handler', status: 'pass' });
    // Importing does not open a database, so it cannot vouch for native bindings.
    expect(result.detail).toContain('native bindings are checked at first use');
  });

  it('fails when importing it throws, which the presence check cannot see', () => {
    const result = checkSessionEndHandlerLoads(pluginWithHandler("throw new Error('native module failed to load');"));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('native module failed to load');
    expect(result.fix).toContain('npm install');
  });

  it('leaves a missing handler to the plugin-files check', () => {
    const result = checkSessionEndHandlerLoads('/plugin', { existsImpl: () => false, importImpl: () => 'unreachable' });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('plugin-files');
  });
});

describe('checkSessionEndPendingJobs', () => {
  const pending = (failedAt: string, lastError: string) => ({
    version: 1 as const,
    job: { sessionId: 'session-1', registrationId: null },
    failedAt,
    attempts: 0,
    lastError
  });

  it('passes when no session-end work is waiting for a retry', () => {
    expect(checkSessionEndPendingJobs([])).toMatchObject({ name: 'session-end-jobs', status: 'pass' });
  });

  it('warns with the count, the oldest failure and the latest error when sessions were not ended', () => {
    const result = checkSessionEndPendingJobs([
      pending('2026-11-06T10:00:00.000Z', 'old error'),
      pending('2026-11-07T10:00:00.000Z', 'Cannot find module better-sqlite3')
    ]);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('2 session');
    expect(result.detail).toContain('2026-11-06T10:00:00.000Z');
    expect(result.detail).toContain('Cannot find module better-sqlite3');
    expect(result.fix).toContain('next session end');
  });
});

describe('checkHooksInstalled', () => {
  it('passes when all five hooks are present', () => {
    const settings: ClaudeSettingsWithHooks = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node hooks/session-start.js' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node hooks/user-prompt-submit.js' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'node hooks/post-tool-use.js' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'node hooks/stop.js' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'node hooks/session-end.js' }] }]
      }
    };
    expect(checkHooksInstalled(settings).status).toBe('pass');
  });

  it('fails and names each missing hook when settings are empty', () => {
    const result = checkHooksInstalled({});
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('SessionStart');
    expect(result.detail).toContain('SessionEnd');
    expect(result.fix).toBe('claude-memory-layer install');
  });

  it('fails when only some hooks are installed', () => {
    const result = checkHooksInstalled({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node hooks/session-start.js' }] }]
      }
    });
    expect(result.status).toBe('fail');
    expect(result.detail).not.toContain('SessionStart');
    expect(result.detail).toContain('Stop');
  });

  it('warns when registered hooks still point to a different installation', () => {
    const result = checkHooksInstalled({ hooks: getHooksConfig('/old/claude-memory-layer/dist') }, '/active/claude-memory-layer/dist', {
      existsImpl: () => true,
      realpathImpl: (target) => target
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('differ from the active CLI installation');
    expect(result.detail).toContain('UserPromptSubmit');
    expect(result.fix).toContain('claude-memory-layer install');
  });

  it('fails when registered command targets are missing even if expected files exist', () => {
    const result = checkHooksInstalled({ hooks: getHooksConfig('/old/claude-memory-layer/dist') }, '/active/claude-memory-layer/dist', {
      existsImpl: (target) => target.startsWith('/active/'),
      realpathImpl: (target) => target
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Registered hook files do not exist');
    expect(result.detail).toContain('SessionEnd');
  });

  it('passes only when all registered targets resolve to the active installation', () => {
    const result = checkHooksInstalled({ hooks: getHooksConfig('/active/claude-memory-layer/dist') }, '/active/claude-memory-layer/dist', {
      existsImpl: () => true,
      realpathImpl: (target) => target
    });
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('active CLI installation');
  });

  it('warns instead of declaring an arbitrary shell wrapper current', () => {
    const settings = { hooks: getHooksConfig('/active/claude-memory-layer/dist') };
    settings.hooks.Stop![0].hooks[0].command = 'env CUSTOM_MODE=1 node /active/claude-memory-layer/dist/hooks/stop.js';
    const result = checkHooksInstalled(settings, '/active/claude-memory-layer/dist', {
      existsImpl: () => true,
      realpathImpl: (target) => target
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('Could not verify hook targets: Stop');
  });
});

describe('checkEmbeddingBackend', () => {
  it('fails when the healthcheck script could not be loaded at all', () => {
    const result = checkEmbeddingBackend('/pkg', null);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('healthcheck script');
  });

  it('fails with a repair command when the backend reports unavailable', () => {
    const result = checkEmbeddingBackend('/pkg', () => false);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('ONNXRUNTIME_NODE_INSTALL_CUDA=skip');
  });

  it('passes when the backend is available', () => {
    const result = checkEmbeddingBackend('/pkg', () => true);
    expect(result.status).toBe('pass');
  });
});

describe('findPathInstalls', () => {
  it('finds a binary present in one PATH directory', () => {
    const installs = findPathInstalls('cml', '/a:/b', {
      existsImpl: (p) => p === '/a/cml',
      realpathImpl: (p) => p
    });
    expect(installs).toEqual([{ dir: '/a', resolvedPath: '/a/cml' }]);
  });

  it('deduplicates two PATH entries that resolve to the same real file', () => {
    // /a/cml and /b/cml are both symlinks to the same real install.
    const installs = findPathInstalls('cml', '/a:/b', {
      existsImpl: () => true,
      realpathImpl: () => '/real/cml'
    });
    expect(installs).toHaveLength(1);
  });

  it('reports two entries when they resolve to genuinely different installs', () => {
    const installs = findPathInstalls('cml', '/a:/b', {
      existsImpl: () => true,
      realpathImpl: (p) => (p.startsWith('/a') ? '/real-a/cml' : '/real-b/cml')
    });
    expect(installs).toHaveLength(2);
  });

  it('skips PATH directories that do not contain the binary', () => {
    const installs = findPathInstalls('cml', '/a:/b:/c', {
      existsImpl: (p) => p === '/c/cml',
      realpathImpl: (p) => p
    });
    expect(installs.map((i) => i.dir)).toEqual(['/c']);
  });
});

describe('checkPathConsistency', () => {
  it('passes as "not found" when the binary is not on PATH at all', () => {
    const result = checkPathConsistency('cml', '/a:/b', { existsImpl: () => false });
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('not found on PATH');
  });

  it('passes when PATH resolves to exactly one install', () => {
    const result = checkPathConsistency('cml', '/a', {
      existsImpl: () => true,
      realpathImpl: () => '/real/cml'
    });
    expect(result.status).toBe('pass');
  });

  it('warns and lists every resolved path when PATH resolves to more than one install', () => {
    // This is the dual-install / stale-nvm-version hazard this check exists for.
    const result = checkPathConsistency('cml', '/old:/new', {
      existsImpl: () => true,
      realpathImpl: (p) => (p.startsWith('/old') ? '/old-install/cml' : '/new-install/cml')
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('/old-install/cml');
    expect(result.detail).toContain('/new-install/cml');
    expect(result.fix).toBeDefined();
  });
});

describe('checkProjectStoreAccess', () => {
  it('passes when the store directory already exists and is writable', () => {
    const result = checkProjectStoreAccess('/home/user/.claude-code/memory/projects/abc12345', {
      existsImpl: (p) => p === '/home/user/.claude-code/memory/projects/abc12345',
      accessImpl: () => undefined
    });
    expect(result.status).toBe('pass');
  });

  it('never asks to create anything — only checks, and terminates instead of looping when nothing exists', () => {
    // Regression guard: this check must be read-only. Verifying writability by
    // actually mkdir -p'ing the path would silently create an empty project
    // store just from running `doctor` (the exact bug class documented for
    // mem-* tools defaulting to an empty global store).
    let accessCalls = 0;
    const result = checkProjectStoreAccess('/home/user/.claude-code/memory/projects/abc12345', {
      existsImpl: () => false, // nothing on the chain up to filesystem root exists
      accessImpl: () => { accessCalls += 1; }
    });
    expect(accessCalls).toBe(1);
    expect(result.status).toBe('pass');
  });

  it('walks up to the nearest existing ancestor when the store itself does not exist yet', () => {
    const existing = new Set(['/home/user/.claude-code/memory/projects']);
    const result = checkProjectStoreAccess('/home/user/.claude-code/memory/projects/new-hash', {
      existsImpl: (p) => existing.has(p),
      accessImpl: (p) => {
        if (p !== '/home/user/.claude-code/memory/projects') throw new Error('checked the wrong path');
      }
    });
    expect(result.status).toBe('pass');
  });

  it('fails when the nearest existing ancestor is not writable', () => {
    const result = checkProjectStoreAccess('/root-owned/projects/abc12345', {
      existsImpl: (p) => p === '/root-owned',
      accessImpl: () => { throw new Error('EACCES'); }
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('/root-owned');
  });
});

describe('formatDoctorReport and doctorExitCode', () => {
  const passing: DoctorCheckResult = { name: 'a', status: 'pass', detail: 'ok' };
  const warning: DoctorCheckResult = { name: 'bb', status: 'warn', detail: 'careful', fix: 'do X' };
  const failing: DoctorCheckResult = { name: 'c', status: 'fail', detail: 'broken', fix: 'do Y' };

  it('exits 0 when nothing failed, even with warnings', () => {
    expect(doctorExitCode([passing, warning])).toBe(0);
  });

  it('exits 1 when anything failed', () => {
    expect(doctorExitCode([passing, warning, failing])).toBe(1);
  });

  it('renders every check name, detail, and fix suggestion', () => {
    const report = formatDoctorReport([passing, warning, failing]);
    expect(report).toContain('a:');
    expect(report).toContain('ok');
    expect(report).toContain('bb:');
    expect(report).toContain('careful');
    expect(report).toContain('Fix: do X');
    expect(report).toContain('c:');
    expect(report).toContain('broken');
    expect(report).toContain('Fix: do Y');
  });

  it('summarizes failed and passed states', () => {
    expect(formatDoctorReport([failing])).toContain('1 check(s) failed');
    expect(formatDoctorReport([passing])).toContain('All checks passed');
    expect(formatDoctorReport([passing, warning])).toContain('1 warning(s)');
  });
});

describe('checkMcpClientConfig', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Two global installs side by side, each with a bin symlink, like nvm versions. */
  function fakeInstalls() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cml-doctor-mcp-')));
    tempDirs.push(root);
    const install = (prefix: string, version: string) => {
      const packageRoot = join(root, prefix, 'lib', 'node_modules', 'claude-memory-layer');
      mkdirSync(join(packageRoot, 'dist', 'mcp'), { recursive: true });
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'claude-memory-layer', version }));
      writeFileSync(join(packageRoot, 'dist', 'mcp', 'index.js'), '');
      const bin = join(root, prefix, 'bin', 'claude-memory-layer-mcp');
      mkdirSync(join(root, prefix, 'bin'), { recursive: true });
      symlinkSync(join(packageRoot, 'dist', 'mcp', 'index.js'), bin);
      return { packageRoot, bin, entry: join(packageRoot, 'dist', 'mcp', 'index.js') };
    };
    const current = install('v22', '2.4.17');
    const old = install('v20', '2.3.0');
    const node = join(root, 'v22', 'bin', 'node');
    writeFileSync(node, '');
    const expected = { command: node, args: [current.entry] };
    return { current, old, expected, node };
  }

  const read = (servers: Array<{ name: string; command: string; args?: string[]; scope?: 'user' | 'local' }>, client: 'claude-code' | 'codex' | 'claude-desktop' = 'claude-code') => ({
    client,
    configPath: `/home/me/${client}.json`,
    servers: servers.map((server) => ({ args: [], ...server }))
  });

  it('passes when the registered command resolves into the running package', () => {
    const { current, expected, node } = fakeInstalls();
    const result = checkMcpClientConfig(
      read([
        { name: 'claude-memory-layer', scope: 'user', command: current.bin },
        { name: 'code-memory', scope: 'local', command: node, args: [current.entry] }
      ]),
      current.packageRoot,
      expected
    );

    expect(result).toMatchObject({ name: 'mcp:claude-code', status: 'pass' });
    expect(result.fix).toBeUndefined();
  });

  it('warns when the command is a bare PATH name, with a command that pins this install', () => {
    const { current, expected } = fakeInstalls();
    const result = checkMcpClientConfig(
      read([{ name: 'claude-memory-layer', scope: 'user', command: 'claude-memory-layer-mcp' }]),
      current.packageRoot,
      expected
    );

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('PATH name "claude-memory-layer-mcp"');
    expect(result.fix).toBe(
      `claude mcp remove claude-memory-layer -s user && claude mcp add claude-memory-layer -s user -- '${expected.command}' '${current.entry}'`
    );
  });

  it('warns when the command resolves into a different install, naming both versions', () => {
    const { current, old, expected } = fakeInstalls();
    const result = checkMcpClientConfig(
      read([{ name: 'claude-memory-layer', command: old.bin }], 'codex'),
      current.packageRoot,
      expected
    );

    expect(result).toMatchObject({ name: 'mcp:codex', status: 'warn' });
    expect(result.detail).toContain(`another install (v2.3.0 at ${old.packageRoot})`);
    expect(result.detail).toContain('this CLI is v2.4.17');
    expect(result.fix).toBe(
      `codex mcp remove claude-memory-layer && codex mcp add claude-memory-layer -- '${expected.command}' '${current.entry}'`
    );
  });

  it('fails when the registered target does not exist', () => {
    const { current, expected } = fakeInstalls();
    const result = checkMcpClientConfig(
      read([{ name: 'claude-memory-layer', command: '/gone/bin/claude-memory-layer-mcp' }], 'claude-desktop'),
      current.packageRoot,
      expected
    );

    expect(result).toMatchObject({ name: 'mcp:claude-desktop', status: 'fail' });
    // Through the running install, not whichever claude-memory-layer PATH picks.
    expect(result.fix).toBe(`'${expected.command}' '${join(current.packageRoot, 'dist', 'cli', 'index.js')}' mcp install`);
  });

  it('warns when the script is current but node comes from PATH', () => {
    const { current, expected } = fakeInstalls();
    const result = checkMcpClientConfig(
      read([{ name: 'claude-memory-layer', command: 'node', args: [current.entry] }], 'codex'),
      current.packageRoot,
      expected
    );

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('node from PATH');
  });

  it('fails when the registered node executable does not exist', () => {
    const { current, expected } = fakeInstalls();
    const result = checkMcpClientConfig(
      read([{ name: 'claude-memory-layer', command: '/gone/bin/node', args: [current.entry] }], 'codex'),
      current.packageRoot,
      expected
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('/gone/bin/node, which does not exist');
  });

  it('passes without a fix when this server is not registered', () => {
    const { current, expected } = fakeInstalls();
    expect(checkMcpClientConfig(read([]), current.packageRoot, expected)).toMatchObject({ status: 'pass' });
  });

  it('warns when the config cannot be parsed', () => {
    const { current, expected } = fakeInstalls();
    const result = checkMcpClientConfig({ ...read([]), error: 'Unexpected token' }, current.packageRoot, expected);
    expect(result.detail).toContain('Could not read');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('Unexpected token');
  });
});

describe('checkSummaryProvider', () => {
  const base = {
    enabled: true,
    mode: undefined,
    provider: 'claude' as const,
    envProvider: 'claude' as const,
    binaryFound: true,
    auth: { state: 'logged-in' as const },
    daemons: []
  };
  const daemon = (overrides = {}) => ({
    provider: 'claude',
    model: 'claude-haiku-4-5',
    stored: 3,
    empty: 1,
    failures: 0,
    lastFailureCode: null,
    ...overrides
  });

  it('passes with the mode shown when LLM summaries are disabled', () => {
    expect(checkSummaryProvider({ ...base, enabled: false, mode: 'off' })).toEqual({
      name: 'summary-provider',
      status: 'pass',
      detail: 'disabled (CLAUDE_MEMORY_SUMMARY_MODE=off)'
    });
  });

  it('fails when the provider binary is not on PATH and names the env var to change', () => {
    const result = checkSummaryProvider({ ...base, provider: 'codex', envProvider: 'codex', binaryFound: false });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('codex');
    expect(result.fix).toContain('CLAUDE_MEMORY_SUMMARY_PROVIDER');
  });

  it('warns that summaries fail silently when the CLI is not logged in', () => {
    const result = checkSummaryProvider({ ...base, auth: { state: 'logged-out' } });
    expect(result).toMatchObject({
      status: 'warn',
      detail: 'claude CLI is not logged in; summaries will fail silently. Log in or set CLAUDE_MEMORY_SUMMARY_PROVIDER=codex'
    });
  });

  it('warns with the reason, not a failure, when the auth probe cannot decide', () => {
    const result = checkSummaryProvider({ ...base, auth: { state: 'unknown', reason: 'timed out after 10s' } });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('timed out after 10s');
  });

  it('warns when a running daemon has only failures, with counts and the last code', () => {
    const result = checkSummaryProvider({ ...base, daemons: [daemon({ stored: 0, empty: 0, failures: 7, lastFailureCode: 'auth' })] });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('failures=7');
    expect(result.detail).toContain('stored=0');
    expect(result.detail).toContain('auth');
  });

  it('does not warn on failures once the daemon has stored a summary', () => {
    expect(checkSummaryProvider({ ...base, daemons: [daemon({ failures: 2, lastFailureCode: 'timeout' })] }).status).toBe('pass');
  });

  it('warns to restart when the daemon runs a different provider than the env now says', () => {
    const result = checkSummaryProvider({ ...base, provider: 'codex', envProvider: 'codex', daemons: [daemon()] });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('daemon runs provider claude, env now says codex; restart the daemon');
  });

  it('passes with the daemon counters', () => {
    expect(checkSummaryProvider({ ...base, daemons: [daemon()] })).toEqual({
      name: 'summary-provider',
      status: 'pass',
      detail: 'provider=claude model=claude-haiku-4-5 stored=3 empty=1 failures=0'
    });
  });

  it('passes without counters for a daemon that predates summary telemetry or when none runs', () => {
    expect(checkSummaryProvider({ ...base, daemons: [] }).detail).toBe('no running daemon snapshot');
    expect(checkSummaryProvider({ ...base, daemons: [null] }).detail).toBe('no summary counters yet');
  });
});

describe('gatherSummaryProviderFacts', () => {
  const noDaemons = () => [];
  it('reads the mode and skips every probe when summaries are disabled', () => {
    const facts = gatherSummaryProviderFacts({
      env: { CLAUDE_MEMORY_SUMMARY_MODE: 'rule' },
      findBinary: () => { throw new Error('must not look up the binary'); },
      runProbe: () => { throw new Error('must not probe'); },
      readDaemons: noDaemons
    });
    expect(facts).toMatchObject({ enabled: false, mode: 'rule' });
  });

  it('parses claude auth status JSON, including the logged-out exit code', () => {
    const probe = (loggedIn: boolean) => gatherSummaryProviderFacts({
      env: {},
      findBinary: () => true,
      runProbe: () => ({ status: loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn }) }),
      readDaemons: noDaemons
    }).auth;
    expect(probe(true)).toEqual({ state: 'logged-in' });
    expect(probe(false)).toEqual({ state: 'logged-out' });
  });

  it('treats codex login status exit code as the answer and probes with the provider env', () => {
    let seen: { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
    const facts = gatherSummaryProviderFacts({
      env: { CLAUDE_MEMORY_SUMMARY_PROVIDER: 'codex', CLAUDECODE: '1' },
      findBinary: () => true,
      runProbe: (command, args, env) => { seen = { command, args, env }; return { status: 0, stdout: 'Logged in' }; },
      readDaemons: noDaemons
    });
    expect(facts.auth).toEqual({ state: 'logged-in' });
    expect(seen).toMatchObject({ command: 'codex', args: ['login', 'status'] });
    expect(seen?.env.CLAUDECODE).toBeUndefined();
  });

  it('reports unknown with the reason on probe errors, timeouts and unparseable output', () => {
    const auth = (result: { status: number | null; stdout: string; error?: string }) => gatherSummaryProviderFacts({
      env: {},
      findBinary: () => true,
      runProbe: () => result,
      readDaemons: noDaemons
    }).auth;
    expect(auth({ status: null, stdout: '', error: 'ETIMEDOUT' })).toEqual({ state: 'unknown', reason: 'ETIMEDOUT' });
    expect(auth({ status: 0, stdout: 'not json' }).state).toBe('unknown');
  });

  it('does not probe auth when the binary is missing', () => {
    const facts = gatherSummaryProviderFacts({
      env: {},
      findBinary: () => false,
      runProbe: () => { throw new Error('must not probe'); },
      readDaemons: noDaemons
    });
    expect(facts.binaryFound).toBe(false);
  });
});
