import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

function runLongMemEvalSmokeCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync('npx', ['tsx', 'scripts/longmemeval-retrieval-smoke.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function writeLongMemEvalFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-cli-'));
  const fixturePath = path.join(dir, 'longmemeval-mini.json');
  writeFileSync(fixturePath, `${JSON.stringify([
    {
      question_id: 'q_cli_1',
      question_type: 'single-session-user',
      question: 'Which tea did the user prefer?',
      answer: 'jasmine tea',
      haystack_session_ids: ['s_noise', 's_answer'],
      haystack_dates: ['2026-01-01', '2026-01-02'],
      haystack_sessions: [
        [{ role: 'user', content: 'I talked about a calendar.' }],
        [
          { role: 'user', content: 'Noise before the preference.' },
          { role: 'user', content: 'I prefer jasmine tea in the afternoon.', has_answer: true }
        ]
      ],
      answer_session_ids: ['s_answer']
    }
  ], null, 2)}\n`, 'utf8');
  return fixturePath;
}

function writeLongMemEvalPreferenceFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-cli-pref-'));
  const fixturePath = path.join(dir, 'longmemeval-preference-mini.json');
  writeFileSync(fixturePath, `${JSON.stringify([
    {
      question_id: 'q_cli_pref',
      question_type: 'single-session-preference',
      question: 'Can you suggest accessories that complement my current photography setup?',
      answer: 'Sony-compatible photography accessories',
      haystack_session_ids: ['s_noise', 's_answer'],
      haystack_dates: ['2026-01-01', '2026-01-02'],
      haystack_sessions: [
        [{ role: 'user', content: 'I talked about a calendar.' }],
        [{ role: 'user', content: "I'm looking to upgrade my camera flash.", has_answer: true }]
      ],
      answer_session_ids: ['s_answer']
    }
  ], null, 2)}\n`, 'utf8');
  return fixturePath;
}

function writeReaderCommand(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-reader-'));
  const readerPath = path.join(dir, 'reader.mjs');
  writeFileSync(readerPath, `#!/usr/bin/env node
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(raw);
  const context = payload.contexts.map(item => item.content).join('\\n');
  const match = context.match(/prefer ([^.]+)\\./i);
  process.stdout.write(match ? match[1].trim() : 'I do not know');
});
`, 'utf8');
  chmodSync(readerPath, 0o755);
  return readerPath;
}

function writeEarlyExitReaderCommand(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-reader-early-exit-'));
  const readerPath = path.join(dir, 'reader.mjs');
  writeFileSync(readerPath, `#!/usr/bin/env node
process.stderr.write('reader failed before stdin\\n');
process.exit(7);
`, 'utf8');
  chmodSync(readerPath, 0o755);
  return readerPath;
}

function writeSecretLeakingReaderCommand(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-reader-secret-leak-'));
  const readerPath = path.join(dir, 'reader.mjs');
  writeFileSync(readerPath, `#!/usr/bin/env node
process.stderr.write('reader leaked ' + process.env.LONGMEMEVAL_READER_API_KEY + '\\n');
process.exit(9);
`, 'utf8');
  chmodSync(readerPath, 0o755);
  return readerPath;
}

function writeBoundarySecretLeakingReaderCommand(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-reader-boundary-secret-leak-'));
  const readerPath = path.join(dir, 'reader.mjs');
  writeFileSync(readerPath, `#!/usr/bin/env node
process.stderr.write('x'.repeat(1996) + process.env.LONGMEMEVAL_READER_API_KEY + '\\n');
process.exit(9);
`, 'utf8');
  chmodSync(readerPath, 0o755);
  return readerPath;
}

function writeLargeLongMemEvalFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-cli-large-'));
  const fixturePath = path.join(dir, 'longmemeval-large.json');
  const largeContext = `${'irrelevant context. '.repeat(150_000)} User said: I prefer jasmine tea.`;
  writeFileSync(fixturePath, `${JSON.stringify([
    {
      question_id: 'q_cli_large',
      question_type: 'single-session-user',
      question: 'Which tea did the user prefer?',
      answer: 'jasmine tea',
      haystack_session_ids: ['s_answer'],
      haystack_dates: ['2026-01-02'],
      haystack_sessions: [
        [{ role: 'user', content: largeContext, has_answer: true }]
      ],
      answer_session_ids: ['s_answer']
    }
  ], null, 2)}\n`, 'utf8');
  return fixturePath;
}

