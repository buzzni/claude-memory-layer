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
 *   tsx scripts/evaluate-host-lesson-matching.ts --store <events.sqlite> --emit-twins <twins.json> [--twin-threshold 0.5]
 *   ... --canonical-map <map.json>   # {"map":{"<lessonId>":"<canonicalId>"}}: twins
 *   ... --catalog-overlay <overlay.json>   # CatalogOverlay: score the catalog as if runbooks had absorbed lessons
 *   ... --emit-unlabeled <sheet.json>   # labeled prompts' candidates no label judged yet (label them, then rerun)
 *
 * Label file: {"version":1,"labels":{"<promptKey>":{"applies":[lessonId],"judged":[lessonId],"kinds"?:{"<lessonId>":"first-turn"|"event"}}}}
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

type ScoredItem = { selected: readonly string[]; applies: readonly string[]; labeled: readonly string[] };
const dedupe = (ids: readonly string[]) => [...new Set(ids)];

/**
 * Near-duplicate lessons ("twins") by token overlap of name and trigger. The
 * catalog holds several copies of one rule; scoring them as different lessons
 * counts a correct twin as a wrong answer. Groups are a proposal for review.
 */
export function proposeTwinGroups(lessons: ReadonlyArray<{ lessonId: string; name: string; trigger: string }>, threshold: number): string[][] {
  const tokens = lessons.map((lesson) => new Set(`${lesson.name} ${lesson.trigger}`.toLowerCase().match(/[a-z0-9가-힣]{2,}/g) ?? []));
  const similarity = (i: number, j: number) => {
    const shared = [...tokens[i]].filter((token) => tokens[j].has(token)).length;
    const union = tokens[i].size + tokens[j].size - shared;
    return union > 0 ? shared / union : 0;
  };
  const pairs: Array<[number, number, number]> = [];
  for (let i = 0; i < lessons.length; i++) for (let j = i + 1; j < lessons.length; j++) {
    const score = similarity(i, j);
    if (score >= threshold) pairs.push([score, i, j]);
  }
  // Complete linkage: clusters merge only when every cross pair is a twin, so
  // A~B and B~C never pull an unrelated A and C together.
  pairs.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
  const cluster = lessons.map((_, i) => [i]);
  const owner = lessons.map((_, i) => i);
  for (const [, i, j] of pairs) {
    const a = owner[i]; const b = owner[j];
    if (a === b || !cluster[a].every((x) => cluster[b].every((y) => similarity(x, y) >= threshold))) continue;
    for (const y of cluster[b]) owner[y] = a;
    cluster[a] = [...cluster[a], ...cluster[b]]; cluster[b] = [];
  }
  return cluster.filter((members) => members.length > 1)
    .map((members) => members.map((i) => lessons[i].lessonId).sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** Every member of a group maps to the group's first id (sorted), so twins score as one lesson. */
export function twinCanonicalMap(groups: ReadonlyArray<readonly string[]>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const group of groups) {
    const [canonical, ...rest] = [...group].sort();
    for (const id of rest) map[id] = canonical;
  }
  return map;
}

/** Follows chains (c → b → a) to their end; a cycle is a broken map, not a merge. */
export function resolveCanonicalMap(map: Readonly<Record<string, string>>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const start of Object.keys(map)) {
    const seen = new Set([start]);
    let current = map[start];
    while (map[current] !== undefined) {
      if (seen.has(current)) throw new Error(`canonical map has a cycle through ${current}`);
      seen.add(current);
      current = map[current];
    }
    if (current === start) throw new Error(`canonical map has a cycle through ${start}`);
    resolved[start] = current;
  }
  return resolved;
}

/** The one id-mapping path: twins, or old lesson → consolidated runbook. */
export function canonicalIds(ids: readonly string[], map: Readonly<Record<string, string>>): string[] {
  return dedupe(ids.map((id) => map[id] ?? id));
}

export function canonicalizeItem<T extends ScoredItem>(item: T, map: Readonly<Record<string, string>>): T {
  return { ...item, selected: canonicalIds(item.selected, map), applies: canonicalIds(item.applies, map), labeled: canonicalIds(item.labeled, map) };
}

