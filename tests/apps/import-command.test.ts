import { describe, expect, it } from 'vitest';

import {
  formatImportLockBusy,
  resolveImportCommandLockOptions
} from '../../src/apps/cli/import-command.js';

const deps = {
  cwd: () => '/repo/current',
  homedir: () => '/home/tester',
  getProjectStoragePath: (projectPath: string) => `/private-store/${projectPath.split('/').at(-1)}`
};

describe('import command worker lock', () => {
  it('derives a project-scoped lock for default and selected-project imports', () => {
    expect(resolveImportCommandLockOptions({}, deps)).toEqual({
      storageScope: 'project',
      projectPath: '/repo/current',
      lockPath: '/private-store/current/vector-worker.lock'
    });
    expect(resolveImportCommandLockOptions({ project: '/repo/selected' }, deps)).toEqual({
      storageScope: 'project',
      projectPath: '/repo/selected',
      lockPath: '/private-store/selected/vector-worker.lock'
    });
  });

  it('uses the global memory lock only for unscoped all-session imports', () => {
    expect(resolveImportCommandLockOptions({ all: true }, deps)).toEqual({
      storageScope: 'global',
      lockPath: '/home/tester/.claude-code/memory/vector-worker.lock'
    });
    expect(resolveImportCommandLockOptions({ all: true, session: '/tmp/one.jsonl' }, deps).storageScope)
      .toBe('project');
  });

  it('allows a non-empty lock override and renders actionable contention output', () => {
    const options = resolveImportCommandLockOptions({ lockPath: '/tmp/import.lock' }, deps);
    expect(options.lockPath).toBe('/tmp/import.lock');
    expect(formatImportLockBusy(options, 1234)).toContain('holderPid=1234');
    expect(formatImportLockBusy(options, 1234)).toContain('import was not started');
    expect(() => resolveImportCommandLockOptions({ lockPath: '  ' }, deps)).toThrow('--lock-path must not be empty');
  });
});
