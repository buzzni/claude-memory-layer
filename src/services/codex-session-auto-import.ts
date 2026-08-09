import * as fs from 'node:fs';
import * as path from 'node:path';

import { getProjectStoragePath } from '../core/registry/project-path.js';
import {
  createCodexSessionHistoryImporter,
  type CodexSessionHistoryImporter,
  type CodexSessionHistoryImporterOptions
} from './codex-session-history-importer.js';
import {
  getMemoryServiceForProject,
  type MemoryService
} from './memory-service.js';
import type { ImportResult } from './session-history-importer.js';

export interface CodexSessionAutoImportInput {
  transcriptPath: string;
  projectPath: string;
}

export interface CodexSessionAutoImportResult {
  result: ImportResult;
}

export interface CodexAutoImportStatus {
  status: 'success' | 'failed';
  updatedAt: string;
  importedPrompts?: number;
  importedResponses?: number;
  skippedDuplicates?: number;
  error?: string;
}

export interface CodexSessionAutoImportDeps {
  getMemoryServiceForProject: (projectPath: string) => MemoryService;
  createImporter: (
    memoryService: MemoryService,
    options?: CodexSessionHistoryImporterOptions
  ) => Pick<CodexSessionHistoryImporter, 'importSessionFile'>;
  statTranscript: (transcriptPath: string) => Pick<fs.Stats, 'isFile'>;
  writeStatus: (projectPath: string, status: CodexAutoImportStatus) => void;
}

const realDeps: CodexSessionAutoImportDeps = {
  getMemoryServiceForProject,
  createImporter: createCodexSessionHistoryImporter,
  statTranscript: fs.statSync,
  writeStatus: writeCodexAutoImportStatus
};

export function getCodexAutoImportStatusPath(projectPath: string): string {
  return path.join(getProjectStoragePath(projectPath), 'codex-auto-import-status.json');
}

export function writeCodexAutoImportStatus(projectPath: string, status: CodexAutoImportStatus): void {
  const statusPath = getCodexAutoImportStatusPath(projectPath);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const tempPath = `${statusPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(status, null, 2)}\n`);
    fs.renameSync(tempPath, statusPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

export function readCodexAutoImportStatus(projectPath: string): CodexAutoImportStatus | null {
  try {
    const value = JSON.parse(fs.readFileSync(getCodexAutoImportStatusPath(projectPath), 'utf8')) as Partial<CodexAutoImportStatus>;
    if ((value.status !== 'success' && value.status !== 'failed') || typeof value.updatedAt !== 'string') return null;
    return value as CodexAutoImportStatus;
  } catch {
    return null;
  }
}

function statusError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500);
}

function writeStatusBestEffort(
  deps: CodexSessionAutoImportDeps,
  projectPath: string,
  status: CodexAutoImportStatus
): void {
  try {
    deps.writeStatus(projectPath, status);
  } catch {
    // Status is diagnostic only and must never change import success/failure.
  }
}

/**
 * Import one completed Codex transcript without doing embedding work in the
 * short-lived hook worker. Appends enqueue their own vector work; the regular
 * semantic daemon processes that queue independently.
 */
export async function importCodexSessionAtEnd(
  input: CodexSessionAutoImportInput,
  deps: CodexSessionAutoImportDeps = realDeps
): Promise<CodexSessionAutoImportResult> {
  if (!path.isAbsolute(input.projectPath)) {
    throw new Error('Codex auto-import requires an absolute project path');
  }
  let transcriptStat: Pick<fs.Stats, 'isFile'>;
  try {
    transcriptStat = deps.statTranscript(input.transcriptPath);
  } catch (error) {
    writeStatusBestEffort(deps, input.projectPath, {
      status: 'failed',
      updatedAt: new Date().toISOString(),
      error: 'Codex auto-import transcript does not exist'
    });
    throw new Error('Codex auto-import transcript does not exist', { cause: error });
  }
  if (!transcriptStat.isFile()) {
    writeStatusBestEffort(deps, input.projectPath, {
      status: 'failed',
      updatedAt: new Date().toISOString(),
      error: 'Codex auto-import transcript must be a file'
    });
    throw new Error('Codex auto-import transcript must be a file');
  }

  const memoryService = deps.getMemoryServiceForProject(input.projectPath);
  const importer = deps.createImporter(memoryService);
  let operationFailed = false;

  try {
    await memoryService.initialize();
    await memoryService.ensureEmbeddingModelForImport({ autoMigrate: true });
    const result = await importer.importSessionFile(input.transcriptPath, {
      projectPath: input.projectPath
    });
    if (result.errors.length > 0) {
      throw new Error(`Codex transcript import reported ${result.errors.length} error(s): ${result.errors[0]}`);
    }
    writeStatusBestEffort(deps, input.projectPath, {
      status: 'success',
      updatedAt: new Date().toISOString(),
      importedPrompts: result.importedPrompts,
      importedResponses: result.importedResponses,
      skippedDuplicates: result.skippedDuplicates
    });
    return { result };
  } catch (error) {
    operationFailed = true;
    writeStatusBestEffort(deps, input.projectPath, {
      status: 'failed',
      updatedAt: new Date().toISOString(),
      error: statusError(error)
    });
    throw error;
  } finally {
    try {
      await memoryService.shutdown();
    } catch (error) {
      if (!operationFailed) {
        writeStatusBestEffort(deps, input.projectPath, {
          status: 'failed',
          updatedAt: new Date().toISOString(),
          error: statusError(error)
        });
        throw error;
      }
    }
  }
}
