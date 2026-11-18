import { FORCE_REIMPORT_LIMIT_REFUSAL, forceSkipReason, type ImportResult } from '../../services/session-history-importer.js';

/**
 * The exit code an import command ends with: a force reimport the message
 * limit could cut short was asked for and skipped, so the command fails;
 * other skips stay warnings.
 */
export function importExitCode(result: Pick<ImportResult, 'errors'>): 0 | 1 {
  return result.errors.some((error) => forceSkipReason(error) === FORCE_REIMPORT_LIMIT_REFUSAL) ? 1 : 0;
}
