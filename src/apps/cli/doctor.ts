/**
 * `claude-memory-layer doctor` — aggregate environment diagnostics.
 *
 * Every check here maps to an incident this project has actually hit:
 * embedding backend postinstall silently landing in the wrong npm layout,
 * an old nvm-managed Node version shadowing the current one on PATH so MCP
 * spawns the wrong binary, and empty project stores appearing because a
 * store-path check ran before the store existed. `status` reports plugin
 * installation state; `doctor` reports whether the runtime environment
 * around it is sound. Each check is a pure function over injected
 * dependencies so it can be unit tested without touching the real
 * filesystem, PATH, or Node process.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import {
  hasHook,
  inspectPluginHookTargets,
  PLUGIN_HOOKS,
  REQUIRED_HOOK_FILES,
  shellQuotePathForNode,
  type ClaudeSettingsWithHooks,
  type PluginHookName
} from './claude-settings-hooks.js';
import type { McpClientConfigRead, RegisteredMcpServer } from './mcp-client-config.js';
import type { PendingSessionEndJob } from '../../adapters/claude/hooks/session-end-pending.js';
import { buildCliProviderEnv, type CliProviderName } from '../../adapters/llm/cli-provider.js';
import { getSummaryProviderName, isLlmSummaryEnabled } from '../../adapters/llm/session-summary-llm.js';
import { defaultRuntimeTelemetryDir, readRuntimeResourceSnapshots } from '../../core/runtime-resource-telemetry.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheckResult {
  name: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

/**
 * Fallback only — the caller passes the live `engines.node` range read from
 * the shipped package.json, so a bumped engine floor is enforced without
 * anyone remembering to update a constant here.
 */
const FALLBACK_NODE_RANGE = '>=20.19.0';

function parseNodeVersion(version: string): { major: number; minor: number } | null {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function parseMinimumFromRange(range: string): { major: number; minor: number } | null {
  const match = />=\s*v?(\d+)\.(\d+)/.exec(range);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function checkNodeVersion(
  nodeVersion: string = process.version,
  requiredRange: string = FALLBACK_NODE_RANGE
): DoctorCheckResult {
  const minimum = parseMinimumFromRange(requiredRange) ?? parseMinimumFromRange(FALLBACK_NODE_RANGE)!;
  const parsed = parseNodeVersion(nodeVersion);
  const required = `${minimum.major}.${minimum.minor}.0`;
  if (!parsed) {
    return {
      name: 'node',
      status: 'fail',
      detail: `Could not parse Node version from "${nodeVersion}"`,
      fix: `Install Node ${required} or newer.`
    };
  }
  const meetsMinimum = parsed.major > minimum.major
    || (parsed.major === minimum.major && parsed.minor >= minimum.minor);
  if (!meetsMinimum) {
    return {
      name: 'node',
      status: 'fail',
      detail: `${nodeVersion} is below the required ${required}`,
      fix: `Upgrade Node: nvm install ${minimum.major} && nvm use ${minimum.major}`
    };
  }
  return { name: 'node', status: 'pass', detail: nodeVersion };
}

export function checkPluginFiles(
  pluginPath: string,
  existsImpl: (p: string) => boolean = fs.existsSync
): DoctorCheckResult {
  const missing = REQUIRED_HOOK_FILES.filter((file) => !existsImpl(path.join(pluginPath, 'hooks', file)));
  if (missing.length > 0) {
    return {
      name: 'plugin-files',
      status: 'fail',
      detail: `Missing hook file(s) under ${pluginPath}/hooks: ${missing.join(', ')}`,
      fix: 'Reinstall: npm install -g claude-memory-layer@latest'
    };
  }
  return { name: 'plugin-files', status: 'pass', detail: pluginPath };
}

/** Imports `file` in a separate Node process; the error message when it throws, else null. */
function importInChildProcess(file: string): string | null {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    'try { await import(process.argv[1]); } catch (error) { console.error(error?.message ?? String(error)); process.exit(1); }',
    pathToFileURL(file).href
  ], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error) return result.error.message;
  if (result.status === 0) return null;
  return result.stderr.trim().split('\n')[0] || `exited with status ${result.status}`;
}

