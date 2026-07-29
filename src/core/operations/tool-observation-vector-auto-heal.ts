/**
 * One-time, self-triggering cleanup for stores that were embedding
 * tool_observation vectors before the ingest-side fix landed. Users should
 * never have to know this migration exists or run a command for it — it is
 * gated on a persisted flag so it runs at most once per project store, and
 * the caller (SessionStart hook) is expected to invoke it out-of-process so a
 * large backlog cannot block or crash an interactive hook.
 */

import { pruneToolObservationVectors } from './tool-observation-vector-backfill.js';
import type {
  ToolObservationVectorPruneStore,
  ToolObservationVectorPruneVectorStore,
  ToolObservationVectorPruneResult
} from './tool-observation-vector-backfill.js';

export const TOOL_OBSERVATION_VECTOR_AUTO_HEAL_KEY = 'maintenance:tool_observation_vector_prune_v1';

export interface ToolObservationVectorAutoHealFlagStore {
  getEndlessConfig(key: string): Promise<unknown | null>;
  setEndlessConfig(key: string, value: unknown): Promise<void>;
}

export interface ToolObservationVectorAutoHealStore
  extends ToolObservationVectorPruneStore, ToolObservationVectorAutoHealFlagStore {}

export interface ToolObservationVectorAutoHealVectorStore extends ToolObservationVectorPruneVectorStore {
  optimizeAll(): Promise<void>;
}

export interface ToolObservationVectorAutoHealRecord {
  completedAt: string;
  vectorsDeleted: number;
  outboxRowsRemoved: number;
}

/** Cheap check safe to call from an interactive hook: a single indexed read. */
export async function needsToolObservationVectorAutoHeal(
  store: ToolObservationVectorAutoHealFlagStore
): Promise<boolean> {
  const flag = await store.getEndlessConfig(TOOL_OBSERVATION_VECTOR_AUTO_HEAL_KEY);
  return flag === null;
}

/**
 * Deletes already-embedded tool_observation vectors, compacts the Lance
 * tables to reclaim the versions that deletion itself creates (deletes are
 * not covered by VectorStore's write-path commit-counter pruning), and
 * stamps the flag so this never runs again for this store. Intended to run
 * out-of-process (see spawnToolObservationVectorAutoHealIfNeeded); safe to
 * call redundantly since the flag check is authoritative once set.
 */
export async function runToolObservationVectorAutoHeal(
  store: ToolObservationVectorAutoHealStore,
  vectorStore: ToolObservationVectorAutoHealVectorStore
): Promise<ToolObservationVectorPruneResult> {
  const result = await pruneToolObservationVectors(store, vectorStore, { dryRun: false });
  await vectorStore.optimizeAll();

  const record: ToolObservationVectorAutoHealRecord = {
    completedAt: new Date().toISOString(),
    vectorsDeleted: result.vectorsDeleted,
    outboxRowsRemoved: result.outboxRowsRemoved
  };
  await store.setEndlessConfig(TOOL_OBSERVATION_VECTOR_AUTO_HEAL_KEY, record);

  return result;
}
