import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeRun, gateFailureIsMeasured, prepareOutDir, summarizeLanes, summarizeLongMemEval, type Run } from '../../benchmarks/public/run.js';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-benchmark-public-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('benchmark:public summaries', () => {
  it('keeps the LongMemEval analysis scalars at four decimals and drops per-category rows', () => {
    const report = {
      fixtureStats: { memoryCount: 22419 },
      longMemEvalAnalysis: {
        k: 10, queryCount: 470, recallAnyAtK: 0.7553191489361702, recallAllAtK: 0.48936170212765956,
        fractionalRecallAtK: 0.625, ndcgAtK: 0.5559992586505385, mrr: 0.6094098277608916, byCategory: [{ category: 'x' }]
      }
    };

    expect(summarizeLongMemEval(report)).toEqual({
      k: 10, queryCount: 470, memoryCount: 22419, recallAnyAtK: 0.7553, recallAllAtK: 0.4894,
      fractionalRecallAtK: 0.625, ndcgAtK: 0.556, mrr: 0.6094
    });
  });

  it('carries the grep run haystack lengths when the report has them', () => {
    const report = {
      fixtureStats: { memoryCount: 3 },
      longMemEvalAnalysis: { k: 10, queryCount: 1, recallAnyAtK: 1, recallAllAtK: 1, fractionalRecallAtK: 1, ndcgAtK: 1, mrr: 1 },
      haystackLengths: { evidence: { count: 1, medianChars: 14463.5 }, other: { count: 2, medianChars: 10 } }
    };

    expect(summarizeLongMemEval(report).haystackLengths).toEqual(report.haystackLengths);
  });

  it('reports each lane at k=10 and at current budget with confidence intervals kept as arrays', () => {
    const arm = (recall: number) => ({ recallAtK: { 10: recall }, ndcgAtK: { 10: 0.5 }, hitAtK: { 10: 1 }, mrr: 0.25 });
    const report = {
      queries: 2, memories: 9, rerunMaxAbsDelta: 0, models: { embedder: { model: 'e5' } },
      pipeline: { arms: { current: arm(0.6), keyword: arm(0.4) } },
      pipelineAtBudget: { arms: { current: { recall: 0.6, ndcg: 0.8 }, keyword: { recall: 0.4, ndcg: 0.5, vsBaseline: { recall: { mean: -0.2, ci: [-0.35123, -0.05] } } } } }
    };

    expect(summarizeLanes(report)).toEqual({
      queries: 2, memories: 9, rerunMaxAbsDelta: 0, embedder: { model: 'e5' },
      at10: { current: { recall: 0.6, ndcg: 0.5, hit: 1, mrr: 0.25 }, keyword: { recall: 0.4, ndcg: 0.5, hit: 1, mrr: 0.25 } },
      atBudget: {
        current: { recall: 0.6, ndcg: 0.8 },
        keyword: { recall: 0.4, ndcg: 0.5, vsCurrent: { recall: { mean: -0.2, ci: [-0.3512, -0.05] } } }
      }
    });
  });
});

describe('benchmark:public run bookkeeping', () => {
  const lessonRun = (): Run => ({
    name: 'lesson', script: 'lesson.ts', args: [], writesOut: true,
    acceptExit: gateFailureIsMeasured, summarize: (report) => ({ gate: report.gate })
  });
  const writing = (outDir: string, status: number, report?: unknown) => vi.fn(() => {
    if (report !== undefined) writeFileSync(path.join(outDir, 'lesson.json'), typeof report === 'string' ? report : JSON.stringify(report));
    return status;
  });

  it('refuses an output directory that already has files, so no earlier report can be read as new', () => {
    const dir = tempDir();
    expect(() => prepareOutDir(path.join(dir, 'fresh'))).not.toThrow();
    writeFileSync(path.join(dir, 'summary.json'), '{}');
    expect(() => prepareOutDir(dir)).toThrow(/not empty/);
  });

  it('does not run, and fails, when the report file already exists', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'lesson.json'), JSON.stringify({ gate: { passed: false } }));
    const exec = writing(dir, 1);

    expect(executeRun(lessonRun(), dir, exec)).toMatchObject({ status: 'failed', reason: 'report already exists' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('counts a gate failure as measured only when this run wrote a report whose gate failed', () => {
    expect(executeRun(lessonRun(), tempDir(), (() => 1))).toMatchObject({ status: 'failed', exitCode: 1 });

    let dir = tempDir();
    expect(executeRun(lessonRun(), dir, writing(dir, 1, { gate: { passed: true } }))).toMatchObject({ status: 'failed', exitCode: 1 });

    dir = tempDir();
    expect(executeRun(lessonRun(), dir, writing(dir, 1, { gate: { passed: false } }))).toMatchObject({ status: 'measured', gate: { passed: false } });

    dir = tempDir();
    expect(executeRun(lessonRun(), dir, writing(dir, 0, { gate: { passed: true } }))).toMatchObject({ status: 'measured' });
  });

  it('fails on a report that is not valid JSON', () => {
    const dir = tempDir();
    expect(executeRun(lessonRun(), dir, writing(dir, 0, '{ truncated'))).toMatchObject({ status: 'failed', reason: 'unreadable report' });
  });
});
