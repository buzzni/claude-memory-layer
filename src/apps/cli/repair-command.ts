import type { ProjectScopeRepairOptions, ProjectScopeRepairResult } from '../../core/types.js';
import { hashProjectPath } from '../../core/registry/project-path.js';

export interface LegacyProjectScopeRepairCommandOptions {
  project?: string;
  projectHash?: string;
  apply?: boolean;
}

export function resolveLegacyProjectScopeRepairOptions(
  options: LegacyProjectScopeRepairCommandOptions
): ProjectScopeRepairOptions {
  if (options.project !== undefined && options.project.trim().length === 0) {
    throw new Error('legacy project-scope repair --project must not be empty');
  }
  if (options.projectHash !== undefined && options.projectHash.trim().length === 0) {
    throw new Error('legacy project-scope repair --project-hash must not be empty');
  }

  const projectPath = typeof options.project === 'string' && options.project.length > 0
    ? options.project
    : undefined;
  const projectHash = typeof options.projectHash === 'string' && options.projectHash.length > 0
    ? options.projectHash
    : undefined;

  if (!projectPath && !projectHash) {
    throw new Error('legacy project-scope repair requires --project or --project-hash');
  }

  if (projectHash && !/^[a-f0-9]{8}$/.test(projectHash)) {
    throw new Error('legacy project-scope repair --project-hash must be an 8-character lowercase hex hash');
  }

  if (projectPath && projectHash && hashProjectPath(projectPath) !== projectHash) {
    throw new Error('legacy project-scope repair --project and --project-hash refer to different project stores');
  }

  return {
    projectPath,
    projectHash,
    dryRun: options.apply !== true
  };
}

export function formatLegacyProjectScopeRepairResult(result: ProjectScopeRepairResult): string {
  const lines = [
    'Legacy project-scope repair',
    `Mode: ${result.dryRun ? 'dry-run' : 'apply'}`,
    `Project: ${result.projectHash}`,
    `Scanned: ${result.scanned}`,
    `Already scoped: ${result.alreadyScoped}`,
    `Repaired: ${result.repaired}`,
    `Quarantined: ${result.quarantined}`,
    `Skipped: ${result.skipped}`
  ];

  if (result.samples.length > 0) {
    lines.push('Samples:');
    for (const sample of result.samples) {
      lines.push(`- ${sample.eventId} ${sample.action} ${sample.reason}`);
    }
  }

  if (result.dryRun) {
    lines.push('Dry-run only. Re-run with --apply to mutate event metadata.');
  }

  return lines.join('\n');
}
