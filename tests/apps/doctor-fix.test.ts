import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatEmbeddingBackendRepair,
  repairEmbeddingBackend,
  runDoctor,
  type EmbeddingBackendRepairContext
} from '../../src/apps/cli/doctor-fix.js';
import {
  checkEmbeddingBackend,
  doctorExitCode,
  formatDoctorReport,
  type DoctorCheckResult,
  type EmbeddingBackendScript
} from '../../src/apps/cli/doctor.js';

const require = createRequire(import.meta.url);
const realScript = require('../../scripts/postinstall-embedding-backend.cjs') as Required<EmbeddingBackendScript>;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The real script's env and path helpers with the healthcheck and the
 * download mocked out, so no test ever runs npm or touches a real backend.
 */
function fakeScript(options: { available: boolean; repairs?: boolean }) {
  let available = options.available;
  const runPostinstall = vi.fn(() => {
    if (options.repairs) available = true;
    return { attempted: true, success: options.repairs === true };
  });
  const script: Required<EmbeddingBackendScript> = {
    isEmbeddingBackendAvailable: () => available,
    runPostinstall,
    getManagedBackendDir: realScript.getManagedBackendDir,
    isSkipRequested: realScript.isSkipRequested,
    createRepairEnv: realScript.createRepairEnv
  };
  return { script, runPostinstall };
}

/** A temp HOME and a temp package root that every safety check accepts. */
function makeContext(
  script: EmbeddingBackendScript | null,
  overrides: Partial<EmbeddingBackendRepairContext> = {}
): EmbeddingBackendRepairContext {
  const root = mkdtempSync(join(tmpdir(), 'cml-doctor-fix-'));
  tempDirs.push(root);
  const packageRoot = join(root, 'pkg');
  const memoryRoot = join(root, 'home', '.claude-code', 'memory');
  mkdirSync(join(packageRoot, 'node_modules'), { recursive: true });
  mkdirSync(memoryRoot, { recursive: true });
  return {
    packageRoot,
    runningPackageRoot: packageRoot,
    script,
    memoryRoot,
    semanticSocketPath: join(memoryRoot, 'semantic-daemon.sock'),
    env: {},
    ...overrides,
    deps: {
      execFileSyncImpl: () => 'false\n',
      probeSocketImpl: async () => false,
      ...overrides.deps
    }
  };
}

function failingCheck(context: EmbeddingBackendRepairContext): DoctorCheckResult {
  return checkEmbeddingBackend(context.packageRoot, context.script?.isEmbeddingBackendAvailable ?? null);
}

async function expectDeclined(
  context: EmbeddingBackendRepairContext,
  runPostinstall: ReturnType<typeof vi.fn>,
  reasonFragment: string
): Promise<string[]> {
  const check = failingCheck(context);
  const result = await repairEmbeddingBackend(check, context);
  expect(result.outcome.kind).toBe('declined');
  if (result.outcome.kind !== 'declined') throw new Error('unreachable');
  expect(result.outcome.reasons.join('\n')).toContain(reasonFragment);
  expect(result.outcome.manualCommand).toContain('postinstall-embedding-backend.cjs');
  expect(result.check).toEqual(check);
  expect(runPostinstall).not.toHaveBeenCalled();
  return result.outcome.reasons;
}

