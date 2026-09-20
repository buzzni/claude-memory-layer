import type { MemoryLesson } from '../../core/types.js';
import { scoreLessonEvidence } from '../../adapters/claude/hooks/prompt-injection-policy.js';
export { isExplicitlyProhibitedLessonQuery } from '../../adapters/claude/hooks/prompt-injection-policy.js';

/**
 * specs/lesson-recall-hooks R5 · specs/lesson-learning-reliability R3 —
 * order curated lessons for a context pack.
 *
 * With a query, lessons that lexically cover it come first (same scorer as the
 * per-turn hook, so the two surfaces agree on what "relevant" means) and
 * nothing else is returned: an evidence section answering a question must not
 * pad its remaining slots with lessons the question never touched. Without a
 * query this is a plain slice — the queryless exploration index.
 */
export function rankCuratedLessons(
  lessons: readonly MemoryLesson[],
  query: string | undefined,
  limit: number
): MemoryLesson[] {
  const trimmed = query?.trim();
  if (!trimmed) return lessons.slice(0, limit);
  return lessons
    .map((lesson, index) => ({
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
    }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.lesson);
}