/**
 * The session-end worker acknowledges its job once session-end-handler.js
 * exists and imports it afterwards, so a handler that exists but fails to
 * import loses the session's end processing (it is kept for a retry, see
 * checkSessionEndPendingJobs). Only this file is imported: it is a library,
 * while the other hook files run their hook (and read stdin) when imported.
 * It runs in a child process so another install's modules never load here.
 * A pass is only that: better-sqlite3 loads its binding when a database is
 * opened, and the check uses this Node and pluginPath, not the node and
 * target the registered SessionEnd hook runs (the hooks check flags a
 * different target).
 */
export function checkSessionEndHandlerLoads(
  pluginPath: string,
  deps: {
    existsImpl?: (p: string) => boolean;
    importImpl?: (file: string) => string | null;
  } = {}
): DoctorCheckResult {
  const handler = path.join(pluginPath, 'hooks', 'session-end-handler.js');
  if (!(deps.existsImpl ?? fs.existsSync)(handler)) {
    return { name: 'session-end-handler', status: 'warn', detail: `${handler} not found; see plugin-files` };
  }
  const error = (deps.importImpl ?? importInChildProcess)(handler);
  if (error) {
    return {
      name: 'session-end-handler',
      status: 'fail',
      detail: `${handler} fails to load, so sessions are not ended: ${error}`,
      fix: 'Reinstall: npm install -g claude-memory-layer@latest'
    };
  }
  return {
    name: 'session-end-handler',
    status: 'pass',
    detail: 'module imports; native bindings are checked at first use'
  };
}

export function checkSessionEndPendingJobs(pending: PendingSessionEndJob[]): DoctorCheckResult {
  if (pending.length === 0) {
    return { name: 'session-end-jobs', status: 'pass', detail: 'no session-end work waiting for a retry' };
  }
  const byFailure = [...pending].sort((a, b) => a.failedAt.localeCompare(b.failedAt));
  return {
    name: 'session-end-jobs',
    status: 'warn',
    detail: `${pending.length} session(s) not ended because the session-end work failed to load `
      + `(oldest ${byFailure[0].failedAt}); last error: ${byFailure[byFailure.length - 1].lastError}`,
    fix: 'Fix the install (see session-end-handler); kept jobs are retried at the next session end. '
      + 'History: ~/.claude-code/memory/session-end-diagnostics.jsonl'
  };
}

export function checkHooksInstalled(
  settings: ClaudeSettingsWithHooks,
  pluginPath?: string,
  deps: Parameters<typeof inspectPluginHookTargets>[2] = {}
): DoctorCheckResult {
  if (pluginPath) {
    const targets = inspectPluginHookTargets(settings, pluginPath, deps);
    const names = (status: typeof targets[number]['status']): string => Array.from(new Set(
      targets.filter((target) => target.status === status).map((target) => target.hookName)
    )).join(', ');
    const missing = names('missing');
    const missingTargets = names('missing-target');
    const differentTargets = names('different-target');
    const unverifiable = names('unverifiable');
    const details = [
      missing && `Not installed in Claude settings: ${missing}`,
      missingTargets && `Registered hook files do not exist: ${missingTargets}`,
      differentTargets && `Hook targets differ from the active CLI installation: ${differentTargets}`,
      unverifiable && `Could not verify hook targets: ${unverifiable}`
    ].filter(Boolean);
    if (details.length > 0) {
      return {
        name: 'hooks',
        status: missing || missingTargets ? 'fail' : 'warn',
        detail: details.join('. '),
        fix: 'claude-memory-layer install (or verify an intentional custom plugin path)'
      };
    }
    return { name: 'hooks', status: 'pass', detail: 'all hooks target the active CLI installation' };
  }
  // Derived from PLUGIN_HOOKS — the map `install` writes from — so a hook
  // added there is automatically checked here instead of doctor reporting
  // "all hooks installed" while the new one is missing. The file name is a
  // valid hasHook fragment (commands embed it).
  const missing = (Object.entries(PLUGIN_HOOKS) as Array<[PluginHookName, string]>)
    .filter(([hookName, fileName]) => !hasHook(settings, hookName, fileName))
    .map(([hookName]) => hookName);

  if (missing.length > 0) {
    return {
      name: 'hooks',
      status: 'fail',
      detail: `Not installed in Claude settings: ${missing.join(', ')}`,
      fix: 'claude-memory-layer install'
    };
  }
  return { name: 'hooks', status: 'pass', detail: 'all hooks installed' };
}

