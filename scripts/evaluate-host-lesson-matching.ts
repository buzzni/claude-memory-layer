/**
 * specs/host-lesson-matching-2026-10-18 stage 1 — replay real prompts through
 * host lesson matching, reproducibly.
 *
 * Inputs stay outside the repository: the project store (read-only) and a
 * private label file. The report carries aggregates only: no prompt text,
 * lesson text, path or session id.
 *
 *   tsx scripts/evaluate-host-lesson-matching.ts --store <events.sqlite> \
 *     --labels <labels.json> --since <iso> --until <iso> --split-at <iso> --out <report.json>
 *   ... --emit-sheet <sheet.json> --sample <n> [--seed <n>]   # candidates to label
 *
 * Label file: {"version":1,"labels":{"<promptKey>":{"applies":[lessonId],"judged":[lessonId]}}}
 * `judged` is every lesson the labeler saw for that prompt; a selection outside
 * judged ∪ applies is counted as unlabeled, never as wrong.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeUserPrompt } from '../src/core/prompt-normalizer.js';
import type { MemoryLesson } from '../src/core/types.js';

const PROMPT_KEY_CHARS = 1_500;
const LESSON_BLOCK_MARKERS = ['## Project lessons that may apply', 'These are reference notes from earlier verified work', '[lesson:'];

export interface PromptRow { content: string; timestamp: string; sessionId: string }
export interface PreparedPrompt { key: string; text: string; timestamp: string; sessionId: string }

export function promptKey(text: string): string {
  return createHash('sha256').update(text.slice(0, PROMPT_KEY_CHARS)).digest('hex').slice(0, 16);
}

/** Normalize like the store does, keep real requests once, and count host scaffolds that survived. */
export function preparePrompts(rows: readonly PromptRow[], options: { minChars?: number } = {}) {
  const seen = new Set<string>();
  const prompts: PreparedPrompt[] = [];
  let droppedAutomated = 0;
  let droppedDuplicates = 0;
  let leftoverMarkers = 0;
  for (const row of rows) {
    const normalized = normalizeUserPrompt(row.content);
    if (normalized.kind !== 'user') { droppedAutomated++; continue; }
    const text = normalized.requestText.trim();
    if (text.length < (options.minChars ?? 4)) { droppedAutomated++; continue; }
    if (seen.has(text)) { droppedDuplicates++; continue; }
    seen.add(text);
    if (LESSON_BLOCK_MARKERS.some((marker) => text.includes(marker))) leftoverMarkers++;
    prompts.push({ key: promptKey(text), text, timestamp: row.timestamp, sessionId: row.sessionId });
  }
  return { prompts, droppedAutomated, droppedDuplicates, leftoverMarkers };
}

export interface Ratio { k: number; n: number }

/**
 * Units kept apart: a prompt hit is "at least one applicable lesson selected
 * for a prompt that has one"; precision and recall count lesson pairs.
 */
export function scoreSelections(items: ReadonlyArray<{ selected: readonly string[]; applies: readonly string[]; labeled: readonly string[] }>) {
  let positivePrompts = 0; let hits = 0; let pairs = 0; let found = 0;
  let judgedSelections = 0; let correct = 0; let unlabeled = 0;
  let negativePrompts = 0; let injected = 0; let anyWrong = 0;
  for (const item of items) {
    const applies = new Set(item.applies);
    const labeled = new Set([...item.labeled, ...item.applies]);
    const judged = item.selected.filter((id) => labeled.has(id));
    unlabeled += item.selected.length - judged.length;
    judgedSelections += judged.length;
    const right = judged.filter((id) => applies.has(id)).length;
    correct += right;
    if (judged.some((id) => !applies.has(id))) anyWrong++;
    if (applies.size > 0) {
      positivePrompts++; pairs += applies.size; found += right;
      if (right > 0) hits++;
    } else {
      negativePrompts++;
      if (judged.length > 0) injected++;
    }
  }
  return {
    prompts: items.length, positivePrompts, negativePrompts, applicablePairs: pairs,
    promptHit: { k: hits, n: positivePrompts },
    lessonPrecision: { k: correct, n: judgedSelections },
    lessonRecall: { k: found, n: pairs },
    negativeInjection: { k: injected, n: negativePrompts },
    anyWrong: { k: anyWrong, n: items.length },
    unlabeledSelections: unlabeled
  };
}

