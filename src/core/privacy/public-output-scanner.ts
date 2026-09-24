import * as fs from 'node:fs';
import * as path from 'node:path';

export type PublicOutputFinding = {
  file: string;
  line: number;
  column: number;
  ruleId: string;
  severity: 'error';
  preview: string;
};

export type PublicOutputScanReport = {
  ok: boolean;
  scannedFiles: number;
  findings: PublicOutputFinding[];
};

export type PublicOutputScanOptions = {
  cwd?: string;
  maxFindings?: number;
  extensions?: string[];
};

export const DEFAULT_PUBLIC_OUTPUT_SCAN_PATHS = [
  'specs/agent-productivity-architecture',
  'benchmarks/longmemeval/reports'
];

const DEFAULT_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.json', '.html', '.htm', '.csv']);

const RULES: Array<{ id: string; pattern: RegExp }> = [
  { id: 'local-user-path', pattern: /\/(?:Users|home)\/[^\s"'`<>)\]]+/g },
  { id: 'windows-user-path', pattern: /\b[A-Za-z]:\\Users\\[^\s"'`<>)\]]+/g },
  { id: 'authorization-header', pattern: /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s"'`<>)\]]+/gi },
  { id: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/g },
  { id: 'openai-api-key', pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/g },
  { id: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: 'uri-credential', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi }
];

export function scanPublicOutputFiles(
  targets: string[],
  options: PublicOutputScanOptions = {}
): PublicOutputScanReport {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const extensions = new Set((options.extensions ?? Array.from(DEFAULT_EXTENSIONS)).map((ext) => ext.toLowerCase()));
  const maxFindings = options.maxFindings ?? 500;
  const files = collectPublicOutputFiles(targets, cwd, extensions);
  const findings: PublicOutputFinding[] = [];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        let match = rule.pattern.exec(line);
        while (match !== null) {
          findings.push({
            file: displayPath(filePath, cwd),
            line: lineIndex + 1,
            column: match.index + 1,
            ruleId: rule.id,
            severity: 'error',
            preview: sanitizePreview(line)
          });
          if (findings.length >= maxFindings) {
            return { ok: false, scannedFiles: files.length, findings };
          }
          match = rule.pattern.exec(line);
        }
      }
    }
  }

  return { ok: findings.length === 0, scannedFiles: files.length, findings };
}

export function formatPublicOutputScanMarkdown(report: PublicOutputScanReport): string {
  const lines = [
    `# Public Output Privacy Scan`,
    '',
    `Status: ${report.ok ? 'PASS' : 'FAIL'}`,
    `Scanned files: ${report.scannedFiles}`,
    `Findings: ${report.findings.length}`,
    ''
  ];

  if (!report.ok) {
    lines.push('| File | Line | Rule | Preview |', '| --- | ---: | --- | --- |');
    for (const finding of report.findings) {
      lines.push(`| ${escapeMarkdown(finding.file)} | ${finding.line} | ${finding.ruleId} | ${escapeMarkdown(finding.preview)} |`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function collectPublicOutputFiles(targets: string[], cwd: string, extensions: Set<string>): string[] {
  const selected = targets.length > 0 ? targets : DEFAULT_PUBLIC_OUTPUT_SCAN_PATHS;
  const files: string[] = [];

  for (const target of selected) {
    const targetPath = path.resolve(cwd, target);
    collectPath(targetPath, extensions, files);
  }

  return Array.from(new Set(files)).sort();
}

function collectPath(targetPath: string, extensions: Set<string>, files: string[]): void {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Scan target does not exist: ${path.basename(targetPath)}`);
  }

  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(targetPath)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      collectPath(path.join(targetPath, entry), extensions, files);
    }
    return;
  }

  if (stat.isFile() && extensions.has(path.extname(targetPath).toLowerCase())) {
    files.push(targetPath);
  }
}

function sanitizePreview(line: string): string {
  let preview = line;
  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    preview = preview.replace(pattern, '[REDACTED]');
  }
  const trimmed = preview.trim();
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

function displayPath(filePath: string, cwd: string): string {
  const relative = path.relative(cwd, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }
  return `[external]/${path.basename(filePath)}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
