/**
 * Backfill: prune tool_observation vectors that were embedded before the
 * append()/importEvents() vector-outbox exclusion existed. The exclusion
 * only stops *new* tool_observation events from being queued for embedding;
 * this operation cleans up ones already embedded into LanceDB.
 */

export interface ToolObservationVectorPruneStore {
  listEventIdsByType(eventType: string): Promise<string[]>;
  removeVectorOutboxRowsForEventIds(eventIds: string[]): Promise<number>;
}

export interface ToolObservationVectorPruneVectorStore {
  deleteEventEverywhere(eventId: string): Promise<void>;
}

export interface ToolObservationVectorPruneOptions {
  dryRun?: boolean;
}

export interface ToolObservationVectorPruneResult {
  dryRun: boolean;
  scanned: number;
  vectorsDeleted: number;
  outboxRowsRemoved: number;
  sampleEventIds: string[];
}

const SAMPLE_LIMIT = 20;

export async function pruneToolObservationVectors(
  store: ToolObservationVectorPruneStore,
  vectorStore: ToolObservationVectorPruneVectorStore,
  options: ToolObservationVectorPruneOptions = {}
): Promise<ToolObservationVectorPruneResult> {
  const dryRun = options.dryRun === true;
  const eventIds = await store.listEventIdsByType('tool_observation');
  const sampleEventIds = eventIds.slice(0, SAMPLE_LIMIT);

  if (dryRun || eventIds.length === 0) {
    return { dryRun, scanned: eventIds.length, vectorsDeleted: 0, outboxRowsRemoved: 0, sampleEventIds };
  }

  for (const eventId of eventIds) {
    await vectorStore.deleteEventEverywhere(eventId);
  }
  const outboxRowsRemoved = await store.removeVectorOutboxRowsForEventIds(eventIds);

  return {
    dryRun,
    scanned: eventIds.length,
    vectorsDeleted: eventIds.length,
    outboxRowsRemoved,
    sampleEventIds
  };
}
