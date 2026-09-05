import type { MemoryLesson } from '../../core/types.js';
import { scoreLessonEvidence } from '../../adapters/claude/hooks/prompt-injection-policy.js';

/**
 * specs/lesson-recall-hooks R5 — order curated lessons for a context pack.
 *
 * With a query, lessons that lexically cover it come first (same scorer as the
 * per-turn hook, so the two surfaces agree on what "relevant" means); the rest
 * keep repository order. Without a query, or when nothing covers it, this is
 * a plain slice — the previous behaviour, which returned the newest three
 * regardless of the question.
 */
export function rankCuratedLessons(
  lessons: readonly MemoryLesson[],
  query: string | undefined,
  limit: number
): MemoryLesson[] {
  const trimmed = query?.trim();
  if (!trimmed) return lessons.slice(0, limit);
  const scored = lessons.map((lesson, index) => ({
    lesson,
    index,
    score: scoreLessonEvidence(trimmed, {
      lessonId: lesson.lessonId,
      name: lesson.name,
      trigger: lesson.trigger,
      steps: lesson.steps,
      failureModes: lesson.failureModes,
      confidence: lesson.confidence
    })?.score ?? null
  }));
  const matched = scored
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const unmatched = scored.filter((entry) => entry.score === null);
  return [...matched, ...unmatched].slice(0, limit).map((entry) => entry.lesson);
}
