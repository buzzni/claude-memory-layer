/**
 * Where a recalled memory's text came from, as far as the store can tell.
 *
 * Every class is derived from fields every row already has, so no schema
 * change or backfill is needed and old rows classify the same way new ones do:
 *
 *   tool       eventType `tool_observation`: tool input and output captured by
 *              PostToolUse or an importer. Tool output is text from outside
 *              the conversation (files, web pages, command output), the main
 *              path for memory poisoning (OWASP Agentic ASI06). This wins
 *              over `imported`: an imported tool row is still tool text.
 *   imported   any other row with `metadata.importedFrom` (a string path):
 *              stored by a history importer (Claude, Codex or Hermes
 *              transcripts) rather than by a live hook. Its user/assistant
 *              role comes from parsing a file after the fact. Codex sessions
 *              are captured this way by design (its SessionEnd hook runs the
 *              importer), so every Codex row is `imported`. Also a row with a
 *              `metadata.mongoSync` record: pulled from another machine's
 *              store. Mongo pull writes that record only when it re-homes a
 *              row from another project hash; a row pulled within the same
 *              project hash carries no marker and classifies by its type.
 *   user       `user_prompt` from a live hook: what the user typed.
 *   assistant  `agent_response` from a live hook: what the agent wrote.
 *   derived    `session_summary` and lessons: text this system wrote (an LLM
 *              or rule-based summary, an extracted or curated lesson) from
 *              stored rows. It can carry tool text forward in its own words;
 *              this module does not trace a summary or lesson back to its
 *              sources.
 *   unknown    anything else. Lowest trust, below `tool`.
 *
 * Trust: `user`, `assistant` and `derived` are the common case and render
 * without a label; `tool`, `imported` and `unknown` render with one.
 * When the operator opts in (operations.json `sourceTrust`), `tool` and
 * `unknown` are also kept out of automatic injection. `imported` is only
 * labelled: it is the whole store of a Codex user.
 *
 * Graduation (L1+) does not change the class. A memory graduates by being
 * retrieved often, and an injected memory is retrieved again by being
 * injected, so trusting graduated rows would let a poisoned row earn trust by
 * being recalled. Lessons stay `derived` whether curated or extracted: both
 * are rewritten text that a person can list and edit, not raw captured bytes.
 */

export const MEMORY_ORIGINS = ['user', 'assistant', 'derived', 'imported', 'tool', 'unknown'] as const;
export type MemoryOrigin = typeof MEMORY_ORIGINS[number];

const MEMORY_ORIGIN_SET: ReadonlySet<string> = new Set(MEMORY_ORIGINS);

const ORIGIN_BY_TYPE: Readonly<Record<string, MemoryOrigin>> = {
  user_prompt: 'user',
  agent_response: 'assistant',
  session_summary: 'derived',
  lesson: 'derived',
  tool_observation: 'tool'
};

/** Labels for the low-trust classes; trusted classes have none. */
const LOW_TRUST_LABELS: Partial<Record<MemoryOrigin, string>> = {
  tool: 'low-trust: tool output',
  imported: 'low-trust: imported',
  unknown: 'low-trust: unknown origin'
};

/** Classes kept out of automatic injection when the operator opts in. */
const AUTO_INJECTION_EXCLUDABLE: ReadonlySet<MemoryOrigin> = new Set(['tool', 'unknown']);

export function classifyMemoryOrigin(memory: { type: string; metadata?: Record<string, unknown> }): MemoryOrigin {
  const byType = Object.hasOwn(ORIGIN_BY_TYPE, memory.type) ? ORIGIN_BY_TYPE[memory.type] : 'unknown';
  if (byType === 'tool' || byType === 'unknown') return byType;
  return isImported(memory.metadata) ? 'imported' : byType;
}

function isImported(metadata: Record<string, unknown> | undefined): boolean {
  const mongoSync = metadata?.mongoSync;
  return typeof metadata?.importedFrom === 'string'
    || (typeof mongoSync === 'object' && mongoSync !== null && !Array.isArray(mongoSync));
}

export function classifyEventOrigin(event: { eventType: string; metadata?: Record<string, unknown> }): MemoryOrigin {
  return classifyMemoryOrigin({ type: event.eventType, metadata: event.metadata });
}

/** A value read back from another process or a stored row; anything else is `null`. */
export function normalizeMemoryOrigin(value: unknown): MemoryOrigin | null {
  return typeof value === 'string' && MEMORY_ORIGIN_SET.has(value) ? value as MemoryOrigin : null;
}

/** The short inline label for a low-trust class, or `null` for a trusted one. */
export function memoryOriginLabel(origin: MemoryOrigin): string | null {
  return LOW_TRUST_LABELS[origin] ?? null;
}

export function isAutoInjectionExcludableOrigin(origin: MemoryOrigin): boolean {
  return AUTO_INJECTION_EXCLUDABLE.has(origin);
}

/** Per-class counts, omitting zero classes. Counts only: no ids, no text. */
export function countMemoryOrigins(origins: MemoryOrigin[]): Partial<Record<MemoryOrigin, number>> {
  const counts: Partial<Record<MemoryOrigin, number>> = {};
  for (const origin of origins) counts[origin] = (counts[origin] ?? 0) + 1;
  return counts;
}
