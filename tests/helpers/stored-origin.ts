import { classifyStoredEvent, type MemoryOrigin } from '../../src/core/memory-origin.js';

/**
 * An event as SQLiteEventStore would return it: with the origin the store
 * computes from its raw columns. Mocks that stand in for a store read use it;
 * an event built without it is, by design, unknown downstream.
 */
export function asStored<T extends { eventType: string; metadata?: unknown }>(event: T): T & { origin: MemoryOrigin } {
  const raw = event.metadata === undefined ? null : JSON.stringify(event.metadata);
  return { ...event, origin: classifyStoredEvent(event.eventType, raw) };
}
