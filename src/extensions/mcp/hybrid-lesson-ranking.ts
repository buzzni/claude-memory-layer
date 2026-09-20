import type { MemoryLesson } from '../../core/types.js';
import { getDefaultEmbedder, type Embedder } from '../vector/embedder.js';
import { isExplicitlyProhibitedLessonQuery, rankCuratedLessons } from './lesson-ranking.js';

// Frozen ONLY from independent calibration-v3 (20 lessons / 100 queries).
// The deterministic grid and fixture hash are recorded in its raw result.
// Release stays disabled until the unchanged held-out gate also passes.
export const HYBRID_LESSON_GATE = { enabled: false, absoluteCosine: 0.829, top1Margin: 0.026 } as const;
export type HybridLessonStatus = 'cold' | 'warming' | 'ready' | 'calibration_rejected' | 'failed';
const vectors = new Map<string, number[]>();
let status: HybridLessonStatus = 'cold';
let warming: Promise<void> | undefined;
const pending = new Map<string, { lesson: MemoryLesson; embedder: Embedder }>();
const MAX_VECTORS = 2_048;

const text = (lesson: MemoryLesson) => [lesson.name, lesson.trigger, ...lesson.steps, ...lesson.failureModes].filter(Boolean).join('\n');
const usesE5Prefix = (embedder: Embedder) => /(?:^|\/)multilingual-e5-/i.test(embedder.getModelName());
const passage = (lesson: MemoryLesson, embedder: Embedder) => usesE5Prefix(embedder) ? `passage: ${text(lesson)}` : text(lesson);
const queryText = (query: string, embedder: Embedder) => usesE5Prefix(embedder) ? `query: ${query}` : query;
const keyFor = (lesson: MemoryLesson, embedder: Embedder) => `${embedder.getModelName()}:${usesE5Prefix(embedder) ? 'e5-prefix-v2' : 'plain-v1'}:${lesson.projectHash}:${lesson.lessonId}:${lesson.revision}`;
const cosine = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

export function hybridLessonStatus(): HybridLessonStatus { return status; }
const experimentEnabled = () => process.env.CLAUDE_MEMORY_LESSON_HYBRID_EXPERIMENT === 'true';
export function isSemanticRescueEligible(query: string): boolean {
  if (isExplicitlyProhibitedLessonQuery(query)) return false;
  // General conservative intent guard: a semantic neighbour cannot safely infer
  // that a negated, skipped, or prohibited action wants its usual runbook.
  return !/\b(?:not|without|skip|ignore|do[ -]?not|don't|never)\b|하지\s*않|하지마|말고|금지|건너뛰|무시/u.test(query);
}
export function warmHybridLessonCache(lessons: readonly MemoryLesson[], embedder?: Embedder): Promise<void> {
  if (lessons.length === 0) return Promise.resolve();
  if (!experimentEnabled()) { status = 'calibration_rejected'; return Promise.resolve(); }
  const activeEmbedder = embedder ?? getDefaultEmbedder();
  if (lessons.length > MAX_VECTORS) return Promise.resolve();
  for (const lesson of lessons) pending.set(keyFor(lesson, activeEmbedder), { lesson, embedder: activeEmbedder });
  if (warming) return warming;
  status = 'warming';
  warming = (async () => {
    while (pending.size) {
      const batch = [...pending.entries()]; pending.clear();
      for (const [key, item] of batch) { await item.embedder.initialize(); if (!vectors.has(key)) { vectors.set(key, (await item.embedder.embed(passage(item.lesson, item.embedder))).vector); while (vectors.size > MAX_VECTORS) vectors.delete(vectors.keys().next().value!); } }
    }
    status = 'ready';
  })().catch(() => { status = 'failed'; }).finally(() => { warming = undefined; });
  return warming;
}

/** Lexical matches always win. Cold processes start background warmup and return lexical-only. */
export async function rankCuratedLessonsHybrid(lessons: readonly MemoryLesson[], query: string | undefined, limit: number, embedder?: Embedder): Promise<MemoryLesson[]> {
  if (lessons.length === 0) return [];
  const lexical = rankCuratedLessons(lessons, query, limit);
  if (lexical.length || !query?.trim()) return lexical;
  if (!experimentEnabled()) { status = 'calibration_rejected'; return []; }
  if (!isSemanticRescueEligible(query)) return [];
  const activeEmbedder = embedder ?? getDefaultEmbedder();
  if (status === 'cold') { void warmHybridLessonCache(lessons, activeEmbedder); return []; }
  if (status !== 'ready') return [];
  if (lessons.some((lesson) => !vectors.has(keyFor(lesson, activeEmbedder)))) { void warmHybridLessonCache(lessons, activeEmbedder); return []; }
  const snapshot = lessons.map((lesson) => ({ lesson, vector: vectors.get(keyFor(lesson, activeEmbedder))! }));
  const queryVector = (await activeEmbedder.embed(queryText(query, activeEmbedder))).vector;
  const ranked = snapshot.map(({ lesson, vector }) => ({ lesson, score: cosine(queryVector, vector) }));
  ranked.sort((a, b) => b.score - a.score);
  const [first, second] = ranked;
  return first && first.score >= HYBRID_LESSON_GATE.absoluteCosine && first.score - (second?.score ?? 0) >= HYBRID_LESSON_GATE.top1Margin ? [first.lesson] : [];
}
