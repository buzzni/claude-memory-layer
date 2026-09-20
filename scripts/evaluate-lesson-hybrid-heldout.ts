import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankCuratedLessons } from '../src/extensions/mcp/lesson-ranking.js';
import { hybridLessonStatus, rankCuratedLessonsHybrid, warmHybridLessonCache } from '../src/extensions/mcp/hybrid-lesson-ranking.js';
import type { MemoryLesson } from '../src/core/types.js';
import { normalizeTransformersNamespace, resolveTransformersModuleSpecifier, Embedder } from '../src/extensions/vector/embedder.js';


/** Frozen ranking thresholds; missing observations cannot certify a pass. */
export function lessonRecallGate(metrics: Record<string, unknown>): { passed: boolean; failures: string[] } {
  const rates = ['recallAt3', 'precisionAt3', 'negativeFalseInjection', 'identifierRetention'] as const;
  const passes: Record<string, (value: number) => boolean> = {
    recallAt3: (value) => value >= .8,
    precisionAt3: (value) => value >= .9,
    negativeFalseInjection: (value) => value <= .05,
    identifierRetention: (value) => value === 1,
    p95Ms: (value) => value <= 300,
  };
  const failures = Object.keys(passes).filter((field) => {
    const value = metrics[field];
    return typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || (rates.includes(field as typeof rates[number]) && value > 1) || !passes[field](value);
  });
  return { passed: failures.length === 0, failures };
}

async function main(): Promise<void> {
  const [fixturePath, outputPath] = process.argv.slice(2);
  if (!fixturePath || !outputPath) throw new Error('usage: tsx scripts/evaluate-lesson-hybrid-heldout.ts <heldout.json> <result.json>');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { lessons: Array<Record<string, unknown>>; cases: Array<{ id: string; query: string; expected: string[]; category?: string }> };
  const cacheDir = resolve('.cache/lesson-hybrid-e5');
  process.env.CLAUDE_MEMORY_LESSON_HYBRID_EXPERIMENT = 'true';
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
  const transformers = normalizeTransformersNamespace(await dynamicImport(resolveTransformersModuleSpecifier())) as { pipeline: unknown; env: { cacheDir?: string; allowRemoteModels?: boolean; allowLocalModels?: boolean } };
  transformers.env.cacheDir = cacheDir; transformers.env.allowRemoteModels = false; transformers.env.allowLocalModels = true;
  const embedder = new Embedder(undefined, { loadPipeline: async () => transformers.pipeline as never });
  const lessons: MemoryLesson[] = fixture.lessons.map((row) => ({ lessonId: String(row.lessonId), projectHash: 'heldout', name: String(row.name), trigger: String(row.trigger ?? ''), steps: (row.steps as string[] ?? []).map(String), confidence: 1, sourceSessionIds: [], sourceEventIds: [], failureModes: (row.failureModes as string[] ?? []).map(String), skillCandidate: false, sourceClass: 'curated', revision: 1, recallEnabled: true, scope: '', validation: [], reconsiderWhen: '', validVersions: [], createdAt: new Date(0), updatedAt: new Date(0) }));
  const p95 = (values: number[]) => values.sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * .95) - 1)] ?? 0;
  const measure = async (rank: (query: string) => Promise<MemoryLesson[]>) => {
    const latency: number[] = []; let hits = 0; let selected = 0; let relevant = 0; let falseInjection = 0; let identifiers = 0; let retained = 0;
    for (const item of fixture.cases) { const start = performance.now(); const found = await rank(item.query); latency.push(performance.now() - start); const ids = found.map((lesson) => lesson.lessonId); const correct = ids.filter((id) => item.expected.includes(id)).length; if (item.expected.length && correct) hits++; if (!item.expected.length && ids.length) falseInjection++; selected += ids.length; relevant += correct; if (item.category === 'identifier' && item.expected.length) { identifiers++; if (correct) retained++; } }
    const positives = fixture.cases.filter((item) => item.expected.length).length; const negatives = fixture.cases.length - positives;
    return { recallAt3: hits / positives, precisionAt3: selected ? relevant / selected : 0, negativeFalseInjection: falseInjection / negatives, identifierRetention: identifiers ? retained / identifiers : null, p95Ms: p95(latency) };
  };
  const lexical = await measure(async (query) => rankCuratedLessons(lessons, query, 3));
  const coldQuery = 'unseen multilingual semantic paraphrase';
  await rankCuratedLessonsHybrid(lessons, coldQuery, 3, embedder); // lexical-empty cold path schedules background index build
  await warmHybridLessonCache(lessons, embedder);
  const hybrid = await measure(async (query) => rankCuratedLessonsHybrid(lessons, query, 3, embedder));
  const gate = lessonRecallGate(hybrid);
  const result = { gate, gateScope: 'ranking-only; installed-runtime, scope-safety and cold-turn gates remain separate', fixture: resolve(fixturePath), cacheDir, remoteModels: false, status: hybridLessonStatus(), lexical, hybrid, note: 'Common-function evaluation; Gate is frozen from independent calibration-v3 only and not tuned here.' };
  mkdirSync(dirname(outputPath), { recursive: true }); writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`); process.stdout.write(`${JSON.stringify(result)}\n`);

  if (!gate.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