/**
 * Kinds of the applicable lessons, on canonical ids. Two lessons merged into
 * one id must agree (an unlabeled one counts as first-turn); otherwise the
 * label set is inconsistent and the result would depend on key order.
 */
export function mergeKinds(kinds: Readonly<Record<string, LessonKind>>, applies: readonly string[], map: Readonly<Record<string, string>>): Record<string, LessonKind> {
  const merged: Record<string, LessonKind> = {};
  for (const id of applies) {
    const canonical = map[id] ?? id;
    const kind = kinds[id] ?? 'first-turn';
    if (merged[canonical] && merged[canonical] !== kind) throw new Error(`label kind conflict on ${canonical}: ${merged[canonical]} vs ${kind}`);
    merged[canonical] = kind;
  }
  return merged;
}

export interface CatalogOverlay {
  runbooks: Array<{ lessonId: string; name: string; trigger: string; steps: string[]; failureModes?: string[]; validation?: string[]; absorbs: string[] }>;
}

/**
 * The catalog as it would be after consolidation: absorbed lessons leave the
 * pool and their runbook joins it. A runbook is available from its earliest
 * absorbed lesson (its text may carry later rules: an optimistic bound) and
 * inherits their sources, so own-session exclusion still applies to it.
 */
export function applyCatalogOverlay(catalog: readonly MemoryLesson[], overlay: CatalogOverlay): { lessons: MemoryLesson[]; absorbedBy: Record<string, string> } {
  // Every id is reserved, disabled ones included: their labels and creation times stay in use.
  const byId = new Map(catalog.map((lesson) => [lesson.lessonId, lesson]));
  const absorbedBy: Record<string, string> = {};
  const runbooks: MemoryLesson[] = [];
  for (const runbook of overlay.runbooks) {
    if (byId.has(runbook.lessonId) || runbooks.some((other) => other.lessonId === runbook.lessonId)) throw new Error(`runbook id ${runbook.lessonId} is already in use`);
    if (runbook.absorbs.length === 0) throw new Error(`runbook ${runbook.lessonId} absorbs no lesson`);
    const absorbed = runbook.absorbs.map((id) => {
      const lesson = byId.get(id);
      if (!lesson) throw new Error(`runbook ${runbook.lessonId} absorbs unknown lesson ${id}`);
      if (!lesson.recallEnabled) throw new Error(`runbook ${runbook.lessonId} absorbs disabled lesson ${id}`);
      if (absorbedBy[id]) throw new Error(`lesson ${id} is absorbed by more than one runbook`);
      absorbedBy[id] = runbook.lessonId;
      return lesson;
    });
    const createdAt = new Date(Math.min(...absorbed.map((lesson) => lesson.createdAt.getTime())));
    runbooks.push({
      lessonId: runbook.lessonId, name: runbook.name, trigger: runbook.trigger, steps: runbook.steps,
      failureModes: runbook.failureModes ?? [], validation: runbook.validation ?? [], validVersions: [],
      confidence: Math.max(...absorbed.map((lesson) => lesson.confidence)),
      sourceSessionIds: dedupe(absorbed.flatMap((lesson) => lesson.sourceSessionIds)),
      sourceEventIds: dedupe(absorbed.flatMap((lesson) => lesson.sourceEventIds)),
      skillCandidate: false, sourceClass: 'curated', revision: 1, recallEnabled: true, createdAt, updatedAt: createdAt
    });
  }
  return { lessons: [...catalog.filter((lesson) => lesson.recallEnabled && !absorbedBy[lesson.lessonId]), ...runbooks], absorbedBy };
}

/**
 * Twin map then runbook map. A twin group must be absorbed whole into one
 * runbook: a twin left in the pool would score as the runbook it never was,
 * and twins split across runbooks would score one rule as two.
 */
export function combineMaps(twins: Readonly<Record<string, string>>, absorbedBy: Readonly<Record<string, string>>): Record<string, string> {
  for (const [member, canonical] of Object.entries(twins)) {
    if ((absorbedBy[member] !== undefined || absorbedBy[canonical] !== undefined) && absorbedBy[member] !== absorbedBy[canonical]) {
      throw new Error(`twins ${member} and ${canonical} are not absorbed into the same runbook; absorb the whole twin group`);
    }
  }
  return resolveCanonicalMap({ ...twins, ...absorbedBy });
}

