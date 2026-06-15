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

  it('adds category-specific synthesis instructions for multi-session questions', async () => {
    const mock = writeMockCodex();
    const result = await runReader({
      question_id: 'q_reader_multi',
      question: 'Which two cities did the user compare across trips?',
      category: 'multi-session',
      contexts: [
        { id: 'mem_trip_1', rank: 1, content: '[2024-01-01] session a\nuser: I visited Seoul for work.' },
        { id: 'mem_trip_2', rank: 2, content: '[2024-02-01] session b\nuser: I compared it with Tokyo later.' }
      ]
    }, {
      LONGMEMEVAL_CODEX_BIN: mock.bin
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const prompt = readFileSync(mock.promptPath, 'utf8');
    expect(prompt).toContain('For multi-session questions, inspect all retrieved contexts and synthesize every required evidence item before answering.');
    expect(prompt).toContain('Do not answer from only the top-ranked context when the question asks for comparisons, changes, counts, or multiple facts.');
  });

  it('adds a structured evidence ledger instruction for multi-session count questions', async () => {
    const mock = writeMockCodex();
    const result = await runReader({
      question_id: 'q_reader_multi_count',
      question: 'How many model kits have I worked on or bought?',
      category: 'multi-session',
      contexts: [
        { id: 'kit_b29', rank: 1, content: '[2023-05-20] user: I bought a 1/72 scale B-29 bomber model kit.' },
        { id: 'kit_spitfire', rank: 2, content: '[2023-05-30] user: I recently finished a Tamiya 1/48 scale Spitfire Mk.V.' },
        { id: 'noise', rank: 3, content: '[2023-05-22] user: Please show my Instagram graph.' },
        { id: 'kit_eagle', rank: 4, content: '[2023-05-27] user: I recently finished a simple Revell F-15 Eagle kit.' }
      ]
    }, {
      LONGMEMEVAL_CODEX_BIN: mock.bin
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const prompt = readFileSync(mock.promptPath, 'utf8');
    expect(prompt).toContain('Use an internal evidence ledger before answering: context rank/id, quoted supporting fact, normalized item or event, include/exclude reason.');
    expect(prompt).toContain('For "how many" or count questions, count distinct supported items or events, not the number of retrieved contexts.');
    expect(prompt).toContain('When evidence is spread across non-adjacent ranks, include later relevant contexts instead of stopping after early evidence.');
    expect(prompt).not.toContain('B-29 bomber model kit is the answer');
  });

  it('adds question-focused evidence notes for non-adjacent count evidence', async () => {
    const mock = writeMockCodex();
    const result = await runReader({
      question_id: 'q_reader_count_notes',
      question: 'How many model kits have I worked on or bought?',
      category: 'multi-session',
      contexts: [
        { id: 'kit_b29', rank: 1, content: '[2023-05-20] user: I bought a 1/72 scale B-29 bomber model kit.' },
        { id: 'noise_recipe', rank: 2, content: '[2023-05-21] user: I bought chicken for meal prep.' },
        { id: 'noise_graph', rank: 3, content: '[2023-05-22] user: Please show my Instagram graph.' },
        { id: 'kit_spitfire', rank: 8, content: '[2023-05-30] user: I recently finished a Tamiya 1/48 scale Spitfire Mk.V model kit.' }
      ]
    }, {
      LONGMEMEVAL_CODEX_BIN: mock.bin
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const prompt = readFileSync(mock.promptPath, 'utf8');
    expect(prompt).toContain('Question-focused evidence notes:');
    expect(prompt).toContain('- [1] kit_b29:');
    expect(prompt).toContain('- [8] kit_spitfire:');
    expect(prompt).not.toContain('- [2] noise_recipe:');
    expect(prompt).not.toContain('- [3] noise_graph:');
    expect(prompt.indexOf('Question-focused evidence notes:')).toBeLessThan(prompt.indexOf('Retrieved Contexts:'));
  });

  it('adds question-focused evidence notes for single-session preference context', async () => {
    const mock = writeMockCodex();
    const result = await runReader({
      question_id: 'q_reader_preference_notes',
      question: 'Can you suggest accessories that complement my current photography setup?',
      category: 'single-session-preference',
      contexts: [
        { id: 'noise_calendar', rank: 1, content: '[2026-01-01] user: I need to update my calendar reminders.' },
        { id: 'photo_setup', rank: 5, content: '[2026-01-02] user: My current photography setup is a Sony A7C camera with a compact flash.' }
      ]
    }, {
      LONGMEMEVAL_CODEX_BIN: mock.bin
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const prompt = readFileSync(mock.promptPath, 'utf8');
    expect(prompt).toContain('For preference questions, prefer retrieved first-person preference, setup, interest, or personal-context statements over generic advice.');
    expect(prompt).toContain('Question-focused evidence notes:');
    expect(prompt).toContain('- [5] photo_setup:');
    expect(prompt).not.toContain('- [1] noise_calendar:');
    expect(prompt.indexOf('Question-focused evidence notes:')).toBeLessThan(prompt.indexOf('Retrieved Contexts:'));
    expect(prompt).not.toContain('Sony-compatible photography accessories is the answer');
  });

  it('passes temporal target-date hints into the reader prompt without exposing answers', async () => {
    const mock = writeMockCodex();
    const result = await runReader({
      question_id: 'q_reader_temporal',
      question: 'What did I do 12 days ago at the museum exhibit?',
      category: 'temporal-reasoning',
      temporalDateBoost: {
        referenceDate: '2023-02-01',
        targetDate: '2023-01-20',
        toleranceDays: 1,
        entityTerms: ['museum', 'exhibit']
      },
      contexts: [
        { id: 'mem_same_date_noise', rank: 1, content: '[2023-01-20] session noise\nuser: I bought groceries.' },
        { id: 'mem_answer', rank: 2, content: '[2023-01-20] session answer\nuser: I attended the museum exhibit.' }
      ]
    }, {
      LONGMEMEVAL_CODEX_BIN: mock.bin
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const prompt = readFileSync(mock.promptPath, 'utf8');
    expect(prompt).toContain('For temporal-reasoning questions, use the dates in context headers and prefer evidence matching the temporal target.');
    expect(prompt).toContain('Temporal target date: 2023-01-20; reference date: 2023-02-01; tolerance: ±1 day.');
    expect(prompt).toContain('Temporal entity terms: museum, exhibit.');
    expect(prompt).not.toContain('attended the museum exhibit is the answer');
  });

  it('adds structured temporal ledger rows with include and exclude decisions', async () => {
    const mock = writeMockCodex();
    const result = await runReader({
      question_id: 'q_reader_temporal_ledger',
      question: 'How many museum exhibit activities did I do 12 days ago?',
      category: 'multi-session temporal-reasoning',
      temporalDateBoost: {
        referenceDate: '2023-02-01',
        targetDate: '2023-01-20',
        toleranceDays: 1,
        entityTerms: ['museum', 'exhibit']
      },
      contexts: [
        { id: 'target_tour', rank: 1, content: '[2023-01-20] session a\nuser: I attended the museum exhibit opening tour.' },
        { id: 'same_date_noise', rank: 2, content: '[2023-01-20] session b\nuser: I bought groceries after work.' },
        { id: 'off_date_museum', rank: 3, content: '[2023-01-27] session c\nuser: I visited the museum cafe.' },
        { id: 'target_workshop', rank: 7, content: '[2023-01-21] session d\nuser: I joined a museum exhibit sketching workshop.' }
      ]
    }, {
      LONGMEMEVAL_CODEX_BIN: mock.bin
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const prompt = readFileSync(mock.promptPath, 'utf8');
    expect(prompt).toContain('Question-focused evidence notes:');
    expect(prompt).toContain('Use the question-focused evidence notes as a structured ledger: include rows are candidate support; exclude rows are distractors to avoid.');
    expect(prompt).toContain('- [1] target_tour: date=2023-01-20 | temporal=target-date | entities=museum, exhibit | decision=include');
    expect(prompt).toContain('- [2] same_date_noise: date=2023-01-20 | temporal=target-date | entities=none | decision=exclude(entity-mismatch)');
    expect(prompt).toContain('- [3] off_date_museum: date=2023-01-27 | temporal=outside-window | entities=museum | decision=exclude(outside-temporal-window)');
    expect(prompt).toContain('- [7] target_workshop: date=2023-01-21 | temporal=target-date | entities=museum, exhibit | decision=include');
    expect(prompt.indexOf('Question-focused evidence notes:')).toBeLessThan(prompt.indexOf('Retrieved Contexts:'));
    expect(prompt).not.toContain('opening tour is the answer');
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