export type SummaryAuthProbe =
  | { state: 'logged-in' }
  | { state: 'logged-out' }
  | { state: 'unknown'; reason: string };

export interface SummaryDaemonFacts {
  provider: string | null;
  model: string | null;
  stored: number;
  empty: number;
  failures: number;
  lastFailureCode: string | null;
}

export interface SummaryProviderFacts {
  enabled: boolean;
  /** Raw CLAUDE_MEMORY_SUMMARY_MODE, shown when summaries are disabled. */
  mode: string | undefined;
  provider: CliProviderName;
  /** Provider resolved from the environment doctor runs in (what a restarted daemon would use). */
  envProvider: CliProviderName;
  binaryFound: boolean;
  auth: SummaryAuthProbe;
  /** One entry per running semantic daemon; null when its snapshot has no summary counters. */
  daemons: Array<SummaryDaemonFacts | null>;
}

/**
 * LLM summaries run in a detached daemon and swallow provider errors, so a
 * logged-out CLI would otherwise stop all summaries without any visible sign.
 */
export function checkSummaryProvider(facts: SummaryProviderFacts): DoctorCheckResult {
  const name = 'summary-provider';
  if (!facts.enabled) {
    return { name, status: 'pass', detail: `disabled (CLAUDE_MEMORY_SUMMARY_MODE=${facts.mode})` };
  }
  const alternative: CliProviderName = facts.provider === 'claude' ? 'codex' : 'claude';
  if (!facts.binaryFound) {
    return {
      name,
      status: 'fail',
      detail: `${facts.provider} CLI was not found on PATH; session summaries cannot be generated`,
      fix: `Install the ${facts.provider} CLI or set CLAUDE_MEMORY_SUMMARY_PROVIDER=${alternative}`
    };
  }

  const warnings: string[] = [];
  if (facts.auth.state === 'logged-out') {
    warnings.push(
      `${facts.provider} CLI is not logged in; summaries will fail silently. Log in or set CLAUDE_MEMORY_SUMMARY_PROVIDER=${alternative}`
    );
  } else if (facts.auth.state === 'unknown') {
    warnings.push(`could not check ${facts.provider} CLI login: ${facts.auth.reason}`);
  }
  for (const daemon of facts.daemons) {
    if (!daemon) continue;
    if (daemon.failures > 0 && daemon.stored === 0) {
      warnings.push(
        `daemon summary attempts all failed (stored=${daemon.stored} empty=${daemon.empty} failures=${daemon.failures}, last error: ${daemon.lastFailureCode ?? 'unknown'})`
      );
    }
    if (daemon.provider && daemon.provider !== facts.envProvider) {
      warnings.push(`daemon runs provider ${daemon.provider}, env now says ${facts.envProvider}; restart the daemon`);
    }
  }
  if (warnings.length > 0) return { name, status: 'warn', detail: warnings.join(' | ') };

  const reporting = facts.daemons.find((daemon): daemon is SummaryDaemonFacts => daemon !== null);
  if (reporting) {
    return {
      name,
      status: 'pass',
      detail: `provider=${reporting.provider} model=${reporting.model} stored=${reporting.stored} empty=${reporting.empty} failures=${reporting.failures}`
    };
  }
  return {
    name,
    status: 'pass',
    detail: facts.daemons.length === 0 ? 'no running daemon snapshot' : 'no summary counters yet'
  };
}

const SUMMARY_AUTH_PROBE_TIMEOUT_MS = 10_000;

interface SummaryProbeResult {
  status: number | null;
  stdout: string;
  error?: string;
}

export interface SummaryProviderFactsDeps {
  env?: NodeJS.ProcessEnv;
  findBinary?: (command: string, envPath: string) => boolean;
  runProbe?: (command: string, args: string[], env: NodeJS.ProcessEnv) => SummaryProbeResult;
  readDaemons?: () => Array<SummaryDaemonFacts | null>;
}

