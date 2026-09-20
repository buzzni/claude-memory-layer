import { createReadStream, existsSync, readFileSync, readdirSync } from 'fs';
import { once } from 'events';
import { createHash } from 'crypto';
import { join, relative, resolve } from 'path';
import { rankCuratedLessons } from '../src/extensions/mcp/lesson-ranking.js';
import type { MemoryLesson } from '../src/core/types.js';

const [fixturePath, cacheDir, mode] = process.argv.slice(2);
if (!fixturePath || !cacheDir || !existsSync(cacheDir)) {
  throw new Error('usage: tsx scripts/evaluate-lesson-hybrid.ts <fixture.json> <existing-cache-dir> [--download-model|--e5-prefix-v2|--calibrate-e5]');
}
if (mode !== undefined && mode !== '--download-model' && mode !== '--e5-prefix-v2' && mode !== '--calibrate-e5') throw new Error(`unknown mode: ${mode}`);

const prefixed = mode === '--e5-prefix-v2' || mode === '--calibrate-e5';
if (mode === '--calibrate-e5' && !/calibration/i.test(fixturePath)) throw new Error('Calibration requires a separate calibration fixture, never held-out data');

const { Embedder, normalizeTransformersNamespace, resolveTransformersModuleSpecifier } = await import('../src/extensions/vector/embedder.js');
const { HYBRID_LESSON_GATE, isSemanticRescueEligible } = await import('../src/extensions/mcp/hybrid-lesson-ranking.js');
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
const transformers = normalizeTransformersNamespace(await dynamicImport(resolveTransformersModuleSpecifier())) as {
  pipeline: unknown;
  env: { cacheDir?: string; allowRemoteModels?: boolean; allowLocalModels?: boolean };
};
// Reuse the exact managed-backend resolver and model name that Embedder uses;
// this script never constructs a model URL or sends fixture/project text away.
transformers.env.cacheDir = resolve(cacheDir);
transformers.env.allowRemoteModels = mode === '--download-model';
transformers.env.allowLocalModels = true;

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { lessons: Array<Record<string, unknown>>; cases: Array<{ id: string; query: string; expected: string[]; category: string }> };
const text = (lesson: Record<string, unknown>) => [lesson.name, lesson.trigger, ...(lesson.steps as string[]), ...(lesson.failureModes as string[])].filter(Boolean).join('\n');
const cosine = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);

/** Select only on independent calibration labels; never inspect held-out cases here. */
function calibrateGate(rankings: Array<Record<string, unknown>>) {
  const lessons: MemoryLesson[] = fixture.lessons.map((row) => ({
    lessonId: String(row.lessonId), projectHash: 'calibration', name: String(row.name), trigger: String(row.trigger ?? ''),
    steps: (row.steps as string[]) ?? [], failureModes: (row.failureModes as string[]) ?? [], confidence: 1,
    sourceSessionIds: [], sourceEventIds: [], skillCandidate: false, sourceClass: 'curated', revision: 1,
    recallEnabled: true, scope: '', validation: [], reconsiderWhen: '', validVersions: [], createdAt: new Date(0), updatedAt: new Date(0)
  }));
  const rows = fixture.cases.map((item, index) => ({
    item, lexical: rankCuratedLessons(lessons, item.query, 3).map((lesson) => lesson.lessonId),
    eligible: isSemanticRescueEligible(item.query),
    actual: rankings[index]!.actual as Array<{ lessonId: string; score: number }>
  }));
  const positives = rows.filter(({ item }) => item.expected.length).length;
  const negatives = rows.length - positives;
  const identifiers = rows.filter(({ item }) => item.category === 'identifier').length;
  let best: { absoluteCosine: number; top1Margin: number; hits: number; falseInjection: number; precision: number; identifierRetention: number } | null = null;
  // Fixed grid and ordering, chosen before the held-out rerun. Maximize recall,
  // then minimize false injections, then maximize precision and abstention.
  for (let score = 700; score <= 950; score++) for (let margin = 0; margin <= 100; margin++) {
    let hits = 0; let falseInjection = 0; let selected = 0; let correct = 0; let retained = 0;
    for (const row of rows) {
      const [first, second] = row.actual;
      const ids = row.lexical.length ? row.lexical : row.eligible && first && first.score >= score / 1000 && first.score - (second?.score ?? 0) >= margin / 1000 ? [first.lessonId] : [];
      const relevant = ids.filter((id) => row.item.expected.includes(id)).length;
      if (relevant) { hits++; if (row.item.category === 'identifier') retained++; }
      if (!row.item.expected.length && ids.length) falseInjection++;
      selected += ids.length; correct += relevant;
    }
    const precision = selected ? correct / selected : 1;
    const identifierRetention = identifiers ? retained / identifiers : 1;
    if (precision < .9 || falseInjection / negatives > .05 || identifierRetention < 1) continue;
    const candidate = { absoluteCosine: score / 1000, top1Margin: margin / 1000, hits, falseInjection, precision, identifierRetention };
    if (!best || hits > best.hits || hits === best.hits && (falseInjection < best.falseInjection || falseInjection === best.falseInjection && (precision > best.precision || precision === best.precision && (candidate.absoluteCosine > best.absoluteCosine || candidate.absoluteCosine === best.absoluteCosine && candidate.top1Margin > best.top1Margin)))) best = candidate;
  }
  return best ? { ...best, recallAt3: best.hits / positives, negativeFalseInjection: best.falseInjection / negatives,
    fixtureSha256: createHash('sha256').update(readFileSync(fixturePath)).digest('hex'),
    rule: 'Fixed grid: cosine .700-.950 step .001; margin .000-.100 step .001; precision>=.90, negative<=.05, identifier retention=1; maximize recall then safety then stricter thresholds.' } : null;
}

