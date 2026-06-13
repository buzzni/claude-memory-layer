import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

interface CliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runJudge(args: string[], env: Record<string, string> = {}): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'scripts/longmemeval-codex-judge.ts', ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LONGMEMEVAL_CODEX_BIN: '',
        LONGMEMEVAL_CODEX_TIMEOUT_MS: '5000',
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function writeMockCodex(mode: 'normal' | 'ambiguous' | 'fail' = 'normal'): { bin: string; promptPath: string; argsPath: string; envPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-judge-'));
  const bin = path.join(dir, 'codex-mock.mjs');
  const promptPath = path.join(dir, 'prompts.txt');
  const argsPath = path.join(dir, 'args.jsonl');
  const envPath = path.join(dir, 'env.jsonl');
  const body = mode === 'fail'
    ? `console.error('judge failed: secret=sv; token=ak'); process.exit(7);`
    : `let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(promptPath)}, prompt + '\\n---PROMPT---\\n');
  const answer = ${JSON.stringify(mode)} === 'ambiguous'
    ? 'no, not yes'
    : (prompt.includes('Model Response: jasmine tea') ? 'yes' : 'no');
  writeFileSync(args[outputIndex + 1], answer + '\\n');
});`;
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args) + '\\n');
appendFileSync(${JSON.stringify(envPath)}, JSON.stringify({ SECRET_SHOULD_NOT_LEAK: process.env.SECRET_SHOULD_NOT_LEAK || null, PATH: process.env.PATH || null, HOME: process.env.HOME || null }) + '\\n');
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0 || !args[outputIndex + 1]) {
  console.error('missing --output-last-message');
  process.exit(2);
}
${body}
`, 'utf8');
  chmodSync(bin, 0o755);
  return { bin, promptPath, argsPath, envPath };
}

function writeFixtureFiles(overrides: { hypRows?: unknown[]; refRows?: unknown[] } = {}): { hyp: string; ref: string; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-judge-fixture-'));
  const hyp = path.join(dir, 'hypotheses.jsonl');
  const ref = path.join(dir, 'refs.json');
  const out = path.join(dir, 'results.jsonl');
  const hypRows = overrides.hypRows ?? [
    { question_id: 'q1', hypothesis: 'jasmine tea' },
    { question_id: 'q2', hypothesis: 'black coffee' }
  ];
  const refRows = overrides.refRows ?? [
    {
      question_id: 'q1',
      question_type: 'single-session-user',
      question: 'Which tea did the user prefer?',
      answer: 'jasmine tea'
    },
    {
      question_id: 'q2',
      question_type: 'single-session-user',
      question: 'Which tea did the user prefer?',
      answer: 'jasmine tea'
    }
  ];
  writeFileSync(hyp, hypRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  writeFileSync(ref, JSON.stringify(refRows, null, 2), 'utf8');
  return { hyp, ref, out };
}

describe('LongMemEval Codex-compatible judge wrapper', () => {
  it('documents that Codex-compatible scoring is distinct from upstream official QA', async () => {
    const result = await runJudge(['--help']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('LongMemEval Codex-compatible judge');
    expect(result.stdout).toContain('not the unmodified upstream official evaluator');
    expect(result.stdout).toContain('LONGMEMEVAL_CODEX_BIN');
  });

  it('judges hypotheses with the upstream answer-check prompt via stdin and writes JSONL results', async () => {
    const mock = writeMockCodex();
    const files = writeFixtureFiles();
    const result = await runJudge(['--hyp', files.hyp, '--ref', files.ref, '--out', files.out], {
      LONGMEMEVAL_CODEX_BIN: mock.bin,
      SECRET_SHOULD_NOT_LEAK: 'ev'
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Accuracy: 0.5');
    expect(result.stdout).toContain('single-session-user: 0.5 (2)');
    expect(result.stdout).toContain(`Saved to ${files.out}`);
    const resultRows = readFileSync(files.out, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(resultRows).toHaveLength(2);
    expect(resultRows[0].autoeval_label).toEqual({ model: 'codex-cli', label: true });
    expect(resultRows[1].autoeval_label).toEqual({ model: 'codex-cli', label: false });
    const argsRows = readFileSync(mock.argsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(argsRows[0]).toEqual(expect.arrayContaining(['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--cd', '--output-last-message', '-']));
    expect(JSON.stringify(argsRows)).not.toContain('jasmine tea');
    const envRows = readFileSync(mock.envPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, string | null>);
    expect(envRows[0].SECRET_SHOULD_NOT_LEAK).toBeNull();
    expect(envRows[0].PATH).toBeTruthy();
    expect(envRows[0].HOME).toBeTruthy();
    const prompt = readFileSync(mock.promptPath, 'utf8');
    expect(prompt).toContain('Correct Answer: jasmine tea');
    expect(prompt).toContain('Model Response: jasmine tea');
    expect(prompt).toContain('Answer yes or no only.');
  });

  it('treats ambiguous judge output as incorrect instead of substring-matching yes', async () => {
    const mock = writeMockCodex('ambiguous');
    const files = writeFixtureFiles({
      hypRows: [{ question_id: 'q1', hypothesis: 'jasmine tea' }],
      refRows: [{ question_id: 'q1', question_type: 'single-session-user', question: 'Which tea?', answer: 'jasmine tea' }]
    });
    const result = await runJudge(['--hyp', files.hyp, '--ref', files.ref, '--out', files.out], {
      LONGMEMEVAL_CODEX_BIN: mock.bin
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Accuracy: 0');
    const [row] = readFileSync(files.out, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(row.autoeval_label).toEqual({ model: 'codex-cli', label: false });
  });

  it('fails closed on hypothesis ids missing from references', async () => {
    const files = writeFixtureFiles({
      hypRows: [{ question_id: 'missing', hypothesis: 'jasmine tea' }],
      refRows: [{ question_id: 'q1', question_type: 'single-session-user', question: 'Which tea?', answer: 'jasmine tea' }]
    });
    const result = await runJudge(['--hyp', files.hyp, '--ref', files.ref, '--out', files.out], {
      LONGMEMEVAL_CODEX_BIN: writeMockCodex().bin
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('missing is not in reference data');
  });

  it('fails closed on duplicate hypothesis ids before scoring', async () => {
    const files = writeFixtureFiles({
      hypRows: [
        { question_id: 'q1', hypothesis: 'jasmine tea' },
        { question_id: 'q1', hypothesis: 'jasmine tea again' }
      ],
      refRows: [{ question_id: 'q1', question_type: 'single-session-user', question: 'Which tea?', answer: 'jasmine tea' }]
    });
    const result = await runJudge(['--hyp', files.hyp, '--ref', files.ref, '--out', files.out], {
      LONGMEMEVAL_CODEX_BIN: writeMockCodex().bin
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Duplicate hypothesis question_id: q1');
  });

  it('redacts codex stderr before emitting failure diagnostics', async () => {
    const mock = writeMockCodex('fail');
    const files = writeFixtureFiles({
      hypRows: [{ question_id: 'q1', hypothesis: 'jasmine tea' }],
      refRows: [{ question_id: 'q1', question_type: 'single-session-user', question: 'Which tea?', answer: 'jasmine tea' }]
    });
    const result = await runJudge(['--hyp', files.hyp, '--ref', files.ref, '--out', files.out], {
      LONGMEMEVAL_CODEX_BIN: mock.bin,
      LONGMEMEVAL_FAKE_SECRET: 'sv'
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Codex judge command failed with exit code 7');
    expect(result.stderr).not.toContain('sv');
    expect(result.stderr).not.toContain('ak');
    expect(result.stderr).toContain('[REDACTED]');
  });
});
