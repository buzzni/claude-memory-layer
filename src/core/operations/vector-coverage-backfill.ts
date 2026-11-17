/**
 * Backfill: give every event worth searching a vector in the table semantic
 * search reads.
 *
 * Stores written by 2.5.0-2.5.3 embedded each event twice, into the searched
 * table and into `event_vectors_v1`, which nothing reads. For history imported
 * in that window only the second copy exists, so search covered a few percent
 * of the store. Those vectors are copied over when the current model produced
 * them and the event text has not changed since; anything else is queued for
 * the embedding worker.
 */

import type { MemoryEvent, VectorRecord } from '../types.js';
import { MODEL_CHECK_SAMPLE, producedByCurrentModel } from '../embedding-model-check.js';

export interface SpareVectorRow {
  eventId: string;
  content: string;
  vector: number[];
}

export interface VectorCoverageBackfillDeps {
  eventStore: {
    /** Every event the embedding worker would embed: all types except tool_observation. */
    listEmbeddableEvents(): Promise<MemoryEvent[]>;
    listPendingEmbeddingEventIds(): Promise<string[]>;
    enqueueForEmbedding(eventId: string, content: string): Promise<unknown>;
  };
  vectorStore: {
    /** Event ids in the table search reads. */
    listEventIds(): Promise<string[]>;
    /** Other tables holding event vectors, which search does not read. */
    listSpareEventTables(): Promise<string[]>;
    readRowsByEventIds(tableName: string, eventIds: string[]): Promise<SpareVectorRow[]>;
    upsertBatch(records: VectorRecord[]): Promise<void>;
  };
  embedder: { embed(text: string): Promise<{ vector: number[] }> };
}

export interface VectorCoverageBackfillResult {
  dryRun: boolean;
  embeddable: number;
  /** Events that already had a searchable vector before this run. */
  searchable: number;
  /** Copied from a spare table. */
  adopted: number;
  /** Handed to the embedding worker. */
  queued: number;
  /** Already waiting for the embedding worker. */
  alreadyQueued: number;
}

const BATCH_SIZE = 500;

export async function backfillVectorCoverage(
  deps: VectorCoverageBackfillDeps,
  options: { dryRun?: boolean } = {}
): Promise<VectorCoverageBackfillResult> {
  const dryRun = options.dryRun === true;
  const events = await deps.eventStore.listEmbeddableEvents();
  const searched = new Set(await deps.vectorStore.listEventIds());
  const missing = new Map(events.filter((event) => !searched.has(event.id)).map((event) => [event.id, event]));
  const searchable = events.length - missing.size;

  let adopted = 0;
  for (const tableName of await deps.vectorStore.listSpareEventTables()) {
    let sameModel: boolean | undefined;
    const candidateIds = [...missing.keys()];
    for (let start = 0; start < candidateIds.length && sameModel !== false; start += BATCH_SIZE) {
      const rows = uniqueByEvent(await deps.vectorStore.readRowsByEventIds(tableName, candidateIds.slice(start, start + BATCH_SIZE)))
        // A vector of text that was redacted or rewritten since must not come back.
        .filter((row) => missing.get(row.eventId)?.content === row.content);
      if (rows.length === 0) continue;

      sameModel ??= await producedByCurrentModel(deps.embedder, rows.slice(0, MODEL_CHECK_SAMPLE));
      if (!sameModel) break;

      if (!dryRun) {
        await deps.vectorStore.upsertBatch(rows.map((row) => toSearchedRecord(missing.get(row.eventId)!, row.vector)));
      }
      for (const row of rows) missing.delete(row.eventId);
      adopted += rows.length;
    }
  }

  const pending = new Set(await deps.eventStore.listPendingEmbeddingEventIds());
  let queued = 0;
  let alreadyQueued = 0;
  for (const event of missing.values()) {
    if (pending.has(event.id)) {
      alreadyQueued += 1;
      continue;
    }
    if (!dryRun) await deps.eventStore.enqueueForEmbedding(event.id, event.content);
    queued += 1;
  }

  return { dryRun, embeddable: events.length, searchable, adopted, queued, alreadyQueued };
}

function uniqueByEvent(rows: SpareVectorRow[]): SpareVectorRow[] {
  return [...new Map(rows.map((row) => [row.eventId, row])).values()];
}

/** The row the embedding worker would have written for this event. */
function toSearchedRecord(event: MemoryEvent, vector: number[]): VectorRecord {
  return {
    id: `vec_${event.id}`,
    eventId: event.id,
    sessionId: event.sessionId,
    eventType: event.eventType,
    content: event.content,
    vector,
    timestamp: event.timestamp.toISOString(),
    metadata: event.metadata
  };
}
