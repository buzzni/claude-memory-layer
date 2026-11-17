/**
 * Drop the per-version event_vectors_* tables, which search does not read.
 *
 * Until repair backfill-vectors ran, such a table could hold the only vector
 * of an event, so a drop is allowed only while every event worth searching
 * has a vector in the searched table or is waiting for the embedding worker,
 * which embeds it from its stored text.
 */

export interface SpareVectorTablesDeps {
  eventStore: {
    /** Every event the embedding worker would embed: all types except tool_observation. */
    listEmbeddableEventIds(): Promise<string[]>;
    listPendingEmbeddingEventIds(): Promise<string[]>;
  };
  vectorStore: {
    listEventIds(): Promise<string[]>;
    listSpareEventTables(): Promise<string[]>;
    countTableRows(tableName: string): Promise<number>;
    dropSpareEventTable(tableName: string): Promise<void>;
  };
}

export interface SpareVectorTablesResult {
  dryRun: boolean;
  embeddable: number;
  searchable: number;
  /** Not searchable yet, but waiting for the embedding worker. */
  queued: number;
  refused: 'incomplete-coverage' | null;
  tables: Array<{ name: string; rows: number }>;
  dropped: string[];
}

export async function dropSpareEventVectorTables(
  deps: SpareVectorTablesDeps,
  options: { dryRun?: boolean } = {}
): Promise<SpareVectorTablesResult> {
  const dryRun = options.dryRun === true;
  const embeddable = await deps.eventStore.listEmbeddableEventIds();
  const searched = new Set(await deps.vectorStore.listEventIds());
  const pending = new Set(await deps.eventStore.listPendingEmbeddingEventIds());
  const notSearchable = embeddable.filter((id) => !searched.has(id));
  const queued = notSearchable.filter((id) => pending.has(id)).length;
  const tables = await Promise.all((await deps.vectorStore.listSpareEventTables())
    .map(async (name) => ({ name, rows: await deps.vectorStore.countTableRows(name) })));
  const refused = queued < notSearchable.length ? 'incomplete-coverage' as const : null;

  const dropped: string[] = [];
  if (!dryRun && !refused) {
    for (const { name } of tables) {
      await deps.vectorStore.dropSpareEventTable(name);
      dropped.push(name);
    }
  }

  return { dryRun, embeddable: embeddable.length, searchable: embeddable.length - notSearchable.length, queued, refused, tables, dropped };
}