describe('repairEmbeddingBackend', () => {
  it('does nothing when the backend check already passes', async () => {
    const { script, runPostinstall } = fakeScript({ available: true });
    const context = makeContext(script);
    const before = readdirSync(context.packageRoot, { recursive: true });
    const check = failingCheck(context);
    expect(check.status).toBe('pass');

    const result = await repairEmbeddingBackend(check, context);

    expect(result.outcome).toEqual({ kind: 'not-needed' });
    expect(result.check).toEqual(check);
    expect(runPostinstall).not.toHaveBeenCalled();
    expect(readdirSync(context.packageRoot, { recursive: true })).toEqual(before);
  });

  it('runs the postinstall repair and reports the re-run healthcheck', async () => {
    const { script, runPostinstall } = fakeScript({ available: false, repairs: true });
    const context = makeContext(script);

    const result = await repairEmbeddingBackend(failingCheck(context), context);

    expect(result.outcome).toEqual({ kind: 'repaired' });
    expect(result.check.status).toBe('pass');
    expect(runPostinstall).toHaveBeenCalledTimes(1);
    expect(runPostinstall).toHaveBeenCalledWith(expect.objectContaining({ rootDir: context.packageRoot }));
  });

  it('reports failure with a manual command when the re-run healthcheck still fails', async () => {
    const { script, runPostinstall } = fakeScript({ available: false, repairs: false });
    const context = makeContext(script);

    const result = await repairEmbeddingBackend(failingCheck(context), context);

    expect(runPostinstall).toHaveBeenCalledTimes(1);
    expect(result.outcome.kind).toBe('failed');
    if (result.outcome.kind !== 'failed') throw new Error('unreachable');
    expect(result.outcome.manualCommand).toContain(context.packageRoot);
    expect(result.outcome.manualCommand).toContain('ONNXRUNTIME_NODE_INSTALL_CUDA=skip node scripts/postinstall-embedding-backend.cjs');
    expect(result.check.status).toBe('fail');
  });

  it('declines when the backend location is not writable', async () => {
    const { script, runPostinstall } = fakeScript({ available: false, repairs: true });
    const context = makeContext(script, {
      deps: {
        accessImpl: () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
      }
    });

    await expectDeclined(context, runPostinstall, 'is not writable');
  });

  it('declines while a live process holds a worker lock in a store', async () => {
    const { script, runPostinstall } = fakeScript({ available: false, repairs: true });
    const context = makeContext(script);
    const lockDir = join(context.memoryRoot, 'projects', 'abcd1234');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'vector-worker.lock'), JSON.stringify({
      pid: process.pid,
      ownerId: 'test',
      acquiredAt: new Date().toISOString()
    }));

    const reasons = await expectDeclined(context, runPostinstall, join(lockDir, 'vector-worker.lock'));
    expect(reasons.join('\n')).toContain(String(process.pid));
  });

  it('ignores a stale worker lock whose holder is gone', async () => {
    const { script, runPostinstall } = fakeScript({ available: false, repairs: true });
    const context = makeContext(script, { deps: { isProcessRunning: () => false } });
    writeFileSync(join(context.memoryRoot, 'vector-worker.lock'), JSON.stringify({ pid: 999999, ownerId: 'gone' }));

    const result = await repairEmbeddingBackend(failingCheck(context), context);

    expect(result.outcome).toEqual({ kind: 'repaired' });
    expect(runPostinstall).toHaveBeenCalledTimes(1);
  });

  it('declines while the semantic daemon is listening', async () => {
    const { script, runPostinstall } = fakeScript({ available: false, repairs: true });
    const probeSocketImpl = vi.fn(async () => true);
    const context = makeContext(script, { deps: { probeSocketImpl } });

    await expectDeclined(context, runPostinstall, 'semantic daemon');
    expect(probeSocketImpl).toHaveBeenCalledWith(context.semanticSocketPath);
  });

  it('declines when the backend download is disabled by environment', async () => {
    const { script, runPostinstall } = fakeScript({ available: false, repairs: true });
    const context = makeContext(script, { env: { CLAUDE_MEMORY_LAYER_SKIP_EMBEDDING_POSTINSTALL: '1' } });

    await expectDeclined(context, runPostinstall, 'CLAUDE_MEMORY_LAYER_SKIP_EMBEDDING_POSTINSTALL');
  });

  it('declines when npm is configured offline, asking npm with the repair env', async () => {
    const { script, runPostinstall } = fakeScript({ available: false, repairs: true });
    const execFileSyncImpl = vi.fn(() => 'true\n');
    const context = makeContext(script, { env: { npm_config_global: 'true' }, deps: { execFileSyncImpl } });

    await expectDeclined(context, runPostinstall, 'offline');
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      expect.stringMatching(/^npm(\.cmd)?$/),
      ['config', 'get', 'offline'],
      expect.objectContaining({ cwd: context.packageRoot })
    );
    // Same env the install would run with: inherited location settings stripped.
    const options = execFileSyncImpl.mock.calls[0]?.[2] as unknown as { env: NodeJS.ProcessEnv };
    expect(options.env.npm_config_global).toBeUndefined();
  });

  it('declines when npm cannot be run', async () => {
    const { script, runPostinstall } = fakeScript({ available: false, repairs: true });
    const context = makeContext(script, {
      deps: {
        execFileSyncImpl: () => {
          throw new Error('spawnSync npm ENOENT');
        }
      }
    });

    await expectDeclined(context, runPostinstall, 'npm');
  });

  it('declines when the running CLI belongs to a different install than the checked backend', async () => {
    const { script, runPostinstall } = fakeScript({ available: false, repairs: true });
    const otherRoot = mkdtempSync(join(tmpdir(), 'cml-doctor-fix-other-'));
    tempDirs.push(otherRoot);
    const context = makeContext(script, { runningPackageRoot: otherRoot });

    const reasons = await expectDeclined(context, runPostinstall, otherRoot);
    expect(reasons.join('\n')).toContain(context.packageRoot);
  });

  it('declines when the running CLI install cannot be identified', async () => {
    const { script, runPostinstall } = fakeScript({ available: false, repairs: true });
    const context = makeContext(script, { runningPackageRoot: undefined });

    await expectDeclined(context, runPostinstall, 'running CLI');
  });

  it('declines when the postinstall script could not be loaded', async () => {
    const context = makeContext(null);

    const result = await repairEmbeddingBackend(failingCheck(context), context);

    expect(result.outcome.kind).toBe('declined');
    expect(result.check.status).toBe('fail');
  });

  it('reports every reason it declined for, not just the first', async () => {
    const { script, runPostinstall } = fakeScript({ available: false, repairs: true });
    const context = makeContext(script, {
      env: { CLAUDE_MEMORY_LAYER_SKIP_EMBEDDING_POSTINSTALL: '1' },
      deps: { probeSocketImpl: async () => true }
    });

    const reasons = await expectDeclined(context, runPostinstall, 'semantic daemon');
    expect(reasons.join('\n')).toContain('CLAUDE_MEMORY_LAYER_SKIP_EMBEDDING_POSTINSTALL');
  });
});