/**
 * A judgment on an absorbed lesson says nothing about its runbook, which also
 * holds the other lessons' rules; only an applicable absorbed lesson carries
 * over (through applies). A runbook is otherwise judged directly.
 */
export function judgedAfterOverlay(judged: readonly string[], absorbedBy: Readonly<Record<string, string>>): string[] {
  return judged.filter((id) => absorbedBy[id] === undefined);
}

/**
 * Kinds after consolidation. A runbook covers its lessons' different moments,
 * so it is first-turn when any absorbed lesson applies from the first message.
 */
export function absorbKinds(kinds: Readonly<Record<string, LessonKind>>, absorbedBy: Readonly<Record<string, string>>): Record<string, LessonKind> {
  const merged: Record<string, LessonKind> = {};
  for (const [id, kind] of Object.entries(kinds)) {
    const target = absorbedBy[id] ?? id;
    merged[target] = merged[target] === 'first-turn' ? 'first-turn' : kind;
  }
  return merged;
}

/**
 * Candidates the report scores that no label covers (a changed catalog, such
 * as a runbook overlay, surfaces new ones): every selection of every strategy.
 */
export function unlabeledCandidates(selections: ReadonlyArray<readonly string[]>, row: { labeled: readonly string[]; applies: readonly string[] }): string[] {
  const known = new Set([...row.labeled, ...row.applies]);
  return dedupe(selections.flat()).filter((id) => !known.has(id));
}

export type LessonKind = 'first-turn' | 'event';
/**
 * Scores one kind of applicable lesson. An event-type lesson (its trigger is a
 * failure that shows up mid-task) cannot be judged from a first message, so in
 * the first-turn view it is neither expected nor counted wrong, and vice versa.
 * A lesson without a kind label counts as first-turn.
 */