function binaryOnPath(command: string, envPath: string): boolean {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        fs.accessSync(path.join(dir, `${command}${extension}`), fs.constants.X_OK);
        return true;
      } catch {
        // Not in this directory.
      }
    }
  }
  return false;
}

function runSummaryAuthProbe(command: string, args: string[], env: NodeJS.ProcessEnv): SummaryProbeResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    timeout: SUMMARY_AUTH_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  return { status: result.status, stdout: result.stdout ?? '', error: result.error?.message };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readRunningSummaryDaemons(): Array<SummaryDaemonFacts | null> {
  return readRuntimeResourceSnapshots(defaultRuntimeTelemetryDir())
    .filter((snapshot) =>
      snapshot.client === 'semantic-daemon' && snapshot.processState === 'running' && processIsAlive(snapshot.pid))
    .map((snapshot) => snapshot.summary
      ? {
          provider: snapshot.summary.provider,
          model: snapshot.summary.model,
          stored: snapshot.summary.stored,
          empty: snapshot.summary.empty,
          failures: snapshot.summary.failures,
          lastFailureCode: snapshot.summary.lastFailure?.code ?? null
        }
      : null);
}

function probeSummaryAuth(
  provider: CliProviderName,
  env: NodeJS.ProcessEnv,
  runProbe: NonNullable<SummaryProviderFactsDeps['runProbe']>
): SummaryAuthProbe {
  // No model call: both subcommands only read the local credential state.
  const args = provider === 'claude' ? ['auth', 'status'] : ['login', 'status'];
  const result = runProbe(provider, args, buildCliProviderEnv(env));
  if (result.error) return { state: 'unknown', reason: result.error };
  if (provider === 'codex') {
    return result.status === 0 ? { state: 'logged-in' } : { state: 'logged-out' };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
    if (typeof parsed.loggedIn === 'boolean') {
      return parsed.loggedIn ? { state: 'logged-in' } : { state: 'logged-out' };
    }
  } catch {
    // Fall through to the unknown result below.
  }
  return { state: 'unknown', reason: 'claude auth status did not return JSON with loggedIn' };
}

export function gatherSummaryProviderFacts(deps: SummaryProviderFactsDeps = {}): SummaryProviderFacts {
  const env = deps.env ?? process.env;
  const provider = getSummaryProviderName(env);
  const enabled = isLlmSummaryEnabled(env);
  const facts: SummaryProviderFacts = {
    enabled,
    mode: env.CLAUDE_MEMORY_SUMMARY_MODE,
    provider,
    envProvider: provider,
    binaryFound: false,
    auth: { state: 'unknown', reason: 'not checked' },
    daemons: []
  };
  if (!enabled) return facts;

  facts.binaryFound = (deps.findBinary ?? binaryOnPath)(provider, env.PATH ?? '');
  if (facts.binaryFound) {
    facts.auth = probeSummaryAuth(provider, env, deps.runProbe ?? runSummaryAuthProbe);
  }
  facts.daemons = (deps.readDaemons ?? readRunningSummaryDaemons)();
  return facts;
}

/**
 * The exports doctor uses from scripts/postinstall-embedding-backend.cjs.
 * Only the healthcheck is required; `doctor --fix` declines when the rest
 * are missing rather than guessing at an older script's behaviour.
 */
export interface EmbeddingBackendScript {
  isEmbeddingBackendAvailable: (rootDir: string) => boolean;
  runPostinstall?: (options: { rootDir?: string; env?: NodeJS.ProcessEnv }) => { attempted: boolean; success?: boolean };
  getManagedBackendDir?: (rootDir: string) => string;
  isSkipRequested?: (env: NodeJS.ProcessEnv) => boolean;
  createRepairEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  createNpmInvocation?: (options: {
    args: string[];
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    existsSyncImpl?: (filePath: string) => boolean;
  }) => { command: string; args: string[]; shell?: true };
}

