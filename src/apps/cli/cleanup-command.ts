import { cleanupEphemeralState, type EphemeralCleanupClass } from '../../core/operations/ephemeral-cleanup.js';
import {
  previewStoreCleanup,
  type StoreCleanupClassification
} from '../../core/operations/store-cleanup-preview.js';

export interface CleanupEphemeralCommandOptions {
  apply?: boolean;
  class?: string;
  json?: boolean;
}

export interface CleanupStoresCommandOptions {
  classification?: string;
  apply?: boolean;
}

export function runEphemeralCleanupCommand(options: CleanupEphemeralCommandOptions) {
  const targetClass = normalizeClass(options.class);
  return cleanupEphemeralState({ targetClass, apply: options.apply === true });
}

export function runStoreCleanupPreviewCommand(options: CleanupStoresCommandOptions) {
  if (options.apply) throw new Error('cleanup stores is dry-run-only in this release');
  const classification = normalizeStoreClassification(options.classification);
  return previewStoreCleanup({ classification });
}

export function formatEphemeralCleanupReport(
  report: ReturnType<typeof cleanupEphemeralState>,
  json = false
): string {
  if (json) return JSON.stringify(report, null, 2);
  return [
    `Ephemeral cleanup (${report.mode})`,
    `Scanned: ${report.scanned}`,
    `Candidates: ${report.candidates} (${report.candidateBytes} bytes)`,
    `Protected: ${report.protected}`,
    `Malformed: ${report.malformed}`,
    `Removed: ${report.removed} (${report.reclaimedBytes} bytes)`,
    `Failures: ${report.failures}`,
    `Recovery: ${report.removed > 0 ? 'not recoverable' : 'not applicable'}`
  ].join('\n');
}

export function formatStoreCleanupPreviewReport(
  report: ReturnType<typeof previewStoreCleanup>,
  json = false
): string {
  if (json) return JSON.stringify(report, null, 2);
  return [
    `Store cleanup preview (${report.classification})`,
    `Scanned: ${report.scanned}`,
    `Candidates: ${report.candidates} (${report.candidateBytes} bytes)`,
    `Protected: ${report.protected}`,
    `Action ceiling: ${report.action} (no stores removed)`,
    'Recovery: not applicable'
  ].join('\n');
}

function normalizeStoreClassification(value: string | undefined): StoreCleanupClassification {
  const normalized = value?.trim();
  if (normalized !== 'temp' && normalized !== 'unattributed') {
    throw new Error('--classification must be temp or unattributed');
  }
  return normalized;
}

function normalizeClass(value: string | undefined): EphemeralCleanupClass {
  const normalized = value?.trim() || 'all';
  if (normalized !== 'runtime' && normalized !== 'adherence' && normalized !== 'all') {
    throw new Error('--class must be runtime, adherence, or all');
  }
  return normalized;
}