/** Lessons that appear in the candidate list of at least `share` of prompts. */
export function findHubLessons(candidateLists: ReadonlyArray<readonly string[]>, share: number): string[] {
  const counts = new Map<string, number>();
  for (const list of candidateLists) for (const id of new Set(list)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const floor = share * candidateLists.length;
  return [...counts].filter(([, count]) => count >= floor).map(([id]) => id).sort();
}

/** Precision a judge could reach on these candidates, given how often it accepts a wrong one. */
export function achievablePrecision(input: { positives: number; negatives: number; truePositiveRate: number; falseAcceptRate: number }): number | null {
  const accepted = input.positives * input.truePositiveRate + input.negatives * input.falseAcceptRate;
  return accepted > 0 ? (input.positives * input.truePositiveRate) / accepted : null;
}

/** Wilson score interval, 95%. */
export function wilson(k: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.959964; const p = k / n;
  const center = (p + z * z / (2 * n)) / (1 + z * z / n);
  const half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const ratio = (value: Ratio) => ({ ...value, rate: value.n ? +(value.k / value.n).toFixed(3) : null, wilson95: wilson(value.k, value.n)?.map((x) => +x.toFixed(3)) ?? null });

async function main(): Promise<void> {
  const store = arg('store'); const since = arg('since'); const until = arg('until'); const splitAt = arg('split-at');
  const labelsPath = arg('labels'); const out = arg('out'); const sheet = arg('emit-sheet');
  const topK = Number(arg('topk') ?? 5); const hubShare = Number(arg('hub-share') ?? 0.15);
  if (!Number.isInteger(topK) || topK < 1 || !(hubShare > 0 && hubShare <= 1)) throw new Error('--topk must be a positive integer and --hub-share in (0, 1]');
  if (!store || !since || !until || !splitAt || (!out && !sheet)) {
    throw new Error('usage: tsx scripts/evaluate-host-lesson-matching.ts --store <events.sqlite> --since <iso> --until <iso> --split-at <iso> (--labels <labels.json> --out <report.json> | --emit-sheet <sheet.json> --sample <n> [--seed <n>])');
  }
  const { default: Database } = await import('better-sqlite3');
  const { LessonRepository } = await import('../src/core/operations/lesson-repository.js');
  const { rankCuratedLessons } = await import('../src/extensions/mcp/lesson-ranking.js');
  const { getDefaultEmbedder } = await import('../src/extensions/vector/embedder.js');

  const db = new Database(store, { readonly: true, fileMustExist: true });
  const projectHashes = (db.prepare('SELECT DISTINCT project_hash AS h FROM memory_lessons').all() as Array<{ h: string }>).map((row) => row.h);
  if (projectHashes.length !== 1) throw new Error(`expected one lesson project in the store, found ${projectHashes.length}`);
  const lessons: MemoryLesson[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await new LessonRepository(db as never).list({ projectHash: projectHashes[0], limit: 500, offset });
    lessons.push(...page.filter((lesson) => lesson.recallEnabled));
    if (page.length < 500) break;
  }
  // Sessions a lesson came from: its source sessions plus the sessions of its source events.
  const sessionOfEvent = db.prepare('SELECT session_id AS s FROM events WHERE id = ?');
  const sourceSessions = new Map(lessons.map((lesson) => [lesson.lessonId, new Set([
    ...lesson.sourceSessionIds,
    ...lesson.sourceEventIds.map((id) => (sessionOfEvent.get(id) as { s?: string } | undefined)?.s).filter((s): s is string => Boolean(s))
  ])]));

  const rows = (db.prepare(`SELECT content, timestamp, session_id AS sessionId FROM events
    WHERE event_type = 'user_prompt' AND timestamp >= ? AND timestamp < ? ORDER BY timestamp`).all(since, until)) as PromptRow[];
  const prepared = preparePrompts(rows);

  const embedder = getDefaultEmbedder();
  await embedder.initialize();
  // getModelName() reports the model actually loaded, which is the fallback after a primary failure.
  if (embedder.getModelName() !== 'Xenova/multilingual-e5-small') {
    throw new Error('embedder is not the evaluated primary model; refusing to report fallback-model candidates');
  }
  const lessonText = (lesson: MemoryLesson) => [lesson.name, lesson.trigger, ...lesson.steps, ...lesson.failureModes].filter(Boolean).join('\n');
  const vectors = new Map<string, number[]>();
  for (const lesson of lessons) vectors.set(lesson.lessonId, (await embedder.embed(`passage: ${lessonText(lesson)}`)).vector);
  const available = (prompt: PreparedPrompt) => lessons.filter((lesson) => lesson.createdAt.toISOString() <= prompt.timestamp);
  const rankEmbedding = async (prompt: PreparedPrompt, pool: readonly MemoryLesson[]) => {
    const query = (await embedder.embed(`query: ${prompt.text}`)).vector;
    return pool.map((lesson) => ({ id: lesson.lessonId, score: vectors.get(lesson.lessonId)!.reduce((sum, value, i) => sum + value * query[i], 0) }))
      .sort((a, b) => b.score - a.score).map((entry) => entry.id);
  };

  if (sheet) {
    const sample = seededShuffle(prepared.prompts, Number(arg('seed') ?? 42)).slice(0, Number(arg('sample') ?? 100));
    const byId = new Map(lessons.map((lesson) => [lesson.lessonId, lesson]));
    const items = [];
    for (const prompt of sample) {
      const pool = available(prompt);
      const candidates = [...new Set([...(await rankEmbedding(prompt, pool)).slice(0, 6), ...rankCuratedLessons(pool, prompt.text, 3).map((l) => l.lessonId)])];
      items.push({ key: prompt.key, timestamp: prompt.timestamp, prompt: prompt.text.slice(0, PROMPT_KEY_CHARS),
        candidates: candidates.map((id) => ({ lessonId: id, name: byId.get(id)!.name, trigger: byId.get(id)!.trigger })) });
    }
    writeFileSync(sheet, `${JSON.stringify(items, null, 1)}\n`);
    process.stdout.write(`labeling sheet: ${items.length} prompts\n`);
    if (!out) return;
  }

  if (!labelsPath) throw new Error('--labels is required with --out');
  const labelFile = JSON.parse(readFileSync(labelsPath, 'utf8')) as { version: number; labels: Record<string, { applies: string[]; judged: string[] }> };
  const created = new Map(lessons.map((lesson) => [lesson.lessonId, lesson.createdAt.toISOString()]));
  const labeledPrompts = prepared.prompts.filter((prompt) => labelFile.labels[prompt.key]);
  let futureLabelPairs = 0; let recentPairs = 0;
  const rowsBySplit: Record<'calibration' | 'heldout', Array<Record<string, unknown>>> = { calibration: [], heldout: [] };
  for (const prompt of labeledPrompts) {
    const label = labelFile.labels[prompt.key];
    const applies = label.applies.filter((id) => {
      const at = created.get(id);
      if (!at || at > prompt.timestamp) { futureLabelPairs++; return false; }
      if (Date.parse(prompt.timestamp) - Date.parse(at) < 24 * 3600_000) recentPairs++;
      return true;
    });
    const pool = available(prompt);
    const ranked = await rankEmbedding(prompt, pool);
    rowsBySplit[prompt.timestamp < splitAt ? 'calibration' : 'heldout'].push({
      sessionId: prompt.sessionId, applies, labeled: label.judged,
      lexical: rankCuratedLessons(pool, prompt.text, 3).map((lesson) => lesson.lessonId),
      ranked: ranked.slice(0, 20)
    });
  }

  type Row = { sessionId: string; applies: string[]; labeled: string[]; lexical: string[]; ranked: string[] };
  const calibrationRows = rowsBySplit.calibration as Row[];
  const hubs = new Set(findHubLessons(calibrationRows.map((row) => row.ranked.slice(0, topK)), hubShare));
  const reductions: Record<string, (row: Row, id: string) => boolean> = {
    none: () => true,
    excludeOwnSession: (row, id) => !sourceSessions.get(id)?.has(row.sessionId),
    excludeHubs: (_row, id) => !hubs.has(id),
    both: (row, id) => !sourceSessions.get(id)?.has(row.sessionId) && !hubs.has(id)
  };
  const report: Record<string, unknown> = {
    spec: 'specs/host-lesson-matching-2026-10-18',
    window: { since, until, splitAt },
    lessons: lessons.length,
    prompts: { prepared: prepared.prompts.length, labeled: labeledPrompts.length, droppedAutomated: prepared.droppedAutomated, droppedDuplicates: prepared.droppedDuplicates, leftoverLessonBlockMarkers: prepared.leftoverMarkers },
    labels: { futureLessonPairsExcluded: futureLabelPairs, pairsWithin24hOfLessonCreation: recentPairs },
    candidateReduction: { topK, hubShare, hubsFromCalibration: hubs.size },
    splits: {}
  };
  for (const split of ['calibration', 'heldout'] as const) {
    const rows = rowsBySplit[split] as Row[];
    const score = (pick: (row: Row) => string[]) => {
      const scored = scoreSelections(rows.map((row) => ({ selected: pick(row), applies: row.applies, labeled: row.labeled })));
      return { ...scored, promptHit: ratio(scored.promptHit), lessonPrecision: ratio(scored.lessonPrecision), lessonRecall: ratio(scored.lessonRecall), negativeInjection: ratio(scored.negativeInjection), anyWrong: ratio(scored.anyWrong) };
    };
    const reduction = Object.fromEntries(Object.entries(reductions).map(([name, keep]) => {
      const candidates = rows.map((row) => row.ranked.filter((id) => keep(row, id)).slice(0, topK));
      let positives = 0; let negatives = 0; let unlabeledCandidates = 0;
      rows.forEach((row, i) => {
        const labeled = new Set([...row.labeled, ...row.applies]);
        for (const id of candidates[i]) {
          if (row.applies.includes(id)) positives++;
          else if (labeled.has(id)) negatives++;
          else unlabeledCandidates++;
        }
      });
      const hit = score((row) => candidates[rows.indexOf(row)]);
      return [name, {
        candidatePositives: positives, candidateNegatives: negatives, unlabeledCandidates,
        promptHitAtK: hit.promptHit,
        achievablePrecisionByFalseAcceptRate: Object.fromEntries([0.005, 0.01, 0.02, 0.05].map((far) => [far, achievablePrecision({ positives, negatives, truePositiveRate: 1, falseAcceptRate: far })?.toFixed(3) ?? null]))
      }];
    }));
    (report.splits as Record<string, unknown>)[split] = {
      currentLexical: score((row) => row.lexical),
      embeddingTop1: score((row) => row.ranked.slice(0, 1)),
      embeddingTop3: score((row) => row.ranked.slice(0, 3)),
      reduction
    };
  }
  writeFileSync(out!, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.prompts)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
