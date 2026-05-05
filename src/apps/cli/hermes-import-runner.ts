import {
  createHermesSessionHistoryImporter,
  type HermesSessionHistoryImporter,
  type HermesSessionHistoryImporterOptions
} from '../../services/hermes-session-history-importer.js';
import {
  getDefaultMemoryService,
  getMemoryServiceForProject,
  type MemoryService
} from '../../services/memory-service.js';
import type { ImportOptions, ImportResult, ProgressEvent } from '../../services/session-history-importer.js';

export interface HermesImportCommandOptions {
  project?: string;
  session?: string;
  all?: boolean;
  limit?: string;
  force?: boolean;
  verbose?: boolean;
  stateDb?: string;
  stateDbPath?: string;
  processEmbeddings?: boolean;
}

export interface HermesImportOutcome {
  mode: 'project' | 'session' | 'all';
  storageScope: 'project' | 'global';
  projectPath?: string;
  result: ImportResult;
  embedCount: number;
}

export interface HermesImportRunnerDeps {
  cwd: () => string;
  getDefaultMemoryService: () => MemoryService;
  getMemoryServiceForProject: (projectPath: string) => MemoryService;
  createImporter: (
    memoryService: MemoryService,
    options?: HermesSessionHistoryImporterOptions
  ) => Pick<HermesSessionHistoryImporter, 'importProject' | 'importAll' | 'importSession'>;
  onProgress?: (event: ProgressEvent) => void;
}

const realDeps: HermesImportRunnerDeps = {
  cwd: () => process.cwd(),
  getDefaultMemoryService,
  getMemoryServiceForProject,
  createImporter: createHermesSessionHistoryImporter
};

function parsePositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name}: expected a positive integer`);
  }
  return parsed;
}

function shouldUseGlobalStorage(options: HermesImportCommandOptions): boolean {
  return options.all === true && !options.project && !options.session;
}

function getStateDbPathOption(options: HermesImportCommandOptions): string | undefined {
  return options.stateDbPath ?? options.stateDb;
}

export async function runHermesImportOnce(
  options: HermesImportCommandOptions,
  deps: HermesImportRunnerDeps = realDeps
): Promise<HermesImportOutcome> {
  const targetProjectPath = options.project || deps.cwd();
  const useGlobalStorage = shouldUseGlobalStorage(options);
  const memoryService = useGlobalStorage
    ? deps.getDefaultMemoryService()
    : deps.getMemoryServiceForProject(targetProjectPath);
  const importer = deps.createImporter(memoryService, { stateDbPath: getStateDbPathOption(options) });

  await memoryService.initialize();
  await memoryService.ensureEmbeddingModelForImport({ autoMigrate: true });

  const importOptions: ImportOptions = {
    limit: parsePositiveInteger(options.limit, 'limit'),
    force: options.force,
    verbose: options.verbose,
    onProgress: deps.onProgress
  };

  let mode: HermesImportOutcome['mode'];
  let result: ImportResult;

  try {
    if (options.session) {
      mode = 'session';
      result = await importer.importSession(options.session, {
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
