import {
  createCodexSessionHistoryImporter,
  type CodexSessionHistoryImporter,
  type CodexSessionHistoryImporterOptions
} from '../../services/codex-session-history-importer.js';
import {
  getDefaultMemoryService,
  getMemoryServiceForProject,
  type MemoryService
} from '../../services/memory-service.js';
import type { ImportOptions, ImportResult, ProgressEvent } from '../../services/session-history-importer.js';

export interface CodexImportCommandOptions {
  project?: string;
  session?: string;
  all?: boolean;
  limit?: string;
  sessionLimit?: string;
  force?: boolean;
  verbose?: boolean;
  sessionsDir?: string;
  processEmbeddings?: boolean;
}

export interface CodexImportOutcome {
  mode: 'project' | 'session' | 'all';
  storageScope: 'project' | 'global';
  projectPath?: string;
  result: ImportResult;
  embedCount: number;
}

export interface CodexImportRunnerDeps {
  cwd: () => string;
  getDefaultMemoryService: () => MemoryService;
  getMemoryServiceForProject: (projectPath: string) => MemoryService;
  createImporter: (
    memoryService: MemoryService,
    options?: CodexSessionHistoryImporterOptions
  ) => Pick<CodexSessionHistoryImporter, 'importProject' | 'importAll' | 'importSessionFile'>;
  onProgress?: (event: ProgressEvent) => void;
}

const realDeps: CodexImportRunnerDeps = {
  cwd: () => process.cwd(),
  getDefaultMemoryService,
  getMemoryServiceForProject,
  createImporter: createCodexSessionHistoryImporter
};

function parsePositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid --${name}: expected a positive integer`);
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name}: expected a positive integer`);
  }
  return parsed;
}

function shouldUseGlobalStorage(options: CodexImportCommandOptions): boolean {
  return options.all === true && !options.project && !options.session;
}

export async function runCodexImportOnce(
  options: CodexImportCommandOptions,
  deps: CodexImportRunnerDeps = realDeps
): Promise<CodexImportOutcome> {
  const targetProjectPath = options.project || deps.cwd();
  const useGlobalStorage = shouldUseGlobalStorage(options);
  const memoryService = useGlobalStorage
    ? deps.getDefaultMemoryService()
    : deps.getMemoryServiceForProject(targetProjectPath);
  const importer = deps.createImporter(memoryService, { sessionsDir: options.sessionsDir });

  const importOptions: ImportOptions = {
    limit: parsePositiveInteger(options.limit, 'limit'),
    sessionLimit: parsePositiveInteger(options.sessionLimit, 'session-limit'),
    force: options.force,
    verbose: options.verbose,
    onProgress: deps.onProgress
  };

  let mode: CodexImportOutcome['mode'];
  let result: ImportResult;

  try {
    await memoryService.initialize();
    await memoryService.ensureEmbeddingModelForImport({ autoMigrate: true });

    if (options.session) {
      mode = 'session';
      result = await importer.importSessionFile(options.session, {
        ...importOptions,
        projectPath: targetProjectPath
      });
    } else if (options.all) {
      mode = 'all';
      result = await importer.importAll(importOptions);
    } else {
      mode = 'project';
      result = await importer.importProject(targetProjectPath, {
        ...importOptions,
        projectPath: targetProjectPath
      });
    }

    const embedCount = options.processEmbeddings === false
      ? 0
      : await memoryService.processPendingEmbeddings();

    return {
      mode,
      storageScope: useGlobalStorage ? 'global' : 'project',
      projectPath: useGlobalStorage ? undefined : targetProjectPath,
      result,
      embedCount
    };
  } finally {
    await memoryService.shutdown();
  }
}
