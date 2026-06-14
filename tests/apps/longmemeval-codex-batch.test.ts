import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

function runBatch(args: string[], env: Record<string, string> = {}) {
  return spawnSync('npx', ['tsx', 'scripts/longmemeval-codex-batch.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LONGMEMEVAL_CODEX_TIMEOUT_MS: '5000',
      ...env
    },
    encoding: 'utf8'
  });
}

function writeTwoQuestionFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-fixture-'));
  const fixturePath = path.join(dir, 'longmemeval-mini.json');
  writeFileSync(fixturePath, `${JSON.stringify([
    {
      question_id: 'q_batch_1',
      question_type: 'single-session-user',
      question: 'Which tea did the user prefer?',
      answer: 'jasmine tea',
      haystack_session_ids: ['s_noise_1', 's_answer_1'],
      haystack_dates: ['2026-01-01', '2026-01-02'],
      haystack_sessions: [
        [{ role: 'user', content: 'I talked about a calendar.' }],
        [{ role: 'user', content: 'I prefer jasmine tea.', has_answer: true }]
      ],
      answer_session_ids: ['s_answer_1']
    },
    {
      question_id: 'q_batch_2',
      question_type: 'single-session-user',
      question: 'Which coffee did the user prefer?',
      answer: 'iced coffee',
      haystack_session_ids: ['s_noise_2', 's_answer_2'],
      haystack_dates: ['2026-01-03', '2026-01-04'],
      haystack_sessions: [
        [{ role: 'user', content: 'I talked about a calendar again.' }],
        [{ role: 'user', content: 'I prefer iced coffee.', has_answer: true }]
      ],
      answer_session_ids: ['s_answer_2']
    }
  ], null, 2)}\n`, 'utf8');
  return fixturePath;
}

function writeReaderCommand(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-reader-'));
  const readerPath = path.join(dir, 'reader.mjs');
  writeFileSync(readerPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(raw);
  if (process.env.READER_CALLS_PATH) appendFileSync(process.env.READER_CALLS_PATH, payload.question_id + '\\n');
  if (process.env.FAIL_READER_ON === payload.question_id) {
    process.stderr.write('reader failed for ' + payload.question_id + '\\n');
    process.exit(7);
  }
  const context = payload.contexts.map(item => item.content).join('\\n');
  if (context.includes('jasmine tea')) process.stdout.write('jasmine tea');
  else if (context.includes('iced coffee')) process.stdout.write('iced coffee');
  else process.stdout.write('I do not know');
});
`, 'utf8');
  chmodSync(readerPath, 0o755);
  return readerPath;
}

function writeTemporalQuestionFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-temporal-fixture-'));
  const fixturePath = path.join(dir, 'longmemeval-temporal-mini.json');
  writeFileSync(fixturePath, `${JSON.stringify([
    {
      question_id: 'q_batch_temporal',
      question_type: 'temporal-reasoning',
      question: 'What did I do 12 days ago at the museum exhibit?',
      question_date: '2023/02/01 (Wed) 10:20',
      answer: 'attended the museum exhibit',
      haystack_session_ids: ['s_temporal_answer'],
      haystack_dates: ['2023-01-20'],
      haystack_sessions: [
        [{ role: 'user', content: 'I attended the museum exhibit today.', has_answer: true }]
      ],
      answer_session_ids: ['s_temporal_answer']
    }
  ], null, 2)}\n`, 'utf8');
  return fixturePath;
}

function writePayloadRecordingReaderCommand(): { bin: string; payloadPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-payload-reader-'));
  const bin = path.join(dir, 'payload-reader.mjs');
  const payloadPath = path.join(dir, 'payload.json');
  writeFileSync(bin, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(raw);
  writeFileSync(${JSON.stringify(payloadPath)}, JSON.stringify(payload, null, 2));
  const context = payload.contexts.map(item => item.content).join('\\n');
  if (context.includes('museum exhibit')) process.stdout.write('attended the museum exhibit');
  else process.stdout.write('I do not know');
});
`, 'utf8');
  chmodSync(bin, 0o755);
  return { bin, payloadPath };
}

