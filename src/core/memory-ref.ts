/**
 * Typed memory references (specs/recent-memory-patterns-2026-09-06 R1).
 *
 * The retrieval ledger historically stored every selected memory in
 * `retrieval_traces.selected_event_ids`, regardless of what kind of memory it
 * was. Lessons are not events, so an event-table join silently dropped them
 * (465 selections in the 2026-09-06 sample) and helpfulness/access writes keyed
 * by a lesson id updated nothing. A `MemoryRef` keeps the kind next to the id so
 * joins, access counters and evaluation populations stay type-correct.
 *
 * Nothing here copies memory content: only the kind, the id, the owning project
 * and an optional content hash travel with a reference.
 */

export const MEMORY_KINDS = ['event', 'lesson', 'rule', 'core', 'unknown'] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];

const MEMORY_KIND_SET = new Set<string>(MEMORY_KINDS);

export interface MemoryRef {
  /**
   * Project scope that owns the memory. Must match the permission boundary the
   * memory was read under; `null` means the reference is store-local/global.
   */
  projectId: string | null;
  kind: MemoryKind;
  id: string;
}

/**
 * Why a reference could not be resolved to a single kind. Kept separate from
 * `kind` so an honestly unknown reference is never reported as a data loss.
 */
export type MemoryRefResolution =
  | 'resolved'
  | 'ambiguous'
  | 'unresolved'
  | 'deleted'
  | 'forbidden';

export interface ResolvedMemoryRef extends MemoryRef {
  resolution: MemoryRefResolution;
  /** Kinds the id matched. Length > 1 means ambiguous. */
  matchedKinds: MemoryKind[];
}

export function normalizeMemoryKind(value: unknown): MemoryKind {
  return typeof value === 'string' && MEMORY_KIND_SET.has(value)
    ? value as MemoryKind
    : 'unknown';
}

/** Project segment of a scope-aware key. `-` means "store-local / global". */
const GLOBAL_SCOPE_SEGMENT = '-';

/**
 * Kind-aware, scope-free key. Only safe where the owning project is already
 * fixed by context (a single project store, a single trace's own scope).
 */
export function memoryKindKey(ref: Pick<MemoryRef, 'kind' | 'id'>): string {
  return `${normalizeMemoryKind(ref.kind)}:${ref.id}`;
}

/**
 * Stable identity for a reference: project scope, kind, then id.
 *
 * Kind is part of the key so an event and a lesson that share an id remain two
 * distinct rows. The project scope is part of it too: the same kind/id pair in
 * two different projects is two different memories under two different
 * permission boundaries, and collapsing them would merge one project's
 * telemetry into another's (specs R1).
 */
export function memoryRefKey(ref: Pick<MemoryRef, 'kind' | 'id'> & { projectId?: string | null }): string {
  return JSON.stringify([ref.projectId?.trim() || null, normalizeMemoryKind(ref.kind), ref.id]);
}

export function parseMemoryRefKey(
  key: string
): { projectId: string | null; kind: MemoryKind; id: string } | null {
  if (key.startsWith('[')) {
    try {
      const value: unknown = JSON.parse(key);
      if (Array.isArray(value) && value.length === 3
        && (value[0] === null || typeof value[0] === 'string')
        && MEMORY_KIND_SET.has(value[1]) && typeof value[2] === 'string' && value[2].length > 0) {
        return { projectId: value[0], kind: value[1] as MemoryKind, id: value[2] };
      }
    } catch { /* malformed key */ }
    return null;
  }
  // Read the pre-release pipe form, but only emit unambiguous tuple keys.
  // Scan for the first unescaped `|`: a project id may legitimately contain an
  // escaped one.
  let scope = '';
  let index = 0;
  let closed = false;
  while (index < key.length) {
    const char = key[index];
    if (char === '\\' && index + 1 < key.length) {
      scope += key[index + 1];
      index += 2;
      continue;
    }
    if (char === '|') {
      closed = true;
      index += 1;
      break;
    }
    scope += char;
    index += 1;
  }
  if (!closed) return null;
  const rest = key.slice(index);
  const separator = rest.indexOf(':');
  if (separator <= 0 || separator === rest.length - 1) return null;
  const kind = rest.slice(0, separator);
  if (!MEMORY_KIND_SET.has(kind)) return null;
  return {
    projectId: scope === GLOBAL_SCOPE_SEGMENT ? null : scope,
    kind: kind as MemoryKind,
    id: rest.slice(separator + 1)
  };
}

/**
 * Core memory blocks are delivered as `core:<blockKey>` pseudo-ids by the
 * session-start hook. Recognize that shape so the ledger records them as core
 * blocks rather than as events that will never resolve.
 */
export function inferMemoryKindFromLegacyId(id: string): MemoryKind | null {
  if (id.startsWith('core:')) return 'core';
  return null;
}

export function isEventRef(ref: Pick<MemoryRef, 'kind'>): boolean {
  return ref.kind === 'event';
}

/** Deduplicate refs by scope-aware typed key while preserving first-seen order. */
export function uniqueMemoryRefs<T extends Pick<MemoryRef, 'kind' | 'id'> & { projectId?: string | null }>(
  refs: T[]
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const ref of refs) {
    if (!ref?.id) continue;
    const key = memoryRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * Row key for tables whose legacy identity column is `event_id`
 * (`memory_helpfulness`, `memory_usefulness_observations_v2`).
 *
 * New evaluator rows use the complete scope/kind/id tuple. Their memory_id
 * retains the original id; historical v2 observations keep their legacy keys.
 */
export function usefulnessRowKey(kind: MemoryKind | undefined, id: string, projectId?: string | null): string {
  return memoryRefKey({ kind: normalizeMemoryKind(kind ?? 'event'), id, projectId });
}

/** SQL expression mirroring `usefulnessRowKey` for a table alias. */
export function usefulnessRowKeySql(alias: string, kindColumn = 'memory_kind', idColumn = 'event_id'): string {
  return `json_array(NULLIF(TRIM(${alias}.memory_project_id), ''), COALESCE(${alias}.${kindColumn}, 'event'), ${alias}.${idColumn})`;
}