export function checkEmbeddingBackend(
  packageRoot: string,
  isAvailableImpl: ((rootDir: string) => boolean) | null
): DoctorCheckResult {
  if (!isAvailableImpl) {
    return {
      name: 'embedding-backend',
      status: 'fail',
      detail: 'Could not load the embedding backend healthcheck script',
      fix: 'Reinstall: npm install -g claude-memory-layer@latest'
    };
  }
  const available = isAvailableImpl(packageRoot);
  if (!available) {
    return {
      name: 'embedding-backend',
      status: 'fail',
      detail: 'Required embedding backend is not installed — semantic/vector search will not work',
      fix: 'ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g claude-memory-layer@latest'
    };
  }
  return { name: 'embedding-backend', status: 'pass', detail: 'installed' };
}

interface PathBinaryProbe {
  dir: string;
  resolvedPath: string;
}

/**
 * Finds every distinct install a binary name resolves to across PATH. A
 * shadowed old install (e.g. an nvm-managed Node version ahead of the active
 * one) makes `which -a` return more than one, and processes launched by
 * different tools (a shell vs. an MCP client) can end up running different
 * binaries silently.
 */
export function findPathInstalls(
  binaryName: string,
  pathEnv: string,
  deps: {
    existsImpl?: (p: string) => boolean;
    realpathImpl?: (p: string) => string;
    pathSeparator?: string;
  } = {}
): PathBinaryProbe[] {
  const existsImpl = deps.existsImpl ?? fs.existsSync;
  const realpathImpl = deps.realpathImpl ?? fs.realpathSync;
  const pathSeparator = deps.pathSeparator ?? path.delimiter;

  const results: PathBinaryProbe[] = [];
  const seenRealpaths = new Set<string>();

  for (const dir of pathEnv.split(pathSeparator).filter((entry) => entry.length > 0)) {
    const candidate = path.join(dir, binaryName);
    if (!existsImpl(candidate)) continue;
    let resolvedPath: string;
    try {
      resolvedPath = realpathImpl(candidate);
    } catch {
      resolvedPath = candidate;
    }
    if (seenRealpaths.has(resolvedPath)) continue;
    seenRealpaths.add(resolvedPath);
    results.push({ dir, resolvedPath });
  }

  return results;
}

export function checkPathConsistency(
  binaryName: string,
  pathEnv: string,
  deps: Parameters<typeof findPathInstalls>[2] = {}
): DoctorCheckResult {
  const installs = findPathInstalls(binaryName, pathEnv, deps);

  if (installs.length === 0) {
    return {
      name: `path:${binaryName}`,
      status: 'pass',
      detail: `${binaryName} not found on PATH (not run as an installed binary)`
    };
  }
  if (installs.length === 1) {
    return { name: `path:${binaryName}`, status: 'pass', detail: installs[0].resolvedPath };
  }
  return {
    name: `path:${binaryName}`,
    status: 'warn',
    detail: `PATH resolves ${binaryName} to ${installs.length} different installs: `
      + installs.map((install) => install.resolvedPath).join(', '),
    fix: `Remove the stale install, or reorder PATH so the intended one (usually the first entry above) wins. `
      + `An MCP client and your shell can pick different ones silently.`
  };
}

type McpTargetStatus =
  | { kind: 'current' }
  | { kind: 'not-absolute'; target: string }
  | { kind: 'missing-target'; target: string }
  | { kind: 'other-install'; resolvedPath: string; packageRoot?: string; version?: string }
  | { kind: 'node-from-path' }
  | { kind: 'unverifiable' };

