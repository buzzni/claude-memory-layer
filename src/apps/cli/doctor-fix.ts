/**
 * `claude-memory-layer doctor --fix` — repair the managed embedding backend.
 *
 * When the postinstall download fails, the backend stays broken until the
 * user finds the repair command on their own. `--fix` reruns the postinstall
 * script's own `runPostinstall`, which is idempotent, but only when that
 * cannot hurt anything else. In every other case it declines, says why, and
 * prints the command to run by hand. Like MemPalace's
 * `maybe_autoheal_fts5_index`, it does not repair when the situation is
 * unclear. The embedding backend is the only thing it ever repairs; every
 * other check stays report-only.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { WorkerLock } from '../../core/worker-lock.js';
import { shellQuotePathForNode } from './claude-settings-hooks.js';
import {
  checkEmbeddingBackend,
  doctorExitCode,
  findNearestExistingPath,
  formatDoctorReport,
  type DoctorCheckResult,
  type EmbeddingBackendScript
} from './doctor.js';

export type EmbeddingBackendRepairOutcome =
  | { kind: 'not-needed' }
  | { kind: 'declined'; reasons: string[]; manualCommand: string }
  | { kind: 'repaired' }
  | { kind: 'failed'; manualCommand: string };

export interface EmbeddingBackendRepair {
  outcome: EmbeddingBackendRepairOutcome;
  /** The embedding-backend check to report: re-run after a repair, else the original. */
  check: DoctorCheckResult;
}

interface NpmQueryOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  encoding: 'utf8';
  stdio: ['ignore', 'pipe', 'ignore'];
}

export interface EmbeddingBackendRepairContext {
  /** Package root whose backend the doctor check inspected. */
  packageRoot: string;
  /** Package root of the CLI that is running, i.e. the backend it would load. */
  runningPackageRoot: string | undefined;
  script: EmbeddingBackendScript | null;
  /** `~/.claude-code/memory`, scanned for worker locks held by live processes. */
  memoryRoot: string;
  semanticSocketPath: string;
  env?: NodeJS.ProcessEnv;
  deps?: {
    accessImpl?: (p: string, mode: number) => void;
    realpathImpl?: (p: string) => string;
    execFileSyncImpl?: (command: string, args: string[], options: NpmQueryOptions) => string;
    isProcessRunning?: (pid: number) => boolean;
    probeSocketImpl?: (socketPath: string) => Promise<boolean>;
  };
}

function manualRepairCommand(packageRoot: string): string {
  return `cd ${shellQuotePathForNode(packageRoot)} && ONNXRUNTIME_NODE_INSTALL_CUDA=skip node scripts/postinstall-embedding-backend.cjs`;
}

