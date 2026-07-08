import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function runScanCli(args: string[]) {
  return spawnSync('npx', ['tsx', 'scripts/scan-public-output-privacy.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
}

function runScanNpmScript(args: string[]) {
  return spawnSync('npm', ['run', 'check:public-output-privacy', '--', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
}

function writeTempFile(name: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-public-output-scan-'));
  const filePath = path.join(dir, name);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('public output privacy scanner CLI', () => {
  it('fails closed on local paths and credential-looking strings without echoing raw findings', () => {
    const localPath = ['', 'Users', 'private-person', 'workspace', 'artifact.md'].join('/');
    const fakeToken = ['sk', 'test', 'fixture', 'not', 'secret', '12345678901234567890'].join('-');
    const bearerToken = ['bearer', 'fixture', 'not', 'secret', '12345678901234567890'].join('-');
    const authLine = ['Authorization:', 'Bearer', bearerToken].join(' ');
    const filePath = writeTempFile('report.md', [
      '# Public report',
      `Generated from ${localPath}`,
      authLine,
      `OpenAI key: ${fakeToken}`,
      ''
    ].join('\n'));

    const result = runScanCli(['--json', filePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(localPath);
    expect(result.stdout).not.toContain(fakeToken);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      findings: Array<{ file: string; line: number; ruleId: string; preview: string }>;
    };
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining(['local-user-path', 'authorization-header', 'bearer-token'])
    );
    expect(report.findings.every((finding) => !path.isAbsolute(finding.file))).toBe(true);
    expect(report.findings.every((finding) => finding.preview.includes('[REDACTED]'))).toBe(true);
  });

  it('passes clean markdown and exposes a reusable npm gate', () => {
    const filePath = writeTempFile('clean.md', [
      '# Clean report',
      'This public output contains aggregate metrics only.',
      ''
    ].join('\n'));

    const result = runScanNpmScript(['--json', filePath]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['check:public-output-privacy']).toContain('scripts/scan-public-output-privacy.ts');
    expect(existsSync(path.join(process.cwd(), 'scripts/scan-public-output-privacy.ts'))).toBe(true);
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))) as { ok: boolean; findings: unknown[] };
    expect(report).toMatchObject({ ok: true, findings: [] });
  });
});
