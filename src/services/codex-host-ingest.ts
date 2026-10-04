/** Installed host entry: capability checks do not open storage or initialize models. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectStoragePath, hashProjectPath } from '../core/registry/project-path.js';
import { planPromptStorage, promptClassifierMetadata, redactPromptForStorage } from '../core/prompt-normalizer.js';
import { truncateAgentResponse } from './turn-buffering.js';
import { readCodexCompletedTurns, type CodexCompletedTurns } from './codex-completed-turns.js';
import type { MemoryService } from './memory-service.js';

export { readCodexCompletedTurns } from './codex-completed-turns.js';

export const CML_CODEX_INGEST_CAPABILITIES = Object.freeze({ version: 1, completedTurnsOnly: true });

export interface CodexCompletedImportInput {
  projectPath: string;
  transcriptPath: string;
  /** The provider's own thread id, matched to transcript session_meta.id. */
  sessionId: string;
  throughTurnId: string;
}

export interface CodexCompletedImportResult {
  importedPrompts: number;
  importedResponses: number;
  skippedDuplicates: number;
  completedTurns: number;
}

export interface CodexHostIngestStatus extends Partial<CodexCompletedImportResult> {
  status: 'success' | 'failed';
  updatedAt: string;
  reason?: CodexHostIngestFailure;
}

const FAILURE_REASONS = ['session_mismatch', 'invalid_transcript', 'incomplete_turn', 'project_mismatch', 'append_failed', 'import_failed'] as const;
type CodexHostIngestFailure = typeof FAILURE_REASONS[number];
const COUNT_FIELDS = ['importedPrompts', 'importedResponses', 'skippedDuplicates', 'completedTurns'] as const;

type IngestService = Pick<MemoryService, 'initialize' | 'shutdown' | 'startSession' | 'hasSessionUserPrompt' | 'storeUserPrompt' | 'storeAgentResponse'>;
export interface CodexCompletedImportDeps {
  readTranscript: typeof readCodexCompletedTurns;
  hashProjectPath: typeof hashProjectPath;
  createService: (projectPath: string) => Promise<IngestService>;
  writeStatus: (projectPath: string, status: CodexHostIngestStatus) => void;
}

export function getCodexHostIngestStatusPath(projectPath: string): string {
  return path.join(getProjectStoragePath(projectPath), 'codex-host-ingest-status.json');
}

export function readCodexHostIngestStatus(projectPath: string): CodexHostIngestStatus | null {
  try {
    const status = JSON.parse(fs.readFileSync(getCodexHostIngestStatusPath(projectPath), 'utf8')) as CodexHostIngestStatus;
    if (!status || !['success', 'failed'].includes(status.status)
      || typeof status.updatedAt !== 'string' || !Number.isFinite(Date.parse(status.updatedAt))) return null;
    if (status.status === 'failed') {
      return FAILURE_REASONS.includes(status.reason!) ? { status: 'failed', updatedAt: new Date(status.updatedAt).toISOString(), reason: status.reason } : null;
    }
    if (COUNT_FIELDS.some(key => !Number.isSafeInteger(status[key]) || status[key]! < 0)) return null;
    return { status: 'success', updatedAt: new Date(status.updatedAt).toISOString(),
      importedPrompts: status.importedPrompts, importedResponses: status.importedResponses,
      skippedDuplicates: status.skippedDuplicates, completedTurns: status.completedTurns };
  } catch { return null; }
}

function writeStatus(projectPath: string, status: CodexHostIngestStatus): void {
  const target = getCodexHostIngestStatusPath(projectPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(status) + '\n', { mode: 0o600 }); fs.renameSync(temp, target); }
  finally { fs.rmSync(temp, { force: true }); }
}

const realDeps: CodexCompletedImportDeps = {
  readTranscript: readCodexCompletedTurns,
  hashProjectPath,
  createService: async projectPath => {
    const { MemoryService, DISABLED_SHARED_STORE_CONFIG } = await import('./memory-service.js');
    // Each worker/operation owns its service. A closed registry-cached service
    // must not be reused by a later import. No Lance/model migration is needed.
    return new MemoryService({ storagePath: getProjectStoragePath(projectPath), projectPath,
      projectHash: hashProjectPath(projectPath), lightweightMode: true, analyticsEnabled: false,
      sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG });
  },
  writeStatus,
};