function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });
}

async function modelArtifact(cache: string, model: string) {
  const root = join(cache, model);
  const files = filesUnder(root).sort();
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(`${relative(root, file)}\0`);
    const stream = createReadStream(file);
    stream.on('data', (chunk: Buffer) => digest.update(chunk));
    await once(stream, 'end');
  }
  const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as { _commit_hash?: string };
  return {
    modelDirectory: root,
    modelArtifactSha256: digest.digest('hex'),
    modelRevision: config._commit_hash ?? null,
    modelRevisionSource: config._commit_hash ? 'downloaded config metadata' : 'not recorded by the Embedder default download contract'
  };
}

try {
  const embedder = new Embedder(undefined, { loadPipeline: async () => transformers.pipeline as never });
  const lessonVectors = await embedder.embedBatch(fixture.lessons.map((lesson) => prefixed ? `passage: ${text(lesson)}` : text(lesson)));
  const failures: Array<Record<string, unknown>> = [];
  const rankings: Array<Record<string, unknown>> = [];
  let hits = 0; let relevant = 0; let selected = 0; let falseInjection = 0;
  for (const row of fixture.cases) {
    const query = await embedder.embed(prefixed ? `query: ${row.query}` : row.query);
    const actual = lessonVectors.map((embedding, index) => ({ lessonId: String(fixture.lessons[index]?.lessonId), score: cosine(query.vector, embedding.vector) })).sort((a, b) => b.score - a.score).slice(0, 3);
    rankings.push({ id: row.id, kind: row.category ?? (row as { kind?: string }).kind, expected: row.expected, actual });
    const correct = actual.filter((item) => row.expected.includes(item.lessonId)).length;
    if (row.expected.length > 0 && correct > 0) hits += 1;
    selected += actual.length; relevant += correct;
    if (row.expected.length === 0 && actual.length > 0) falseInjection += 1;
    if (row.expected.length > 0 && correct === 0) failures.push({ id: row.id, category: row.category, expected: row.expected, actual });
  }
  const positives = fixture.cases.filter((row) => row.expected.length > 0).length;
  const negatives = fixture.cases.length - positives;
  const model = embedder.getModelName();
  const artifact = await modelArtifact(resolve(cacheDir), model);
  const gated = rankings.map((row) => { const actual = row.actual as Array<{ lessonId: string; score: number }>; const [first, second] = actual; const semantic = Boolean(first && isSemanticRescueEligible(String((fixture.cases.find((item) => item.id === row.id) as { query: string }).query)) && first.score >= HYBRID_LESSON_GATE.absoluteCosine && first.score - (second?.score ?? 0) >= HYBRID_LESSON_GATE.top1Margin); return { id: row.id, selected: semantic ? [first.lessonId] : [] }; });
  const gatedHits = gated.filter((row) => { const expected = fixture.cases.find((item) => item.id === row.id)!.expected; return expected.length > 0 && row.selected.some((id) => expected.includes(id)); }).length;
  const gatedFalse = gated.filter((row) => fixture.cases.find((item) => item.id === row.id)!.expected.length === 0 && row.selected.length > 0).length;
  process.stdout.write(`${JSON.stringify({ outcome: 'raw_cosine_retrieval_measured', calibratedGate: mode === '--calibrate-e5' ? calibrateGate(rankings) : undefined, model, modelDownloadedForDiagnostic: mode === '--download-model', cacheDir: resolve(cacheDir), embedderInputContract: { query: prefixed ? 'query: prefix' : 'no query prefix', document: prefixed ? 'passage: prefix' : 'no passage prefix', pooling: 'mean', normalize: true, truncation: true, maxLength: 512 }, ...artifact, positives, negatives, cosineRecallAt3: hits / positives, cosinePrecisionAt3: relevant / selected, cosineNegativeFalseInjection: falseInjection / negatives, frozenSemanticRescueGate: HYBRID_LESSON_GATE, gatedRecallAt1: gatedHits / positives, gatedNegativeFalseInjection: gatedFalse / negatives, gated, rankings, failures }, null, 2)}\n`);
  await embedder.dispose('manual');
} catch (error) {
  process.stdout.write(`${JSON.stringify({ outcome: 'local_model_unavailable', cacheDir: resolve(cacheDir), detail: error instanceof Error ? error.message.split('\n')[0] : String(error) }, null, 2)}\n`);
  process.exitCode = 2;
}