function writeFlagCheckingReaderCommand(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-reader-arg-'));
  const readerPath = path.join(dir, 'reader-arg.mjs');
  writeFileSync(readerPath, `#!/usr/bin/env node
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  if (!process.argv.slice(2).includes('--reader-flag')) {
    process.stderr.write('missing reader flag arg\\n');
    process.exit(9);
  }
  const payload = JSON.parse(raw);
  const context = payload.contexts.map(item => item.content).join('\\n');
  if (context.includes('jasmine tea')) process.stdout.write('jasmine tea');
  else process.stdout.write('I do not know');
});
`, 'utf8');
  chmodSync(readerPath, 0o755);
  return readerPath;
}

function writeFlagCheckingJudgeCommand(): { bin: string; callsPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-judge-arg-'));
  const bin = path.join(dir, 'judge-arg.mjs');
  const callsPath = path.join(dir, 'codex-calls.txt');
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const hypIndex = args.indexOf('--hyp');
const outIndex = args.indexOf('--out');
const flagIndex = args.indexOf('--judge-flag');
if (flagIndex < 0 || hypIndex < 0 || flagIndex > hypIndex || !args[hypIndex + 1] || outIndex < 0 || !args[outIndex + 1]) {
  console.error('missing ordered judge flag or --hyp/--out');
  process.exit(2);
}
const row = JSON.parse(readFileSync(args[hypIndex + 1], 'utf8').trim().split('\\n')[0]);
appendFileSync(${JSON.stringify(callsPath)}, row.question_id + '\\n');
writeFileSync(args[outIndex + 1], JSON.stringify({ ...row, autoeval_label: { model: 'codex-cli', label: true } }) + '\\n');
`, 'utf8');
  chmodSync(bin, 0o755);
  return { bin, callsPath };
}

function writeJudgeCommand(): { bin: string; callsPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-judge-'));
  const bin = path.join(dir, 'judge.mjs');
  const callsPath = path.join(dir, 'codex-calls.txt');
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const hypIndex = args.indexOf('--hyp');
const outIndex = args.indexOf('--out');
if (hypIndex < 0 || !args[hypIndex + 1] || outIndex < 0 || !args[outIndex + 1]) {
  console.error('missing --hyp/--out');
  process.exit(2);
}
const row = JSON.parse(readFileSync(args[hypIndex + 1], 'utf8').trim().split('\\n')[0]);
appendFileSync(${JSON.stringify(callsPath)}, row.question_id + '\\n');
if (process.env.FAIL_JUDGE_ON === row.question_id) {
  console.error('judge failed for ' + row.question_id + '; token=ak');
  process.exit(8);
}
writeFileSync(args[outIndex + 1], JSON.stringify({ ...row, autoeval_label: { model: 'codex-cli', label: true } }) + '\\n');
`, 'utf8');
  chmodSync(bin, 0o755);
  return { bin, callsPath };
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  const raw = readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('LongMemEval Codex full batch runner', () => {
  it('documents Codex-compatible full batch resume and checkpoint options', () => {
    const result = runBatch(['--help']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('LongMemEval Codex-compatible full batch runner');
    expect(result.stdout).toContain('--resume');
    expect(result.stdout).toContain('--checkpoint PATH');
    expect(result.stdout).toContain('--skip-judge');
    expect(result.stdout).toContain('checkpoint.json');
  });

  it('passes flag-shaped reader and judge args to custom wrappers', () => {
    const input = writeTwoQuestionFixture();
    const reader = writeFlagCheckingReaderCommand();
    const judge = writeFlagCheckingJudgeCommand();
    const outDir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-arg-out-'));

    const result = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--reader-command', reader,
      '--reader-arg', '--reader-flag',
      '--judge-command', judge.bin,
      '--judge-arg', '--judge-flag',
      '--limit', '1',
      '--top-k', '1'
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Codex-compatible accuracy: 1');
    expect(readFileSync(judge.callsPath, 'utf8').trim()).toBe('q_batch_1');
  });

  it('forwards temporal date boost metadata to the reader payload', () => {
    const input = writeTemporalQuestionFixture();
    const reader = writePayloadRecordingReaderCommand();
    const outDir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-temporal-out-'));

    const result = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--reader-command', reader.bin,
      '--skip-judge',
      '--limit', '1',
      '--top-k', '1',
      '--temporal-date-boost'
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(readFileSync(reader.payloadPath, 'utf8')) as Record<string, any>;
    expect(payload.question_id).toBe('q_batch_temporal');
    expect(payload.category).toBe('temporal-reasoning');
    expect(payload.temporalDateBoost).toMatchObject({
      referenceDate: '2023-02-01',
      targetDate: '2023-01-20',
      toleranceDays: 1,
      entityTerms: ['museum', 'exhibit']
    });
    expect(JSON.stringify(payload.temporalDateBoost)).not.toContain('attended the museum exhibit');
  });

  it('rejects unsafe output path and resume/force combinations before running', () => {
    const input = writeTwoQuestionFixture();
    const outDir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-path-out-'));

    const resumeAndForce = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--skip-judge',
      '--resume',
      '--force'
    ]);

    expect(resumeAndForce.status).toBe(1);
    expect(resumeAndForce.stderr).toContain('Cannot combine --resume and --force');

    const inputCollision = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--skip-judge',
      '--fixture-out', input
    ]);

    expect(inputCollision.status).toBe(1);
    expect(inputCollision.stderr).toContain('Refusing to use input file as fixture output');

    const outputCollision = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--skip-judge',
      '--fixture-out', path.join(outDir, 'same.json'),
      '--retrieval-report-out', path.join(outDir, 'same.json')
    ]);

    expect(outputCollision.status).toBe(1);
    expect(outputCollision.stderr).toContain('Managed output path collision');
  });

  it('requires an existing checkpoint before resuming output artifacts', () => {
    const input = writeTwoQuestionFixture();
    const reader = writeReaderCommand();
    const outDir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-missing-checkpoint-out-'));

    const first = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--reader-command', reader,
      '--skip-judge',
      '--limit', '1',
      '--top-k', '1'
    ]);

    expect(first.status).toBe(0);
    unlinkSync(path.join(outDir, 'checkpoint.json'));

    const second = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--reader-command', reader,
      '--skip-judge',
      '--resume',
      '--limit', '1',
      '--top-k', '1'
    ]);

    expect(second.status).toBe(1);
    expect(second.stderr).toContain('Resume checkpoint is required');
  });

  it('checkpoints reader hypotheses incrementally and resumes without duplicating completed questions', () => {
    const input = writeTwoQuestionFixture();
    const reader = writeReaderCommand();
    const outDir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-reader-out-'));
    const callsPath = path.join(outDir, 'reader-calls.txt');

    const first = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--reader-command', reader,
      '--skip-judge',
      '--limit', '2',
      '--top-k', '2'
    ], {
      READER_CALLS_PATH: callsPath,
      FAIL_READER_ON: 'q_batch_2'
    });

    expect(first.status).toBe(1);
    expect(first.stderr).toContain('Reader command failed for q_batch_2');
    expect(readJsonl(path.join(outDir, 'hypotheses.jsonl'))).toEqual([
      { question_id: 'q_batch_1', hypothesis: 'jasmine tea' }
    ]);
    let checkpoint = JSON.parse(readFileSync(path.join(outDir, 'checkpoint.json'), 'utf8')) as Record<string, any>;
    expect(checkpoint.status).toBe('reader_failed');
    expect(checkpoint.reader.completed).toBe(1);
    expect(checkpoint.reader.total).toBe(2);

    const second = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--reader-command', reader,
      '--skip-judge',
      '--resume',
      '--limit', '2',
      '--top-k', '2'
    ], {
      READER_CALLS_PATH: callsPath
    });

    expect(second.status).toBe(0);
    expect(second.stderr).toBe('');
    expect(second.stdout).toContain('Reader hypotheses: 2/2');
    expect(readJsonl(path.join(outDir, 'hypotheses.jsonl'))).toEqual([
      { question_id: 'q_batch_1', hypothesis: 'jasmine tea' },
      { question_id: 'q_batch_2', hypothesis: 'iced coffee' }
    ]);
    expect(readFileSync(callsPath, 'utf8').trim().split('\n')).toEqual(['q_batch_1', 'q_batch_2', 'q_batch_2']);
    checkpoint = JSON.parse(readFileSync(path.join(outDir, 'checkpoint.json'), 'utf8')) as Record<string, any>;
    expect(checkpoint.status).toBe('reader_complete');
    expect(checkpoint.reader.completed).toBe(2);
  });

  it('checkpoints Codex-compatible judge rows and resumes without duplicating scored questions', () => {
    const input = writeTwoQuestionFixture();
    const reader = writeReaderCommand();
    const judge = writeJudgeCommand();
    const outDir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-judge-out-'));
    const readerCallsPath = path.join(outDir, 'reader-calls.txt');

    const first = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--reader-command', reader,
      '--judge-command', judge.bin,
      '--limit', '2',
      '--top-k', '2'
    ], {
      READER_CALLS_PATH: readerCallsPath,
      FAIL_JUDGE_ON: 'q_batch_2'
    });

    expect(first.status).toBe(1);
    expect(first.stderr).toContain('Codex-compatible judge failed for q_batch_2');
    expect(readJsonl(path.join(outDir, 'eval-results-codex.jsonl')).map((row) => row.question_id)).toEqual(['q_batch_1']);
    let checkpoint = JSON.parse(readFileSync(path.join(outDir, 'checkpoint.json'), 'utf8')) as Record<string, any>;
    expect(checkpoint.status).toBe('judge_failed');
    expect(checkpoint.judge.completed).toBe(1);

    const second = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--reader-command', reader,
      '--judge-command', judge.bin,
      '--resume',
      '--limit', '2',
      '--top-k', '2'
    ], {
      READER_CALLS_PATH: readerCallsPath
    });

    expect(second.status).toBe(0);
    expect(second.stderr).toBe('');
    expect(second.stdout).toContain('Codex-compatible accuracy: 1');
    const judgedRows = readJsonl(path.join(outDir, 'eval-results-codex.jsonl'));
    expect(judgedRows.map((row) => row.question_id)).toEqual(['q_batch_1', 'q_batch_2']);
    expect(judgedRows.map((row) => (row.autoeval_label as Record<string, unknown>).label)).toEqual([true, true]);
    expect(readFileSync(readerCallsPath, 'utf8').trim().split('\n')).toEqual(['q_batch_1', 'q_batch_2']);
    expect(readFileSync(judge.callsPath, 'utf8').trim().split('\n')).toEqual(['q_batch_1', 'q_batch_2', 'q_batch_2']);
    checkpoint = JSON.parse(readFileSync(path.join(outDir, 'checkpoint.json'), 'utf8')) as Record<string, any>;
    expect(checkpoint.status).toBe('completed');
    expect(checkpoint.judge.completed).toBe(2);
  });

  it('rejects resume when retrieval options no longer match the checkpoint', () => {
    const input = writeTwoQuestionFixture();
    const reader = writeReaderCommand();
    const outDir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-mismatch-out-'));

    const first = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--reader-command', reader,
      '--skip-judge',
      '--limit', '2',
      '--top-k', '2'
    ]);

    expect(first.status).toBe(0);

    const second = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--reader-command', reader,
      '--skip-judge',
      '--resume',
      '--limit', '1',
      '--top-k', '2'
    ]);

    expect(second.status).toBe(1);
    expect(second.stderr).toContain('Resume checkpoint does not match current options');
    expect(second.stderr).toContain('limit');
  });

  it('rejects stale resumed hypothesis rows outside the current fixture', () => {
    const input = writeTwoQuestionFixture();
    const reader = writeReaderCommand();
    const outDir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-codex-batch-stale-row-out-'));

    const first = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--reader-command', reader,
      '--skip-judge',
      '--limit', '2',
      '--top-k', '2'
    ]);

    expect(first.status).toBe(0);
    writeFileSync(path.join(outDir, 'hypotheses.jsonl'), `${JSON.stringify({ question_id: 'q_stale', hypothesis: 'stale' })}\n`, { flag: 'a' });

    const second = runBatch([
      '--input', input,
      '--out-dir', outDir,
      '--reader-command', reader,
      '--skip-judge',
      '--resume',
      '--limit', '2',
      '--top-k', '2'
    ]);

    expect(second.status).toBe(1);
    expect(second.stderr).toContain('Stale hypothesis question_id in resumed output');
    expect(second.stderr).toContain('q_stale');
  });
});
