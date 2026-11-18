/**
 * #250: a force reimport deletes a session's rows (`deleteSessionEvents`) and
 * appends them again from the transcript. The re-created rows got new event
 * ids, so every reference to the old ids (helpfulness and usefulness
 * observations, retrieval traces, actions, facets, working set, ...) pointed
 * at nothing, and the promotion level went back to L0. A row that comes back
 * with the same session, type and content must come back as the same row.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

describe('SQLiteEventStore ids across a force reimport', () => {
  let tempDir: string;
  let store: SQLiteEventStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-reimport-ids-'));
    store = new SQLiteEventStore(path.join(tempDir, 'events.sqlite'));
    await store.initialize();
  });

  afterEach(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const row = (content: string, eventType: 'user_prompt' | 'agent_response' = 'user_prompt', sessionId = 'reimported', turnId = 'turn-old') => ({
    eventType,
    sessionId,
    timestamp: new Date(),
    content,
    metadata: { importedFrom: '/tmp/reimported.jsonl', turnId }
  });

  it('gives a re-created row its old id, level and access count, with the new metadata', async () => {
    const prompt = await store.append(row('please fix the release guard'));
    const answer = await store.append(row('the guard now checks the tag', 'agent_response'));
    await store.updateMemoryLevel(answer.eventId!, 'L2');
    await store.incrementAccessCount([answer.eventId!]);
    await store.incrementAccessCount([answer.eventId!]);

    await expect(store.deleteSessionEvents('reimported')).resolves.toBe(2);
    await expect(store.getEvent(answer.eventId!)).resolves.toBeNull();

    const prompt2 = await store.append(row('please fix the release guard', 'user_prompt', 'reimported', 'turn-new'));
    const answer2 = await store.append(row('the guard now checks the tag', 'agent_response', 'reimported', 'turn-new'));

    expect(prompt2).toMatchObject({ success: true, isDuplicate: false, eventId: prompt.eventId });
    expect(answer2).toMatchObject({ success: true, isDuplicate: false, eventId: answer.eventId });
    await expect(store.getEventLevel(answer.eventId!)).resolves.toBe('L2');
    await expect(store.getEventLevel(prompt.eventId!)).resolves.toBe('L0');
    const restored = await store.getEvent(answer.eventId!);
    expect(restored?.metadata).toMatchObject({ turnId: 'turn-new' });
    expect(restored).toMatchObject({ access_count: 2 });
    expect((await store.getSessionEvents('reimported')).map((event) => event.id).sort())
      .toEqual([prompt.eventId, answer.eventId].sort());
  });

  it('gives an id back only once, and only to the same session, type and content', async () => {
    const prompt = await store.append(row('please audit the vector store'));
    await store.deleteSessionEvents('reimported');

    const otherSession = await store.append(row('please audit the vector store', 'user_prompt', 'another-session'));
    const otherType = await store.append(row('please audit the vector store', 'agent_response'));
    const otherContent = await store.append(row('please audit the vector store now'));
    for (const result of [otherSession, otherType, otherContent]) {
      expect(result.success).toBe(true);
      expect(result.eventId).not.toBe(prompt.eventId);
    }

    const back = await store.append(row('please audit the vector store'));
    expect(back.eventId).toBe(prompt.eventId);

    // Deleted and appended again, the row keeps the id; a second copy is a duplicate, not a new row.
    await store.deleteSessionEvents('reimported');
    expect((await store.append(row('please audit the vector store'))).eventId).toBe(prompt.eventId);
    expect(await store.append(row('please audit the vector store'))).toMatchObject({ isDuplicate: true, eventId: prompt.eventId });
  });

  it('does not reuse an id that is already back in the store', async () => {
    const prompt = await store.append(row('please check the mongo cursor'));
    const [stored] = await store.getSessionEvents('reimported');
    await store.deleteSessionEvents('reimported');

    // Replication brings the old row back under its id, with a dedupe key
    // append() does not look up, before the reimport appends it.
    await expect(store.importEvents([{ ...stored, dedupeKey: 'replicated-opaque-key' }])).resolves.toMatchObject({ inserted: 1 });

    const reimported = await store.append(row('please check the mongo cursor'));
    expect(reimported.success).toBe(true);
    expect(reimported.eventId).not.toBe(prompt.eventId);
  });
});
