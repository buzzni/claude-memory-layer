import * as fs from 'fs';
import * as path from 'path';
import type { CodexSessionValidationReport } from '../../services/codex-session-history-importer.js';

export type CodexValidationReportFormat = 'json' | 'markdown';

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : String(value);
}

export function formatCodexValidationReport(
  report: CodexSessionValidationReport,
  format: CodexValidationReportFormat = 'markdown'
): string {
  if (format === 'json') {
    return `${JSON.stringify(report, null, 2)}\n`;
  }

  const lines: string[] = [
    '# Codex dry-run validation report',
    '',
    `Generated: ${report.generatedAt}`,
    `Dry-run: ${report.dryRun ? 'yes' : 'no'}`,
    `Will mutate memory: ${report.willMutate ? 'yes' : 'no'}`,
    `Sessions directory: ${report.source.sessionsDir}`,
    `Project filter: ${report.source.projectPath ?? '(none)'}`,
    `Source paths: ${report.source.sourcePaths.join(', ')}`,
    `Session limit: ${report.limits.sessionLimit ?? '(none)'}`,
    `Max content chars: ${formatNumber(report.limits.maxContentChars)}`,
    '',
    '## Totals',
    '',
    `- Sessions scanned: ${formatNumber(report.totals.sessionsScanned)}`,
    `- Sessions matched: ${formatNumber(report.totals.sessionsMatched)}`,
    `- Files read: ${formatNumber(report.totals.filesRead)}`,
    `- Records read: ${formatNumber(report.totals.recordsRead)}`,
    `- Messages normalized: ${formatNumber(report.totals.messagesNormalized)}`,
    `- Turns normalized: ${formatNumber(report.totals.turnsNormalized)}`,
    `- User messages: ${formatNumber(report.totals.userMessages)}`,
    `- Assistant messages: ${formatNumber(report.totals.assistantMessages)}`,
    `- Malformed lines: ${formatNumber(report.totals.malformedLines)}`,
    `- Skipped/unsupported records: ${formatNumber(report.totals.skippedUnsupportedRecords)}`,
    `- Empty assistant messages: ${formatNumber(report.totals.emptyAssistantMessages)}`,
    `- Truncated messages: ${formatNumber(report.totals.truncatedMessages)}`,
    `- Missing project cwd: ${formatNumber(report.totals.missingProjectCwd)}`,
    `- Warnings: ${formatNumber(report.totals.warnings)}`,
    '',
    '## Top projects',
    '',
    '| Project | Hash | Sessions | Messages | Turns | User | Assistant | Malformed | Skipped/unsupported | Truncated | Empty assistant |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];

  if (report.topProjects.length === 0) {
    lines.push('| (none) | - | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |');
  } else {
    for (const project of report.topProjects) {
      lines.push([
        `| ${project.pathLabel}`,
        project.projectHash,
        formatNumber(project.sessions),
        formatNumber(project.messagesNormalized),
        formatNumber(project.turnsNormalized),
        formatNumber(project.userMessages),
        formatNumber(project.assistantMessages),
        formatNumber(project.malformedLines),
        formatNumber(project.skippedUnsupportedRecords),
        formatNumber(project.truncatedMessages),
        `${formatNumber(project.emptyAssistantMessages)} |`
      ].join(' | '));
    }
  }

  lines.push('', '## Warnings', '');
  if (report.warnings.length === 0) {
    lines.push('- None');
  } else {
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push('', '_Aggregate counts only; transcript content is not included._', '');
  return lines.join('\n');
}

export function writeCodexValidationReport(
  outputPath: string,
  report: CodexSessionValidationReport,
  format: CodexValidationReportFormat = 'markdown'
): void {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, formatCodexValidationReport(report, format), 'utf8');
}