/** Same liveness probe the daemon runs on itself before listening. */
async function probeUnixSocket(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return false;
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const finish = (listening: boolean): void => {
      socket.destroy();
      resolve(listening);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

/**
 * Worker locks sit at the top of the memory root and of each project store.
 * A directory that exists but cannot be listed is returned as unscanned, so
 * the caller can decline instead of assuming no worker holds a lock there.
 */
function findStoreLockFiles(memoryRoot: string): { lockFiles: string[]; unscanned: string[] } {
  const unscanned: string[] = [];
  const list = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).map((entry) => path.join(dir, entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unscanned.push(dir);
      return [];
    }
  };
  const storeDirs = [memoryRoot, ...list(path.join(memoryRoot, 'projects'))];
  const lockFiles = storeDirs.flatMap((dir) => list(dir).filter((entry) => entry.endsWith('.lock')));
  return { lockFiles, unscanned };
}

/**
 * Every reason a repair here would be unsafe or pointless; empty means go.
 * All of them are collected so one run shows everything to resolve.
 */
async function findRepairBlockers(
  context: EmbeddingBackendRepairContext,
  script: Required<EmbeddingBackendScript>
): Promise<string[]> {
  const deps = context.deps ?? {};
  const env = context.env ?? process.env;
  const realpathImpl = deps.realpathImpl ?? fs.realpathSync;
  const canonicalPath = (filePath: string): string => {
    try {
      return realpathImpl(filePath);
    } catch {
      return path.resolve(filePath);
    }
  };
  const reasons: string[] = [];

  // The runtime loads the backend next to its own package; repairing another
  // install's copy would report success and leave this CLI broken.
  if (!context.runningPackageRoot) {
    reasons.push(`Could not identify the install the running CLI belongs to, so cannot confirm ${context.packageRoot} holds the backend it loads.`);
  } else if (canonicalPath(context.runningPackageRoot) !== canonicalPath(context.packageRoot)) {
    reasons.push(`The running CLI belongs to ${context.runningPackageRoot}, but the checked backend is under ${context.packageRoot}.`);
  }

  // npm rewrites the manifest and lockfile and installs under node_modules;
  // files deeper in the existing dependency tree are not walked.
  const backendDir = script.getManagedBackendDir(context.packageRoot);
  const writeTargets = [
    findNearestExistingPath(path.join(backendDir, 'node_modules')),
    ...['package.json', 'package-lock.json'].map((file) => path.join(backendDir, file)).filter((file) => fs.existsSync(file))
  ];
  for (const target of writeTargets) {
    try {
      (deps.accessImpl ?? fs.accessSync)(target, fs.constants.W_OK);
    } catch {
      reasons.push(`${target} is not writable by this user.`);
    }
  }

  if (script.isSkipRequested(env)) {
    reasons.push('CLAUDE_MEMORY_LAYER_SKIP_EMBEDDING_POSTINSTALL (or the postinstall repair guard) is set, which disables the backend download.');
  }
  // Asked of npm with the env and prefix the install will run with, so every
  // .npmrc layer and npm_config_* variable is accounted for.
  const execFileSyncImpl = deps.execFileSyncImpl
    ?? ((command: string, args: string[], options: NpmQueryOptions) => execFileSync(command, args, options));
  try {
    const offline = execFileSyncImpl(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['config', 'get', 'offline', '--prefix', backendDir], {
      cwd: context.packageRoot,
      env: script.createRepairEnv(env),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (offline.trim() === 'true') reasons.push('npm is configured offline (npm config get offline = true), so the backend cannot be downloaded.');
  } catch (error) {
    reasons.push(`Could not run npm, which the repair downloads the backend with: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Reinstalling replaces native modules (onnxruntime, sharp) under a process
  // that may have them loaded.
  const lockOptions = deps.isProcessRunning ? { isProcessRunning: deps.isProcessRunning } : {};
  const { lockFiles, unscanned } = findStoreLockFiles(context.memoryRoot);
  for (const dir of unscanned) reasons.push(`Could not scan ${dir} for worker locks.`);
  for (const lockPath of lockFiles) {
    const holder = new WorkerLock(lockPath, lockOptions).busyHolder();
    if (holder) reasons.push(`${lockPath} is held by ${holder.pid ? `running process ${holder.pid}` : 'a worker that is still starting'}.`);
  }
  if (await (deps.probeSocketImpl ?? probeUnixSocket)(context.semanticSocketPath)) {
    reasons.push(`The semantic daemon is listening on ${context.semanticSocketPath}; wait for it to exit after its idle timeout.`);
  }

  return reasons;
}

function hasRepairEntrypoints(script: EmbeddingBackendScript): script is Required<EmbeddingBackendScript> {
  return typeof script.runPostinstall === 'function'
    && typeof script.getManagedBackendDir === 'function'
    && typeof script.isSkipRequested === 'function'
    && typeof script.createRepairEnv === 'function';
}

/** Idempotent: a passing check is returned untouched without inspecting anything. */
export async function repairEmbeddingBackend(
  check: DoctorCheckResult,
  context: EmbeddingBackendRepairContext
): Promise<EmbeddingBackendRepair> {
  if (check.status === 'pass') return { outcome: { kind: 'not-needed' }, check };

  const { script } = context;
  if (!script || !hasRepairEntrypoints(script)) {
    return {
      outcome: {
        kind: 'declined',
        reasons: ['The embedding backend postinstall script is missing or has no repair entrypoint.'],
        manualCommand: check.fix ?? 'Reinstall: npm install -g claude-memory-layer@latest'
      },
      check
    };
  }

  const manualCommand = manualRepairCommand(context.packageRoot);
  const reasons = await findRepairBlockers(context, script);
  if (reasons.length > 0) {
    return { outcome: { kind: 'declined', reasons, manualCommand }, check };
  }

  // Two concurrent `doctor --fix` runs would both pass the checks above and
  // run npm into the same prefix; the second one declines here instead.
  const repairLock = new WorkerLock(`${script.getManagedBackendDir(context.packageRoot)}.repair.lock`);
  let lockResult: ReturnType<WorkerLock['acquire']>;
  try {
    lockResult = repairLock.acquire();
  } catch (error) {
    const reason = `Could not take the repair lock: ${error instanceof Error ? error.message : String(error)}`;
    return { outcome: { kind: 'declined', reasons: [reason], manualCommand }, check };
  }
  if (!lockResult.acquired) {
    const reason = `Another doctor --fix (pid ${lockResult.holderPid ?? 'unknown'}) is already repairing this backend.`;
    return { outcome: { kind: 'declined', reasons: [reason], manualCommand }, check };
  }

  try {
    script.runPostinstall({ rootDir: context.packageRoot, env: context.env ?? process.env });
    const recheck = checkEmbeddingBackend(context.packageRoot, script.isEmbeddingBackendAvailable);
    return {
      outcome: recheck.status === 'pass' ? { kind: 'repaired' } : { kind: 'failed', manualCommand },
      check: recheck
    };
  } finally {
    repairLock.release();
  }
}

export function formatEmbeddingBackendRepair(outcome: EmbeddingBackendRepairOutcome): string {
  const lines = ['', 'Embedding backend repair (--fix)', ''];
  if (outcome.kind === 'not-needed') {
    lines.push('  Nothing to repair: the embedding backend check already passes.');
  } else if (outcome.kind === 'repaired') {
    lines.push('  Repaired: the re-run embedding backend healthcheck passes.');
  } else if (outcome.kind === 'failed') {
    lines.push('  Repair ran, but the re-run embedding backend healthcheck still fails.');
    lines.push(`  Run manually: ${outcome.manualCommand}`);
  } else {
    lines.push('  Declined; the backend was left untouched:');
    for (const reason of outcome.reasons) lines.push(`    - ${reason}`);
    lines.push(`  Run manually once resolved: ${outcome.manualCommand}`);
  }
  return lines.join('\n');
}

/**
 * Without `fix` this is exactly the plain report. With it, only the
 * embedding-backend check is repaired, and its row shows the re-run result.
 */
export async function runDoctor(
  checks: DoctorCheckResult[],
  options: { fix: boolean; repairEmbeddingBackend: (check: DoctorCheckResult) => Promise<EmbeddingBackendRepair> }
): Promise<{ output: string; exitCode: number }> {
  const index = checks.findIndex((check) => check.name === 'embedding-backend');
  if (!options.fix || index === -1) {
    return { output: formatDoctorReport(checks), exitCode: doctorExitCode(checks) };
  }
  const repair = await options.repairEmbeddingBackend(checks[index]);
  const finalChecks = checks.map((check, i) => (i === index ? repair.check : check));
  return {
    output: `${formatEmbeddingBackendRepair(repair.outcome)}\n${formatDoctorReport(finalChecks)}`,
    exitCode: doctorExitCode(finalChecks)
  };
}