describe('formatEmbeddingBackendRepair', () => {
  it('lists each decline reason and the command to run by hand', () => {
    const output = formatEmbeddingBackendRepair({
      kind: 'declined',
      reasons: ['first reason', 'second reason'],
      manualCommand: 'run-this'
    });
    expect(output).toContain('first reason');
    expect(output).toContain('second reason');
    expect(output).toContain('run-this');
  });
});

describe('runDoctor', () => {
  const nodeCheck: DoctorCheckResult = { name: 'node', status: 'pass', detail: 'v22.0.0' };
  const brokenBackend: DoctorCheckResult = {
    name: 'embedding-backend',
    status: 'fail',
    detail: 'Required embedding backend is not installed — semantic/vector search will not work',
    fix: 'ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g claude-memory-layer@latest'
  };

  it('prints exactly the plain report and never repairs without --fix', async () => {
    const checks = [nodeCheck, brokenBackend];
    const repair = vi.fn();

    const result = await runDoctor(checks, { fix: false, repairEmbeddingBackend: repair });

    expect(result.output).toBe(formatDoctorReport(checks));
    expect(result.exitCode).toBe(doctorExitCode(checks));
    expect(result.exitCode).toBe(1);
    expect(repair).not.toHaveBeenCalled();
  });

  it('repairs only the embedding backend and reports the re-checked result', async () => {
    const hooksCheck: DoctorCheckResult = { name: 'hooks', status: 'warn', detail: 'custom', fix: 'install' };
    const repairedCheck: DoctorCheckResult = { name: 'embedding-backend', status: 'pass', detail: 'installed' };
    const repair = vi.fn(async () => ({ outcome: { kind: 'repaired' as const }, check: repairedCheck }));

    const result = await runDoctor([nodeCheck, brokenBackend, hooksCheck], { fix: true, repairEmbeddingBackend: repair });

    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledWith(brokenBackend);
    const finalChecks = [nodeCheck, repairedCheck, hooksCheck];
    expect(result.output).toContain(formatEmbeddingBackendRepair({ kind: 'repaired' }));
    expect(result.output).toContain(formatDoctorReport(finalChecks));
    expect(result.exitCode).toBe(0);
  });

  it('exits non-zero when the repair fails', async () => {
    const repair = vi.fn(async () => ({
      outcome: { kind: 'failed' as const, manualCommand: 'run-this' },
      check: brokenBackend
    }));

    const result = await runDoctor([nodeCheck, brokenBackend], { fix: true, repairEmbeddingBackend: repair });

    expect(result.output).toContain('run-this');
    expect(result.exitCode).toBe(1);
  });
});
