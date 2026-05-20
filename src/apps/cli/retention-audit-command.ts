import { hashProjectPath } from '../../core/registry/project-path.js';
import type { RetentionAuditReport } from '../../core/operations/retention-audit.js';

const DEFAULT_RETENTION_AUDIT_LIMIT = 100;

export interface RetentionAuditCommandOptions {
  project?: string;
  projectHash?: string;
  dryRun?: boolean;
  limit?: string | number;
  json?: boolean;
}

export interface ResolvedRetentionAuditCommandOptions {
  projectPath?: string;
  projectHash?: string;
  dryRun: true;
  limit: number;
  json: boolean;
}

export function resolveRetentionAuditOptions(
  options: RetentionAuditCommandOptions
): ResolvedRetentionAuditCommandOptions {
  if (options.project !== undefined && options.project.trim().length === 0) {
    throw new Error('retention audit --project must not be empty');
  }
  if (options.projectHash !== undefined && options.projectHash.trim().length === 0) {
    throw new Error('retention audit --project-hash must not be empty');
  }
  if (options.dryRun === false) {
    throw new Error('retention audit is dry-run only and must not mutate memory data');
  }

  const projectPath = typeof options.project === 'string' && options.project.length > 0
    ? options.project
    : undefined;
  const projectHash = typeof options.projectHash === 'string' && options.projectHash.length > 0
    ? options.projectHash
    : undefined;

  if (!projectPath && !projectHash) {
    throw new Error('retention audit requires --project or --project-hash');
  }
  if (projectHash && !/^[a-f0-9]{8}$/.test(projectHash)) {
    throw new Error('retention audit --project-hash must be an 8-character lowercase hex hash');
  }
  if (projectPath && projectHash && hashProjectPath(projectPath) !== projectHash) {
    throw new Error('retention audit --project and --project-hash refer to different project stores');
  }

  return {
    projectPath,
    projectHash,
    dryRun: true,
    limit: parsePositiveIntegerOption(options.limit, DEFAULT_RETENTION_AUDIT_LIMIT, 'retention audit --limit'),
    json: options.json === true
  };
}

export function formatRetentionAuditReport(
  report: RetentionAuditReport,
  options: { json?: boolean } = {}
): string {
  if (options.json) {
    return JSON.stringify(report, null, 2);
  }

  const lines: string[] = [
    'Retention audit (dry-run only)',
    `project_hash: ${report.projectHash}`,
    `policy_version: ${report.policyVersion}`,
    `scanned: ${report.scanned}`,
    `limit: ${report.limit}`,
    `would_change: ${report.wouldChange}`,
    `decisions: keep=${report.decisions.keep} review=${report.decisions.review} downgrade=${report.decisions.downgrade} quarantine=${report.decisions.quarantine} tombstone_candidate=${report.decisions.tombstone_candidate}`
  ];

  if (report.samples.length > 0) {
    lines.push('samples:');
    for (const sample of report.samples) {
      lines.push(`- ${sample.targetType}:${sample.targetId} decision=${sample.decision} score=${sample.lifecycleScore} action=${sample.dryRunAction}`);
      lines.push(`  reasons=${sample.reasonCodes.join(',') || 'none'}`);
      if (sample.redactedPreview.length > 0) {
        lines.push(`  preview=${sample.redactedPreview}`);
      }
    }
  } else {
    lines.push('samples: none');
  }

  return lines.join('\n');
}

function parsePositiveIntegerOption(value: string | number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0 || value > 10000) {
      throw new Error(`${label} must be a positive integer <= 10000`);
    }
    return value;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a positive integer <= 10000`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 10000) {
    throw new Error(`${label} must be a positive integer <= 10000`);
  }
  return parsed;
}
