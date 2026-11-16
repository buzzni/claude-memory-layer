/**
 * Where a recalled memory's text came from, as far as the store can tell.
 *
 * Every class is derived from fields every row already has, so no schema
 * change or backfill is needed and old rows classify the same way new ones do.
 *
 * The one rule every caller relies on:
 *
 *   Classification starts from the stored row's own columns (`event_type`,
 *   or the lesson table for a lesson), never from a type or id copied into
 *   metadata. Metadata is written by whatever stored the row, tool output
 *   included, so it may only LOWER trust. No metadata value raises it. When
 *   the origin cannot be confirmed (no stored row to read, an unknown type,
 *   metadata that is not an object, a provenance marker of the wrong shape)
 *   the answer is `unknown`.
 *
 * The host-import rule below is not an exception: an absolute-path
 * `importedFrom` does not raise a row above its role, it is only the
 * condition under which `importedFrom` does not lower it to `imported`.
 *
 *   tool       `tool_observation`: tool input and output captured by
 *              PostToolUse or an importer. Tool output is text from outside
 *              the conversation (files, web pages, command output), the main
 *              path for memory poisoning (OWASP Agentic ASI06). An imported
 *              or pulled tool row stays `tool`.
 *   imported   a row from another machine or from an import whose source
 *              cannot be told: a `metadata.mongoSync` object (Mongo sync
 *              stamps every pulled row; pull never returns this store's own
 *              rows), or a string `metadata.importedFrom` that is not an
 *              absolute path.
 *   user       `user_prompt`: what the user typed.
 *   assistant  `agent_response`: what the agent wrote.
 *   derived    `session_summary` and lessons: text this system wrote (an LLM
 *              or rule-based summary, an extracted or curated lesson) from
 *              stored rows. It can carry tool text forward in its own words;
 *              this module does not trace a summary or lesson back to its
 *              sources.
 *   unknown    everything that cannot be confirmed. Lowest trust.
 *
 * Host session imports keep their role. The Claude, Codex and Hermes history
 * importers read this machine's own host session records from a path the
 * user configured and store that path in `metadata.importedFrom`; Codex's
 * SessionEnd hook captures every Codex session this way. Every importer
 * version has written an absolute path there, so such a row classifies by
 * its role like a live capture. Limit: a session file copied from another
 * machine and imported locally looks the same as a local one.
 *
 * Mongo sync stamped only re-homed rows (another project hash) before every
 * pull was stamped; a row pulled earlier within the same project hash
 * carries no marker and classifies by its role.
 *
 * Trust: `user`, `assistant` and `derived` are the common case and render
 * without a label; `tool`, `imported` and `unknown` render with one.
 * When the operator opts in (operations.json `sourceTrust`), `tool` and
 * `unknown` are also kept out of automatic injection; `imported` is only
 * labelled.
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

/** POSIX, Windows drive or UNC absolute path; `path.isAbsolute` would follow the reading platform. */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the provenance markers in a row's metadata say; they can only lower its class. */
function provenance(metadata: Record<string, unknown>): 'none' | 'imported' | 'unreadable' {
  let result: 'none' | 'imported' = 'none';
  if (Object.hasOwn(metadata, 'mongoSync') && metadata.mongoSync !== undefined) {
    if (!isRecord(metadata.mongoSync)) return 'unreadable';
    result = 'imported';
  }
  if (Object.hasOwn(metadata, 'importedFrom') && metadata.importedFrom !== undefined) {
    const importedFrom = metadata.importedFrom;
    if (typeof importedFrom !== 'string') return 'unreadable';
    if (!ABSOLUTE_PATH.test(importedFrom)) result = 'imported';
  }
  return result;
}

/**
 * `type` must be the stored row's own type column; `metadata` the row's
 * parsed metadata (undefined or null when the row has none).
 */
export function classifyMemoryOrigin(memory: { type: string; metadata?: unknown }): MemoryOrigin {
  const byType = Object.hasOwn(ORIGIN_BY_TYPE, memory.type) ? ORIGIN_BY_TYPE[memory.type] : 'unknown';
  if (byType === 'unknown') return 'unknown';
  if (memory.metadata === undefined || memory.metadata === null) return byType;
  if (!isRecord(memory.metadata)) return 'unknown';
  const marker = provenance(memory.metadata);
  if (marker === 'unreadable') return 'unknown';
  if (byType === 'tool') return 'tool';
  return marker === 'imported' ? 'imported' : byType;
}

export function classifyEventOrigin(event: { eventType: string; metadata?: unknown }): MemoryOrigin {
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

/** ` [low-trust: …]` to put after a type, outside the memory text; '' for a trusted class. */
export function memoryOriginLabelSuffix(origin: MemoryOrigin): string {
  const label = memoryOriginLabel(origin);
  return label ? ` [${label}]` : '';
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