/** Nearest ancestor package.json naming this package, e.g. another global install. */
export function findClaudeMemoryPackage(
  filePath: string,
  readFileImpl: (p: string) => string
): { packageRoot: string; version?: string } | undefined {
  let dir = path.dirname(filePath);
  while (true) {
    try {
      const manifest = JSON.parse(readFileImpl(path.join(dir, 'package.json'))) as { name?: string; version?: string };
      if (manifest.name === 'claude-memory-layer') return { packageRoot: dir, version: manifest.version };
    } catch {
      // no manifest here; keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function inspectMcpTarget(
  server: RegisteredMcpServer,
  packageRoot: string,
  deps: Required<McpClientCheckDeps>
): McpTargetStatus {
  // `node <script>` runs the script; anything else is the binary itself.
  const runsNode = /^node(?:\.exe)?$/i.test(path.basename(server.command));
  const target = runsNode ? server.args.find((arg) => !arg.startsWith('-')) : server.command;
  if (!target) return { kind: 'unverifiable' };
  if (!path.isAbsolute(target)) return { kind: 'not-absolute', target };
  if (!deps.existsImpl(target)) return { kind: 'missing-target', target };

  const canonicalPath = (filePath: string): string => {
    try {
      return deps.realpathImpl(filePath);
    } catch {
      return path.resolve(filePath);
    }
  };
  const resolvedPath = canonicalPath(target);
  const root = canonicalPath(packageRoot);
  if (!resolvedPath.startsWith(root + path.sep)) {
    return { kind: 'other-install', resolvedPath, ...findClaudeMemoryPackage(resolvedPath, deps.readFileImpl) };
  }
  if (runsNode) {
    // A Node other than the one this package was installed with can fail to
    // load its native modules (better-sqlite3), so the runtime is pinned too.
    if (!path.isAbsolute(server.command)) return { kind: 'node-from-path' };
    if (!deps.existsImpl(server.command)) return { kind: 'missing-target', target: server.command };
  }
  return { kind: 'current' };
}

function quoteShellWord(word: string): string {
  return /^[\w.@%+=:,/-]+$/.test(word) ? word : shellQuotePathForNode(word);
}

function mcpClientFix(
  read: McpClientConfigRead,
  server: RegisteredMcpServer,
  expected: { command: string; args: string[] }
): string {
  const name = quoteShellWord(server.name);
  const invocation = [expected.command, ...expected.args].map(shellQuotePathForNode).join(' ');
  if (read.client === 'claude-desktop') {
    // Run this install's CLI (<dist>/cli/index.js next to <dist>/mcp/index.js)
    // rather than whichever `claude-memory-layer` comes first on PATH.
    const cliPath = path.join(path.dirname(path.dirname(expected.args[0])), 'cli', 'index.js');
    const install = `${shellQuotePathForNode(expected.command)} ${shellQuotePathForNode(cliPath)} mcp install`;
    return server.name === 'claude-memory-layer' ? install : `${install} --server-name ${name}`;
  }
  if (read.client === 'codex') {
    return `codex mcp remove ${name} && codex mcp add ${name} -- ${invocation}`;
  }
  const scope = server.scope ?? 'user';
  return `claude mcp remove ${name} -s ${scope} && claude mcp add ${name} -s ${scope} -- ${invocation}`;
}

interface McpClientCheckDeps {
  existsImpl?: (p: string) => boolean;
  realpathImpl?: (p: string) => string;
  readFileImpl?: (p: string) => string;
}

/**
 * `checkPathConsistency` only sees PATH; an MCP client launches whatever its
 * own config names. Resolves each registered command of this server to a
 * real file and compares it against the running CLI's package root, so a
 * config still pinned to an old nvm install (or relying on PATH order) is
 * flagged even when the shell's PATH looks clean. Reads only.
 */
export function checkMcpClientConfig(
  read: McpClientConfigRead,
  packageRoot: string,
  expected: { command: string; args: string[] } | null,
  deps: McpClientCheckDeps = {}
): DoctorCheckResult {
  const resolvedDeps: Required<McpClientCheckDeps> = {
    existsImpl: deps.existsImpl ?? fs.existsSync,
    realpathImpl: deps.realpathImpl ?? fs.realpathSync,
    readFileImpl: deps.readFileImpl ?? ((p) => fs.readFileSync(p, 'utf8'))
  };
  const name = `mcp:${read.client}`;

  if (read.error) {
    return {
      name,
      status: 'warn',
      detail: `Could not read ${read.configPath}: ${read.error}`,
      fix: `Check the syntax of ${read.configPath}.`
    };
  }
  if (read.servers.length === 0) {
    return { name, status: 'pass', detail: `not registered in ${read.configPath}` };
  }

  const currentVersion = findClaudeMemoryPackage(path.join(packageRoot, 'package.json'), resolvedDeps.readFileImpl)?.version;
  const problems: string[] = [];
  const fixes: string[] = [];
  let missing = false;
  for (const server of read.servers) {
    const label = server.scope ? `${server.name} (${server.scope})` : server.name;
    const status = inspectMcpTarget(server, packageRoot, resolvedDeps);
    if (status.kind === 'current') continue;
    if (status.kind === 'not-absolute') {
      problems.push(`${label} uses PATH name "${status.target}", which can resolve to a different install than this CLI`);
    } else if (status.kind === 'node-from-path') {
      problems.push(`${label} runs this install with node from PATH ("${server.command}"), which may not be the Node it was installed with`);
    } else if (status.kind === 'missing-target') {
      missing = true;
      problems.push(`${label} points to ${status.target}, which does not exist`);
    } else if (status.kind === 'other-install') {
      const where = status.packageRoot
        ? `another install (v${status.version ?? '?'} at ${status.packageRoot})`
        : `${status.resolvedPath}, outside this CLI's package`;
      problems.push(`${label} runs ${where}; this CLI is v${currentVersion ?? '?'} at ${packageRoot}`);
    } else {
      problems.push(`${label} runs "${[server.command, ...server.args].join(' ')}", which could not be verified`);
    }
    if (expected) fixes.push(mcpClientFix(read, server, expected));
  }

  if (problems.length === 0) {
    return { name, status: 'pass', detail: `${read.servers.map((server) => server.name).join(', ')} → ${packageRoot}` };
  }
  return {
    name,
    status: missing ? 'fail' : 'warn',
    detail: `${read.configPath}: ${problems.join('; ')}`,
    fix: fixes.length > 0
      ? fixes.join('; ')
      : 'Reinstall: npm install -g claude-memory-layer@latest, then re-register the MCP server'
  };
}

/** `target` itself when it exists, otherwise its nearest existing ancestor. */
export function findNearestExistingPath(
  target: string,
  existsImpl: (p: string) => boolean = fs.existsSync
): string {
  let cursor = target;
  let parent = path.dirname(cursor);
  while (!existsImpl(cursor) && parent !== cursor) {
    cursor = parent;
    parent = path.dirname(cursor);
  }
  return cursor;
}

/**
 * Non-mutating: never creates the project store as a side effect of checking
 * it. Walks up to the nearest existing ancestor and checks that directory is
 * writable, which is what "a store could be created here" actually requires.
 */
export function checkProjectStoreAccess(
  storePath: string,
  deps: {
    existsImpl?: (p: string) => boolean;
    accessImpl?: (p: string, mode: number) => void;
  } = {}
): DoctorCheckResult {
  const accessImpl = deps.accessImpl ?? fs.accessSync;
  const cursor = findNearestExistingPath(storePath, deps.existsImpl);

  try {
    accessImpl(cursor, fs.constants.W_OK);
  } catch {
    return {
      name: 'project-store',
      status: 'fail',
      detail: `${cursor} is not writable`,
      fix: `Check ownership and permissions of ${cursor}.`
    };
  }
  return { name: 'project-store', status: 'pass', detail: storePath };
}

export function formatDoctorReport(checks: DoctorCheckResult[]): string {
  const icon: Record<DoctorStatus, string> = { pass: '✅', warn: '⚠️ ', fail: '❌' };
  const nameWidth = Math.max(...checks.map((check) => check.name.length));
  const lines = ['', 'Claude Memory Layer Doctor', ''];

  for (const check of checks) {
    const pad = ' '.repeat(nameWidth - check.name.length + 1);
    lines.push(`  ${check.name}:${pad}${icon[check.status]}  ${check.detail}`);
    if (check.fix) {
      lines.push(`  ${' '.repeat(nameWidth + 2)}Fix: ${check.fix}`);
    }
  }

  const failed = checks.filter((check) => check.status === 'fail').length;
  const warned = checks.filter((check) => check.status === 'warn').length;
  lines.push('');
  if (failed > 0) {
    lines.push(`  ${failed} check(s) failed. See above for fix suggestions.`);
  } else if (warned > 0) {
    lines.push(`  ${warned} warning(s). Review the suggestions above.`);
  } else {
    lines.push('  All checks passed.');
  }
  lines.push('');

  return lines.join('\n');
}

export function doctorExitCode(checks: DoctorCheckResult[]): number {
  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}