export function forKind<T extends ScoredItem>(item: T, kinds: Readonly<Record<string, LessonKind>>, kind: LessonKind): T {
  const keep = (ids: readonly string[]) => ids.filter((id) => (kinds[id] ?? 'first-turn') === kind);
  return { ...item, selected: keep(item.selected), applies: keep(item.applies), labeled: keep(item.labeled) };
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
  const labelsPath = arg('labels'); const out = arg('out'); const sheet = arg('emit-sheet'); const twinsOut = arg('emit-twins');
  const twinThreshold = Number(arg('twin-threshold') ?? 0.5);
  const twinMap = resolveCanonicalMap(arg('canonical-map')
    ? (JSON.parse(readFileSync(arg('canonical-map')!, 'utf8')) as { map: Record<string, string> }).map : {});
  const overlay = arg('catalog-overlay') ? JSON.parse(readFileSync(arg('catalog-overlay')!, 'utf8')) as CatalogOverlay : undefined;
  const topK = Number(arg('topk') ?? 5); const hubShare = Number(arg('hub-share') ?? 0.15);
  if (!Number.isInteger(topK) || topK < 1 || !(hubShare > 0 && hubShare <= 1)) throw new Error('--topk must be a positive integer and --hub-share in (0, 1]');
  if (twinsOut && !(twinThreshold > 0 && twinThreshold <= 1)) throw new Error('--twin-threshold must be in (0, 1]');
  if (!store || (!twinsOut && (!since || !until || !splitAt || (!out && !sheet)))) {
    throw new Error('usage: tsx scripts/evaluate-host-lesson-matching.ts --store <events.sqlite> --since <iso> --until <iso> --split-at <iso> (--labels <labels.json> --out <report.json> | --emit-sheet <sheet.json> --sample <n> [--seed <n>])');
  }
  const { default: Database } = await import('better-sqlite3');
  const { LessonRepository } = await import('../src/core/operations/lesson-repository.js');
  const { rankCuratedLessons } = await import('../src/extensions/mcp/lesson-ranking.js');
  const { getDefaultEmbedder } = await import('../src/extensions/vector/embedder.js');

  const db = new Database(store, { readonly: true, fileMustExist: true });
  const projectHashes = (db.prepare('SELECT DISTINCT project_hash AS h FROM memory_lessons').all() as Array<{ h: string }>).map((row) => row.h);
  if (projectHashes.length !== 1) throw new Error(`expected one lesson project in the store, found ${projectHashes.length}`);
  // Every lesson, including disabled ones: a consolidated (disabled) lesson's
  // creation time and sources still decide its labels before it is mapped.
  const allLessons: MemoryLesson[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await new LessonRepository(db as never).list({ projectHash: projectHashes[0], limit: 500, offset });
    allLessons.push(...page);
    if (page.length < 500) break;
  }
  const { lessons, absorbedBy } = overlay
    ? applyCatalogOverlay(allLessons, overlay)
    : { lessons: allLessons.filter((lesson) => lesson.recallEnabled), absorbedBy: {} };
  const canonicalMap = combineMaps(twinMap, absorbedBy);
  const runbookIds = new Set(Object.values(absorbedBy));
  if (twinsOut) {
    const groups = proposeTwinGroups(lessons, twinThreshold);
    const names = Object.fromEntries(lessons.filter((lesson) => groups.some((group) => group.includes(lesson.lessonId))).map((lesson) => [lesson.lessonId, lesson.name]));
    writeFileSync(twinsOut, `${JSON.stringify({ threshold: twinThreshold, groups, names, map: twinCanonicalMap(groups) }, null, 1)}\n`);
    process.stdout.write(`twin groups: ${groups.length} covering ${Object.keys(names).length} lessons (review before use)\n`);
    if (!out && !sheet) return;
  }
  // Sessions a lesson came from: its source sessions plus the sessions of its source events.
  const sessionOfEvent = db.prepare('SELECT session_id AS s FROM events WHERE id = ?');
  const sourceSessions = new Map([...allLessons, ...lessons.filter((lesson) => runbookIds.has(lesson.lessonId))].map((lesson) => [lesson.lessonId, new Set([
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
  const labelFile = JSON.parse(readFileSync(labelsPath, 'utf8')) as { version: number; labels: Record<string, { applies: string[]; judged: string[]; kinds?: Record<string, LessonKind> }> };
  const canon = (ids: readonly string[]) => canonicalIds(ids, canonicalMap);
  // Runbooks too: a label on a runbook id passes the same time filter.
  const created = new Map([...allLessons, ...lessons].map((lesson) => [lesson.lessonId, lesson.createdAt.toISOString()]));
  const labeledPrompts = prepared.prompts.filter((prompt) => labelFile.labels[prompt.key]);
  let futureLabelPairs = 0; let recentPairs = 0;
  // `prompt` stays in memory for --emit-unlabeled; it never reaches the report.
  type Row = { prompt: PreparedPrompt; sessionId: string; applies: string[]; labeled: string[]; kinds: Record<string, LessonKind>; lexical: string[]; rankedRaw: string[]; ranked: string[] };
  const rowsBySplit: Record<'calibration' | 'heldout', Row[]> = { calibration: [], heldout: [] };
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
    // Twins must agree on a kind; a runbook spans its lessons' moments (absorbKinds).
    const kinds = absorbKinds(mergeKinds(label.kinds ?? {}, applies, twinMap), absorbedBy);
    rowsBySplit[prompt.timestamp < splitAt! ? 'calibration' : 'heldout'].push({
      prompt, sessionId: prompt.sessionId, applies: canon(applies), labeled: canon(judgedAfterOverlay(label.judged, absorbedBy)), kinds,
      lexical: canon(rankCuratedLessons(pool, prompt.text, 3).map((lesson) => lesson.lessonId)),
      // Raw ids, so per-lesson filters (own session) run before twins collapse.
      rankedRaw: ranked.slice(0, 40),
      ranked: canon(ranked).slice(0, 20)
    });
  }

  const calibrationRows = rowsBySplit.calibration;
  const hubs = new Set(findHubLessons(calibrationRows.map((row) => row.ranked.slice(0, topK)), hubShare));
  // Own-session exclusion reads a lesson's own sources, so it runs on raw ids;
  // hubs were found on canonical lists, so that check runs after mapping.
  const ownSession = (row: Row, rawId: string) => sourceSessions.get(rawId)?.has(row.sessionId) === true;
  const reductions: Record<string, { raw: (row: Row, id: string) => boolean; canonical: (id: string) => boolean }> = {
    none: { raw: () => true, canonical: () => true },
    excludeOwnSession: { raw: (row, id) => !ownSession(row, id), canonical: () => true },
    excludeHubs: { raw: () => true, canonical: (id) => !hubs.has(id) },
    both: { raw: (row, id) => !ownSession(row, id), canonical: (id) => !hubs.has(id) }
  };
  const reduce = (row: Row, keep: (typeof reductions)[string]) => canon(row.rankedRaw.filter((id) => keep.raw(row, id))).filter((id) => keep.canonical(id)).slice(0, topK);
  if (arg('emit-unlabeled')) {
    const lessonById = new Map(lessons.map((lesson) => [lesson.lessonId, lesson]));
    const items = [];
    for (const row of [...rowsBySplit.calibration, ...rowsBySplit.heldout]) {
      // Every selection the report scores: lexical, fixed top-5 (top-1/3 are its prefixes) and each reduction.
      const unjudged = unlabeledCandidates([row.lexical, row.ranked.slice(0, Math.max(5, topK)), ...Object.values(reductions).map((keep) => reduce(row, keep))], row);
      if (unjudged.length === 0) continue;
      items.push({ key: row.prompt.key, timestamp: row.prompt.timestamp, prompt: row.prompt.text.slice(0, PROMPT_KEY_CHARS),
        candidates: unjudged.map((id) => ({ lessonId: id, name: lessonById.get(id)!.name, trigger: lessonById.get(id)!.trigger })) });
    }
    writeFileSync(arg('emit-unlabeled')!, `${JSON.stringify(items, null, 1)}\n`);
    process.stdout.write(`unlabeled sheet: ${items.length} prompts, ${items.reduce((sum, item) => sum + item.candidates.length, 0)} candidates\n`);
  }
  const report: Record<string, unknown> = {
    spec: 'specs/host-lesson-matching-2026-10-18',
    window: { since, until, splitAt },
    lessons: lessons.length,
    prompts: { prepared: prepared.prompts.length, labeled: labeledPrompts.length, droppedAutomated: prepared.droppedAutomated, droppedDuplicates: prepared.droppedDuplicates, leftoverLessonBlockMarkers: prepared.leftoverMarkers },
    labels: { futureLessonPairsExcluded: futureLabelPairs, pairsWithin24hOfLessonCreation: recentPairs },
    canonicalMap: { entries: Object.keys(twinMap).length },
    catalogOverlay: { runbooks: runbookIds.size, absorbedLessons: Object.keys(absorbedBy).length },
    candidateReduction: { topK, hubShare, hubsFromCalibration: hubs.size },
    splits: {}
  };
  for (const split of ['calibration', 'heldout'] as const) {
    const rows = rowsBySplit[split];
    const score = (pick: (row: Row) => string[], kind?: LessonKind) => {
      const scored = scoreSelections(rows.map((row) => {
        const item = { selected: pick(row), applies: row.applies, labeled: row.labeled };
        return kind ? forKind(item, row.kinds, kind) : item;
      }));
      return { ...scored, promptHit: ratio(scored.promptHit), lessonPrecision: ratio(scored.lessonPrecision), lessonRecall: ratio(scored.lessonRecall), negativeInjection: ratio(scored.negativeInjection), anyWrong: ratio(scored.anyWrong) };
    };
    const reduction = Object.fromEntries(Object.entries(reductions).map(([name, keep]) => {
      const candidates = rows.map((row) => reduce(row, keep));
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
      reduction,
      ...(runbookIds.size > 0 ? { applicablePairsOnRunbooks: ratio({ k: rows.reduce((sum, row) => sum + row.applies.filter((id) => runbookIds.has(id)).length, 0), n: rows.reduce((sum, row) => sum + row.applies.length, 0) }) } : {}),
      // Present when labels mark kinds: an event-type lesson cannot be judged from a first message.
      ...(rows.some((row) => Object.keys(row.kinds).length > 0) ? {
        byKind: Object.fromEntries((['first-turn', 'event'] as const).map((kind) => [kind, {
          currentLexical: score((row) => row.lexical, kind),
          embeddingTop3: score((row) => row.ranked.slice(0, 3), kind),
          embeddingTop5: score((row) => row.ranked.slice(0, 5), kind),
        }]))
      } : {})
    };
  }
  writeFileSync(out!, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.prompts)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