/** Native Codex adds these as separate user-role setup messages, not requests. */
function isSessionScaffold(text: string): boolean {
  let rest = text.trim();
  if (rest.startsWith('# AGENTS.md instructions for ')) {
    const open = rest.indexOf('\n<INSTRUCTIONS>\n');
    const close = rest.indexOf('</INSTRUCTIONS>');
    if (open < 0 || close < open) return false;
    rest = rest.slice(close + '</INSTRUCTIONS>'.length).trim();
  }
  if (rest.startsWith('<environment_context>')) {
    const close = rest.indexOf('</environment_context>');
    if (close < 0) return false;
    rest = rest.slice(close + '</environment_context>'.length).trim();
  }
  return rest.length === 0;
}

/** Import only explicitly completed provider turns; never close the live session. */
export async function importCodexCompletedTurns(
  input: CodexCompletedImportInput,
  deps: CodexCompletedImportDeps = realDeps,
): Promise<CodexCompletedImportResult> {
  if (!input || typeof input.projectPath !== 'string' || typeof input.transcriptPath !== 'string'
    || typeof input.sessionId !== 'string' || typeof input.throughTurnId !== 'string'
    || !path.isAbsolute(input.projectPath) || !path.isAbsolute(input.transcriptPath) || !input.sessionId.trim() || !input.throughTurnId.trim()) {
    throw new Error('invalid_input');
  }
  const saveStatus = (status: CodexHostIngestStatus) => {
    try { deps.writeStatus(input.projectPath, status); } catch { /* diagnostic failure cannot undo durable writes */ }
  };
  let service: IngestService | undefined;
  try {
    const transcript: CodexCompletedTurns = await deps.readTranscript(input.transcriptPath, input);
    const projectHash = deps.hashProjectPath(input.projectPath);
    if (!transcript.cwd || deps.hashProjectPath(transcript.cwd) !== projectHash
      || transcript.turns.some(turn => turn.cwd && deps.hashProjectPath(turn.cwd) !== projectHash)) {
      throw new Error('project_mismatch');
    }
    const result: CodexCompletedImportResult = { importedPrompts: 0, importedResponses: 0, skippedDuplicates: 0, completedTurns: transcript.turns.length };
    // No storage initialization for transcripts with no completed work.
    if (transcript.turns.length) {
      service = await deps.createService(input.projectPath);
      await service.initialize();
      await service.startSession(input.sessionId, input.projectPath);
      for (const turn of transcript.turns) {
        let hasUserRequest = false;
        for (const message of turn.userMessages) {
          if (isSessionScaffold(message)) continue;
          const plan = planPromptStorage(message);
          if (plan.normalized.kind !== 'user' || !plan.storedText.trim()) continue;
          hasUserRequest = true;
          if (plan.legacyContents.length && await service.hasSessionUserPrompt(input.sessionId, plan.legacyContents)) {
            result.skippedDuplicates++; continue;
          }
          const appended = await service.storeUserPrompt(input.sessionId, plan.storedText, {
            source: 'codex', ingestClient: 'codex-host', turnId: turn.turnId,
            originalTimestamp: turn.startedAt, ...promptClassifierMetadata(plan.normalized),
          });
          if (appended.success === false) throw new Error('append_failed');
          if (appended.isDuplicate) result.skippedDuplicates++; else result.importedPrompts++;
        }
        // An automatic/admin-only frame is not project evidence.
        if (!hasUserRequest || !turn.assistantResponse.trim()) continue;
        const appended = await service.storeAgentResponse(input.sessionId, truncateAgentResponse(redactPromptForStorage(turn.assistantResponse)), {
          source: 'codex', ingestClient: 'codex-host', turnId: turn.turnId, originalTimestamp: turn.completedAt,
        });
        if (appended.success === false) throw new Error('append_failed');
        if (appended.isDuplicate) result.skippedDuplicates++; else result.importedResponses++;
      }
    }
    // Report success only after the worker has closed its SQLite resources.
    if (service) { const owned = service; service = undefined; await owned.shutdown(); }
    saveStatus({ status: 'success', updatedAt: new Date().toISOString(), ...result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const reason = FAILURE_REASONS.includes(message as CodexHostIngestFailure) ? message as CodexHostIngestFailure : 'import_failed';
    saveStatus({ status: 'failed', updatedAt: new Date().toISOString(), reason });
    throw new Error(reason);
  } finally {
    if (service) {
      try { await service.shutdown(); } catch { /* preserve the classified failure */ }
    }
  }
}
