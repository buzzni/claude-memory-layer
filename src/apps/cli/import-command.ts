import * as os from 'node:os';
import * as path from 'node:path';

import { getProjectStoragePath as defaultGetProjectStoragePath } from '../../core/registry/project-path.js';

export interface RawImportCommandOptions {
  project?: string;
  session?: string;
  all?: boolean;
  lockPath?: string;
}

export interface ImportCommandLockOptions {
  storageScope: 'project' | 'global';
  projectPath?: string;
  lockPath: string;
}

export interface ImportCommandLockDeps {
  cwd?: () => string;
  homedir?: () => string;
  getProjectStoragePath?: (projectPath: string) => string;
}

export function resolveImportCommandLockOptions(
  options: RawImportCommandOptions,
  deps: ImportCommandLockDeps = {}
): ImportCommandLockOptions {
  if (options.lockPath !== undefined && options.lockPath.trim().length === 0) {
    throw new Error('--lock-path must not be empty');
  }

  const useGlobalStorage = options.all === true && !options.project && !options.session;
  if (useGlobalStorage) {
    const globalStoragePath = path.join((deps.homedir ?? os.homedir)(), '.claude-code', 'memory');
    return {
      storageScope: 'global',
      lockPath: options.lockPath ?? path.join(globalStoragePath, 'vector-worker.lock')
    };
  }

  const projectPath = options.project ?? (deps.cwd ?? (() => process.cwd()))();
  const getProjectStoragePath = deps.getProjectStoragePath ?? defaultGetProjectStoragePath;
  return {
    storageScope: 'project',
    projectPath,
    lockPath: options.lockPath ?? path.join(getProjectStoragePath(projectPath), 'vector-worker.lock')
  };
}

export function formatImportLockBusy(options: ImportCommandLockOptions, holderPid: number | null): string {
  return [
    'Another vector worker is already running; import was not started.',
    `Storage scope: ${options.storageScope}`,
    ...(options.projectPath ? [`Project: ${options.projectPath}`] : []),
    `holderPid=${holderPid ?? 'unknown'}`,
    `lockPath=${options.lockPath}`,
    'Stop the active writer or retry after it finishes.'
  ].join('\n');
}
