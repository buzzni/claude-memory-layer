import * as fs from 'fs';
import * as path from 'path';
import type { HermesSessionValidationReport } from '../../services/hermes-session-history-importer.js';

export type HermesValidationReportFormat = 'json' | 'markdown';

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : String(value);
}

export function formatHermesValidationReport(
  report: HermesSessionValidationReport,
  format: HermesValidationReportFormat = 'markdown'
): string {
  if (format === 'json') {
    return `${JSON.stringify(report, null, 2)}\n`;
  }

  const lines: string[] = [
    '# Hermes dry-run validation report',
    '',
    `Generated: ${report.generatedAt}`,
    `Dry-run: ${report.dryRun ? 'yes' : 'no'}`,
    `Will mutate memory: ${report.willMutate ? 'yes' : 'no'}`,
    `State DB: ${report.source.stateDbPath}`,
    `Project filter: ${report.source.projectPath ?? '(none)'}`,
    `Source paths: ${report.source.sourcePaths.join(', ')}`,
    `Session limit: ${report.limits.sessionLimit ?? '(none)'}`,
    `Max content chars: ${formatNumber(report.limits.maxContentChars)}`,
    '',
    '## Totals',
    '',
    `- Sessions scanned: ${formatNumber(report.totals.sessionsScanned)}`,
    `- Sessions matched: ${formatNumber(report.totals.sessionsMatched)}`,
    `- Messages read: ${formatNumber(report.totals.messagesRead)}`,
    `- Messages normalized: ${formatNumber(report.totals.messagesNormalized)}`,
    `- Turns normalized: ${formatNumber(report.totals.turnsNormalized)}`,
    `- User messages: ${formatNumber(report.totals.userMessages)}`,
    `- Assistant messages: ${formatNumber(report.totals.assistantMessages)}`,
    `- Skipped/unsupported messages: ${formatNumber(report.totals.skippedUnsupportedMessages)}`,
    `- Empty assistant messages: ${formatNumber(report.totals.emptyAssistantMessages)}`,
    `- Truncated messages: ${formatNumber(report.totals.truncatedMessages)}`,
    `- Missing project context: ${formatNumber(report.totals.missingProjectContext)}`,
    `- Warnings: ${formatNumber(report.totals.warnings)}`,
    '',
    '## Top sources',
    '',
    '| Source | Sessions | Messages | Turns | User | Assistant | Skipped/unsupported | Truncated | Empty assistant |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];

  if (report.topSources.length === 0) {
    lines.push('| (none) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |');
  } else {
    for (const source of report.topSources) {
      lines.push([
        `| ${source.source}`,
        formatNumber(source.sessions),
        formatNumber(source.messagesNormalized),
        formatNumber(source.turnsNormalized),
        formatNumber(source.userMessages),
        formatNumber(source.assistantMessages),
        formatNumber(source.skippedUnsupportedMessages),
        formatNumber(source.truncatedMessages),
        `${formatNumber(source.emptyAssistantMessages)} |`
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

export function writeHermesValidationReport(
  outputPath: string,
  report: HermesSessionValidationReport,
  format: HermesValidationReportFormat = 'markdown'
): void {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, formatHermesValidationReport(report, format), 'utf8');
}
