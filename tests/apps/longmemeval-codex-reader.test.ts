import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

interface ReaderRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runReader(input: unknown, env: Record<string, string> = {}): Promise<ReaderRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'scripts/longmemeval-codex-reader.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LONGMEMEVAL_CODEX_BIN: '',
        LONGMEMEVAL_CODEX_TIMEOUT_MS: '5000',
        ...env
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(`${typeof input === 'string' ? input : JSON.stringify(input)}\n`, 'utf8');
  });
}

function writeMockCodex(): { bin: string; promptPath: string; argsPath: string; envPath: string; cwdPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-reader-'));
  const bin = path.join(dir, 'codex-mock.mjs');
  const promptPath = path.join(dir, 'prompt.txt');
  const argsPath = path.join(dir, 'args.json');
  const envPath = path.join(dir, 'env.json');
  const cwdPath = path.join(dir, 'cwd.txt');
  writeFileSync(bin, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args, null, 2));
writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({
  SECRET_SHOULD_NOT_LEAK: process.env.SECRET_SHOULD_NOT_LEAK || null,
  PATH: process.env.PATH || null,
  HOME: process.env.HOME || null
}, null, 2));
writeFileSync(${JSON.stringify(cwdPath)}, process.cwd());
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0 || !args[outputIndex + 1]) {
  console.error('missing --output-last-message');
  process.exit(2);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(promptPath)}, prompt);
  writeFileSync(args[outputIndex + 1], 'jasmine tea\\n');
});
`, 'utf8');
  chmodSync(bin, 0o755);
  return { bin, promptPath, argsPath, envPath, cwdPath };
}

function normalizeMacosPrivateVarAlias(filePath: string): string {
  return filePath.replace(/^\/private(?=\/var\/)/, '');
}

describe('LongMemEval Codex CLI reader wrapper', () => {
  it('documents Codex subscription reader usage in help output', async () => {
    const result = await runReader('', { LONGMEMEVAL_CODEX_BIN: 'codex', LONGMEMEVAL_CODEX_HELP_ONLY: '1' });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('LongMemEval Codex CLI reader');
    expect(result.stdout).toContain('LONGMEMEVAL_CODEX_BIN');
    expect(result.stdout).toContain('Codex subscription auth');
  });

  it('passes retrieved context through stdin instead of argv and prints only the hypothesis', async () => {
    const mock = writeMockCodex();
    const result = await runReader({
      question_id: 'q_reader_1',
      question: 'Which tea did the user prefer?',
      category: 'single-session-user',
      contexts: [
        { id: 'mem_answer', rank: 1, content: 'User said: I prefer jasmine tea.' },
        { id: 'mem_noise', rank: 2, content: 'Unrelated calendar discussion.' }
      ]
    }, {
      LONGMEMEVAL_CODEX_BIN: mock.bin,
      SECRET_SHOULD_NOT_LEAK: 'ev'
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('jasmine tea\n');
    const args = JSON.parse(readFileSync(mock.argsPath, 'utf8')) as string[];
    expect(args).toEqual(expect.arrayContaining([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--cd',
      '--output-last-message',
      '-'
    ]));
    const joinedArgs = JSON.stringify(args);
    expect(joinedArgs).not.toContain('Which tea did the user prefer');
    expect(joinedArgs).not.toContain('jasmine tea');
    const cdIndex = args.indexOf('--cd');
    expect(cdIndex).toBeGreaterThanOrEqual(0);
    const childCwd = readFileSync(mock.cwdPath, 'utf8');
    expect(normalizeMacosPrivateVarAlias(childCwd)).toBe(normalizeMacosPrivateVarAlias(args[cdIndex + 1]));
    expect(normalizeMacosPrivateVarAlias(childCwd)).not.toBe(normalizeMacosPrivateVarAlias(process.cwd()));
    const env = JSON.parse(readFileSync(mock.envPath, 'utf8')) as Record<string, string | null>;
    expect(env.SECRET_SHOULD_NOT_LEAK).toBeNull();
    expect(env.PATH).toBeTruthy();
    expect(env.HOME).toBeTruthy();
    const prompt = readFileSync(mock.promptPath, 'utf8');
    expect(prompt).toContain('Question ID: q_reader_1');
    expect(prompt).toContain('Category: single-session-user');
    expect(prompt).toContain('Question: Which tea did the user prefer?');
    expect(prompt).toContain('[1] mem_answer');
    expect(prompt).toContain('I prefer jasmine tea');
    expect(prompt).toContain('Return only the final concise answer text');
  });

  it('fails closed with a bounded redacted diagnostic when codex exits non-zero', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-reader-fail-'));
    const bin = path.join(dir, 'codex-fail.mjs');
    writeFileSync(bin, `#!/usr/bin/env node
console.error('codex auth failed: token expired; secret=sv; api_key=ak');
process.exit(9);
`, 'utf8');
    chmodSync(bin, 0o755);

    const result = await runReader({
      question_id: 'q_reader_fail',
      question: 'Which tea did the user prefer?',
      contexts: [{ id: 'mem_answer', rank: 1, content: 'User said: I prefer jasmine tea.' }]
    }, {
      LONGMEMEVAL_CODEX_BIN: bin,
      LONGMEMEVAL_FAKE_SECRET: 'sv'
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Codex reader command failed with exit code 9');
    expect(result.stderr).toContain('token expired');
    expect(result.stderr).not.toContain('sv');
    expect(result.stderr).not.toContain('ak');
    expect(result.stderr).toContain('[REDACTED]');
  });
});