describe('LongMemEval retrieval smoke CLI', () => {
  it('documents the hybrid session+turn retrieval options in help output', () => {
    const result = runLongMemEvalSmokeCli(['--help']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('--retrieval-mode single|hybrid');
    expect(result.stdout).toContain('Default: hybrid.');
    expect(result.stdout).toContain('distinct from production MCP retrievalMode=session-event-hybrid');
    expect(result.stdout).toContain('--hybrid-retrieval');
    expect(result.stdout).toContain('--expand-user-facts');
    expect(result.stdout).toContain('--expand-preference-queries');
    expect(result.stdout).toContain('--answers-out PATH');
    expect(result.stdout).toContain('--reader-command PATH');
    expect(result.stdout).toContain('LongMemEval-compatible JSONL');
  });

  it('defaults to hybrid retrieval when retrieval mode is omitted', () => {
    const fixturePath = writeLongMemEvalFixture();
    const result = runLongMemEvalSmokeCli([
      '--input', fixturePath,
      '--granularity', 'session',
      '--format', 'json',
      '--top-k', '2'
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as {
      evaluator: string;
      fixtureStats: { ks: number[] };
      summary: { recallAtK: Record<string, number> };
      perQuery: Array<{ at: Record<string, unknown> }>;
      longMemEvalAnalysis: { k: number };
    };
    expect(report.evaluator).toBe('cml-retriever-longmemeval-hybrid-isolated-v1');
    expect(report.fixtureStats.ks).toContain(2);
    expect(report.summary.recallAtK).toHaveProperty('2');
    expect(report.perQuery[0]?.at).toHaveProperty('2');
    expect(report.longMemEvalAnalysis.k).toBe(2);
  });

  it('preserves explicit single retrieval override', () => {
    const fixturePath = writeLongMemEvalFixture();
    const result = runLongMemEvalSmokeCli([
      '--input', fixturePath,
      '--retrieval-mode', 'single',
      '--granularity', 'session',
      '--format', 'json',
      '--top-k', '2'
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as { evaluator: string };
    expect(report.evaluator).toBe('cml-retriever-longmemeval-session-isolated-v1');
  });

  it('passes user-fact expansion into converted fixtures', () => {
    const fixturePath = writeLongMemEvalFixture();
    const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-cli-out-'));
    const fixtureOut = path.join(dir, 'fixture.json');
    const result = runLongMemEvalSmokeCli([
      '--input', fixturePath,
      '--expand-user-facts',
      '--fixture-out', fixtureOut,
      '--format', 'json',
      '--top-k', '2'
    ]);

    expect(result.status).toBe(0);
    const fixture = JSON.parse(readFileSync(fixtureOut, 'utf8')) as { memories: Array<{ content: string; metadata: Record<string, unknown> }> };
    expect(fixture.memories[1].content).toContain('Extracted user facts:');
    expect(fixture.memories[1].metadata.userFactExpansion).toBe(true);
  });

  it('passes preference query expansion into converted fixtures', () => {
    const fixturePath = writeLongMemEvalPreferenceFixture();
    const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-cli-pref-out-'));
    const fixtureOut = path.join(dir, 'fixture.json');
    const result = runLongMemEvalSmokeCli([
      '--input', fixturePath,
      '--expand-preference-queries',
      '--fixture-out', fixtureOut,
      '--format', 'json',
      '--top-k', '2'
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const fixture = JSON.parse(readFileSync(fixtureOut, 'utf8')) as {
      metadata: Record<string, unknown>;
      queries: Array<{ query: string; knownAnswer?: string }>;
    };
    expect(fixture.metadata.preferenceQueryExpansion).toBe(true);
    expect(fixture.queries[0].query).toContain('user preference personal context interests goals prior details');
    expect(fixture.queries[0].query).not.toContain('Sony-compatible photography accessories');
  });

  it('runs hybrid retrieval and emits official-style analysis in JSON', () => {
    const fixturePath = writeLongMemEvalFixture();
    const result = runLongMemEvalSmokeCli([
      '--input', fixturePath,
      '--retrieval-mode', 'hybrid',
      '--granularity', 'session',
      '--format', 'json',
      '--top-k', '2'
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as {
      evaluator: string;
      longMemEvalAnalysis: { recallAnyAtK: number; failureBreakdown: Record<string, number> };
    };
    expect(report.evaluator).toBe('cml-retriever-longmemeval-hybrid-isolated-v1');
    expect(report.longMemEvalAnalysis.recallAnyAtK).toBeGreaterThan(0);
    expect(report.longMemEvalAnalysis.failureBreakdown.hit).toBeGreaterThan(0);
  });

  it('fails closed when answer JSONL output is requested without a reader command', () => {
    const fixturePath = writeLongMemEvalFixture();
    const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-answers-'));
    const answersOut = path.join(dir, 'hypotheses.jsonl');
    const result = runLongMemEvalSmokeCli([
      '--input', fixturePath,
      '--format', 'json',
      '--answers-out', answersOut,
      '--top-k', '2'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--reader-command is required when --answers-out is set');
  });

  it('reports early reader failure without crashing on stdin EPIPE', () => {
    const fixturePath = writeLargeLongMemEvalFixture();
    const readerCommand = writeEarlyExitReaderCommand();
    const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-answers-'));
    const answersOut = path.join(dir, 'hypotheses.jsonl');
    const result = runLongMemEvalSmokeCli([
      '--input', fixturePath,
      '--retrieval-mode', 'hybrid',
      '--granularity', 'session',
      '--format', 'json',
      '--top-k', '2',
      '--answers-out', answersOut,
      '--reader-command', readerCommand
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Reader command failed for q_cli_large with exit code 7');
    expect(result.stderr).toContain('reader failed before stdin');
    expect(result.stderr).not.toContain('Unhandled');
    expect(result.stderr).not.toContain('write EPIPE');
  });

  it('redacts inherited reader credentials from failing reader stderr', () => {
    const fixturePath = writeLongMemEvalFixture();
    const readerCommand = writeSecretLeakingReaderCommand();
    const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-answers-'));
    const answersOut = path.join(dir, 'hypotheses.jsonl');
    const secretValue = ['reader', 'secret', 'fixture', '12345'].join('-');
    const result = runLongMemEvalSmokeCli([
      '--input', fixturePath,
      '--retrieval-mode', 'hybrid',
      '--granularity', 'session',
      '--format', 'json',
      '--top-k', '2',
      '--answers-out', answersOut,
      '--reader-command', readerCommand
    ], Object.fromEntries([['LONGMEMEVAL_READER_API_KEY', secretValue]]));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Reader command failed for q_cli_1 with exit code 9');
    expect(result.stderr).toContain('[REDACTED]');
    expect(result.stderr).not.toContain(secretValue);
  });

  it('redacts reader credentials before truncating failing reader stderr', () => {
    const fixturePath = writeLongMemEvalFixture();
    const readerCommand = writeBoundarySecretLeakingReaderCommand();
    const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-answers-'));
    const answersOut = path.join(dir, 'hypotheses.jsonl');
    const secretValue = ['zzzz', 'boundary', 'fixture', '12345'].join('-');
    const result = runLongMemEvalSmokeCli([
      '--input', fixturePath,
      '--retrieval-mode', 'hybrid',
      '--granularity', 'session',
      '--format', 'json',
      '--top-k', '2',
      '--answers-out', answersOut,
      '--reader-command', readerCommand
    ], Object.fromEntries([['LONGMEMEVAL_READER_API_KEY', secretValue]]));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Reader command failed for q_cli_1 with exit code 9');
    expect(result.stderr).not.toContain(secretValue);
    expect(result.stderr).not.toContain(secretValue.slice(0, 4));
  });

  it('writes official LongMemEval hypothesis JSONL from retrieved context via reader command', () => {
    const fixturePath = writeLongMemEvalFixture();
    const readerCommand = writeReaderCommand();
    const dir = mkdtempSync(path.join(tmpdir(), 'cml-longmemeval-answers-'));
    const answersOut = path.join(dir, 'hypotheses.jsonl');
    const result = runLongMemEvalSmokeCli([
      '--input', fixturePath,
      '--retrieval-mode', 'hybrid',
      '--granularity', 'session',
      '--format', 'json',
      '--top-k', '2',
      '--answers-out', answersOut,
      '--reader-command', readerCommand
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const rows = readFileSync(answersOut, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toEqual([
      {
        question_id: 'q_cli_1',
        hypothesis: 'jasmine tea in the afternoon'
      }
    ]);
  });
});
